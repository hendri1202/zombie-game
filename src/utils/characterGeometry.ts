import {
  Box3, Color, LinearMipmapLinearFilter, Mesh, Object3D, SRGBColorSpace, Texture, Vector3,
} from 'three';

export interface NormalizeOptions {
  /** When set, every material is mixed towards this colour. */
  tint?: number | null;
  /** How far towards `tint` the materials are mixed, 0-1. */
  tintStrength?: number;
}

export interface SharpenOptions {
  /** Max anisotropy from the renderer, applied to every colour texture. */
  anisotropy: number;
  /** Small emissive lift so a dusk scene does not black a dark model out. */
  emissiveLift?: number;
}

/**
 * Uniformly scales a character so it is `height` metres tall, centres its
 * footprint on the origin and drops its feet to y = 0.
 *
 * Export units differ between formats and even between packs, so the target is
 * always computed from the model's own measured bounds rather than assumed.
 */
export function normalizeToHeight(model: Object3D, height: number, options: NormalizeOptions = {}): Object3D {
  const box = new Box3();
  const size = new Vector3();
  const center = new Vector3();

  box.setFromObject(model);
  box.getSize(size);
  const reference = size.y > 1e-4 ? size.y : 1;
  model.scale.multiplyScalar(height / reference);
  model.updateMatrixWorld(true);

  box.setFromObject(model);
  box.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);

  const tint = options.tint ?? null;
  if (tint !== null) {
    const tintColor = new Color(tint);
    const strength = options.tintStrength ?? 0.35;
    forEachMaterial(model, (material) => {
      if ('color' in material && material.color instanceof Color) {
        (material.color as Color).lerp(tintColor, strength);
      }
    });
  }
  return model;
}

/** Visits every mesh material on the model, cloning it first so nothing is shared. */
export function forEachMaterial(
  root: Object3D,
  visit: (material: import('three').Material) => void,
): void {
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = materials.map((material) => {
      const copy = material.clone();
      visit(copy);
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
  });
}

/**
 * Makes a character's textures as sharp as the GPU allows.
 *
 * Anisotropic filtering is what keeps a face or a jacket legible when it is seen
 * at a grazing angle instead of smearing into a blur, and the colour space has to
 * be stated explicitly: an FBX-loaded texture that stays linear renders washed
 * out and flat.
 */
export function sharpenMaterials(root: Object3D, options: SharpenOptions): number {
  let count = 0;
  forEachMaterial(root, (material) => {
    const standard = material as import('three').MeshStandardMaterial & {
      map?: Texture | null;
      emissive?: Color;
    };
    for (const key of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
      const texture = (standard as unknown as Record<string, Texture | null | undefined>)[key];
      if (!texture || !(texture as Texture).isTexture) continue;
      const value = texture as Texture;
      if (key === 'map' || key === 'emissiveMap') value.colorSpace = SRGBColorSpace;
      value.anisotropy = options.anisotropy;
      value.minFilter = LinearMipmapLinearFilter;
      value.needsUpdate = true;
      count += 1;
    }
    if (options.emissiveLift !== undefined && standard.emissive) {
      standard.emissive.setHex(options.emissiveLift);
      standard.emissiveIntensity = 1;
    }
    standard.needsUpdate = true;
  });
  return count;
}

/** True when any mesh under `root` casts a shadow, for diagnostics and tests. */
export function countShadowCasters(root: Object3D): number {
  let count = 0;
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh && mesh.castShadow) count += 1;
  });
  return count;
}

/**
 * True when a mesh is switched on inside `root`: its own `visible` flag and every ancestor's
 * between it and `root`.
 *
 * `root` itself is the frame of reference rather than part of the question — this answers "is
 * this part of the avatar switched on", which must not change because the whole avatar is
 * hidden for a first-person frame. What it does catch is a mesh inside a group that is switched
 * off: three.js inherits visibility down the tree at render time, so such a mesh draws nothing
 * while its own flag still reads `true`. Counting the flag alone is how the avatar audit came
 * to report the 37 meshes of the five code-built weapon groups — hanging hidden off the hand —
 * as drawn geometry, and why "visible meshes that cast no shadow" looked like a defect in the
 * character.
 */
export function isDrawn(mesh: Object3D, root: Object3D): boolean {
  for (let node: Object3D | null = mesh; node; node = node.parent) {
    if (node === root) return true;
    if (!node.visible) return false;
  }
  // Walked past the top without meeting the root: not part of that avatar at all.
  return false;
}

/**
 * Sets `castShadow` and `receiveShadow` on every mesh under `root`, the root included.
 *
 * three.js reads both flags off the object it is about to draw, and a Group is not a mesh, so
 * writing the flag on a group does nothing at all. The code-built melee weapons are glTF groups
 * of five to thirteen meshes each, so setting the flag on the group root left every one of them
 * out of the shadow pass: a katana in hand drew no shadow while the bundled rifle beside it did.
 */
export function setSubtreeShadows(root: Object3D, enabled: boolean): void {
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = enabled;
    mesh.receiveShadow = enabled;
  });
}
