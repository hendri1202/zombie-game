import { Box3, Group, Mesh, Object3D, Vector3 } from 'three';
import type { AssetManager } from '../core/AssetManager';

export interface PropSpec {
  /** Key used by the level layout. */
  name: string;
  path: string;
  /**
   * Normalisation target. The loaded model is uniformly scaled so its bounding
   * box matches the axis given here, which makes placement independent of the
   * unit scale the asset was exported with.
   */
  fit: 'height' | 'width' | 'depth';
  targetSize: number;
  solid: boolean;
  /** Actor-shadow friendly: large props receive shadows, small debris does not. */
  castShadow?: boolean;
}

export interface PropTemplate {
  spec: PropSpec;
  /** Ready-to-place clone source: scaled, centred on X/Z, resting on y = 0. */
  root: Object3D;
  /** Footprint after normalisation, in metres. */
  size: { width: number; height: number; depth: number };
}

const box = new Box3();
const size = new Vector3();
const center = new Vector3();

/**
 * Loads external props once and hands out placements.
 *
 * Each template is normalised (scaled to a target size, centred, dropped onto
 * the ground plane) so level code can say "a 2.6 m container here" without
 * knowing anything about the exporter's units.
 */
export class PropLibrary {
  private readonly templates = new Map<string, PropTemplate>();
  private readonly assets: AssetManager;

  constructor(assets: AssetManager) {
    this.assets = assets;
  }

  async load(specs: readonly PropSpec[]): Promise<{ loaded: number; failed: string[] }> {
    const failed: string[] = [];
    let loaded = 0;
    for (const spec of specs) {
      try {
        const model = await this.assets.loadModel(spec.path);
        const root = normalizeModel(model.scene, spec);
        box.setFromObject(root);
        box.getSize(size);
        this.templates.set(spec.name, {
          spec,
          root,
          size: { width: size.x, height: size.y, depth: size.z },
        });
        loaded += 1;
      } catch (error) {
        console.error('[props] failed to load', spec.name, spec.path, error);
        failed.push(spec.name);
      }
    }
    return { loaded, failed };
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  get(name: string): PropTemplate | null {
    return this.templates.get(name) ?? null;
  }

  /** A detached copy that shares geometry and materials with the template. */
  create(name: string): Object3D | null {
    const template = this.templates.get(name);
    if (!template) return null;
    const clone = template.root.clone(true);
    clone.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = template.spec.castShadow ?? true;
        child.receiveShadow = true;
      }
    });
    return clone;
  }

  dispose(): void {
    for (const template of this.templates.values()) {
      template.root.traverse((child) => {
        if (child instanceof Mesh) {
          child.geometry.dispose();
          const material = child.material;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material.dispose();
        }
      });
    }
    this.templates.clear();
  }
}

/**
 * Wraps the loaded hierarchy so that:
 *  - it is uniformly scaled until the requested axis matches `targetSize`,
 *  - its footprint is centred on the local origin,
 *  - its lowest point sits at y = 0.
 */
function normalizeModel(model: Group, spec: PropSpec): Object3D {
  box.setFromObject(model);
  box.getSize(size);
  const reference = spec.fit === 'height' ? size.y : spec.fit === 'width' ? size.x : size.z;
  const scale = reference > 1e-6 ? spec.targetSize / reference : 1;

  model.scale.multiplyScalar(scale);
  model.updateMatrixWorld(true);

  box.setFromObject(model);
  box.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);

  const wrapper = new Group();
  wrapper.name = `prop:${spec.name}`;
  wrapper.add(model);
  return wrapper;
}
