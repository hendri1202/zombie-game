import {
  Box3, Color, Frustum, Matrix4, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera,
  Vector3,
} from 'three';

/**
 * The normalised length every first-person weapon is scaled to, in metres.
 *
 * Owned here rather than in `Game` so the drawing code and the measurement code cannot
 * disagree about it: a test that re-declares this number proves nothing about the game.
 */
export const VIEW_MODEL_LENGTH = 0.42;

/**
 * Scales a weapon mesh to a consistent length and makes it readable.
 *
 * The scale is applied to the model itself, which is correct *here* and only here: this is
 * the single place that knows the mesh's own units. Everything downstream must treat the
 * model as finished and scale a wrapper instead — overwriting this value later with a
 * per-weapon factor in metres is the trap that once put a metre-sized gun against the
 * camera and turned the frame into one flat colour (see `WeaponConfig.viewModel.scale`).
 *
 * The dusk lighting leaves a small dark-plastic weapon nearly silhouetted against the
 * street, so its materials get a small emissive lift. This is deliberately done on the
 * view model's own materials (they come from their own FBX files and are shared with
 * nothing else) rather than by adding a light, which would also brighten the level.
 */
export function normalizeViewModel(model: Object3D): Object3D {
  const box = new Box3();
  const size = new Vector3();
  box.setFromObject(model);
  box.getSize(size);
  const longest = Math.max(size.x, size.y, size.z, 1e-4);
  model.scale.multiplyScalar(VIEW_MODEL_LENGTH / longest);
  const emissiveLift = new Color(0x2a2a30);
  model.traverse((child) => {
    child.castShadow = false;
    child.receiveShadow = false;
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standard = material as MeshStandardMaterial & { emissive?: Color };
      if (standard.emissive) {
        standard.emissive.copy(emissiveLift);
        standard.emissiveIntensity = 1;
      }
    }
  });
  return model;
}

/** What a mounted view model looks like to the camera that carries it. */
export interface ViewModelFraming {
  /** Vertices the model actually has, so a report of "nothing off frame" cannot be empty. */
  vertices: number;
  /** Vertices projecting outside the frame, or behind the near plane. Both are invisible. */
  offFrameVertices: number;
  /** Metres from the eye to the nearest and farthest vertex. */
  nearDistance: number;
  farDistance: number;
  /** True when every vertex is in front of the near plane, where a camera can draw it. */
  inFront: boolean;
  /** True when the model's bounding box meets the camera frustum. */
  intersectsFrustum: boolean;
  /** Metres from the eye to the most forward point: the barrel tip, for the muzzle flash. */
  forwardReach: number;
}

/**
 * Measures a mounted view model the way a frame would see it.
 *
 * Written because the first-person harness only ever read `viewModelVisible` — a boolean
 * that says the group is switched on, not that anything is on screen — and that is how a
 * weapon drawn too small and too far away was reported as "the model is not rendered" while
 * every number in the report stayed healthy. A scale alone is not evidence; this is the
 * geometry the scale has to produce.
 */
export function measureViewModelFraming(model: Object3D, camera: PerspectiveCamera): ViewModelFraming {
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const eye = camera.getWorldPosition(new Vector3());
  const vertex = new Vector3();
  const projected = new Vector3();
  let vertices = 0;
  let offFrameVertices = 0;
  let nearDistance = Number.POSITIVE_INFINITY;
  let farDistance = 0;
  model.updateMatrixWorld(true);
  model.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.attributes.position;
    for (let index = 0; index < position.count; index += 1) {
      vertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
      const distance = vertex.distanceTo(eye);
      nearDistance = Math.min(nearDistance, distance);
      farDistance = Math.max(farDistance, distance);
      vertices += 1;
      projected.copy(vertex).project(camera);
      if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) offFrameVertices += 1;
      // A vertex between the eye and the near plane is clipped away, and a weapon that
      // reaches the camera reads as a flat fill rather than as a gun.
      if (distance < camera.near) offFrameVertices += 1;
    }
  });
  const box = new Box3().setFromObject(model);
  // The most forward point along the view axis, not along world -Z: the eye and its view
  // direction are what the muzzle flash is placed against, and neither is guaranteed to
  // sit on an axis.
  const forward = camera.getWorldDirection(new Vector3());
  const corner = new Vector3();
  let forwardReach = 0;
  for (let index = 0; index < 8; index += 1) {
    corner.set(
      index & 1 ? box.max.x : box.min.x,
      index & 2 ? box.max.y : box.min.y,
      index & 4 ? box.max.z : box.min.z,
    ).sub(eye);
    forwardReach = Math.max(forwardReach, corner.dot(forward));
  }
  return {
    vertices,
    offFrameVertices,
    nearDistance,
    farDistance,
    inFront: Number.isFinite(nearDistance) && nearDistance > camera.near,
    intersectsFrustum: frustum.intersectsBox(box),
    forwardReach,
  };
}
