import {
  AnimationClip, Box3, CapsuleGeometry, Color, Group, Mesh, MeshBasicMaterial, Object3D, SphereGeometry, Vector3,
} from 'three';
import { ANIMATION_CLIP_NAMES, ZOMBIE_TYPES, type AnimationState, type ZombieKind, type ZombieStats } from '../app/gameConfig';
import type { AssetManager } from '../core/AssetManager';
import { ZombieAnimator, resolveClipMap } from './ZombieAnimator';
import {
  analyseClip, clipCompatibility, collectBoneNames, missingBindings, type ClipMotion,
} from './animationAnalysis';
import { resolveClip } from './ZombieAnimator';
import { Zombie } from './Zombie';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export interface ZombieModelTemplate {
  kind: ZombieKind;
  stats: ZombieStats;
  /** Normalised clone source: correct scale, feet on y = 0, centred on X/Z. */
  root: Object3D;
  animations: AnimationClip[];
  /** Measured size of the normalised model, used to size the hitboxes. */
  size: { width: number; height: number; depth: number };
  clipNames: string[];
  /** Which clip each animation state is bound to, for diagnostics. */
  clipMapping: Record<string, string | null>;
  /** Per-clip motion measurements (root travel, cadence, duration). */
  clipMotion: ClipMotion[];
  /** Lower-cased bone names, the binding target set for borrowed clips. */
  bones: Set<string>;
  /** Gaps filled by a clip borrowed from another model. */
  borrowed: BorrowedClip[];
}

export interface BorrowedClip {
  state: string;
  fromKind: ZombieKind;
  clipName: string;
  /** Fraction of the borrowed clip's tracks that bind to this model (1 = all). */
  compatibility: number;
}

/**
 * Hitboxes are meshes on layer 1: the renderer draws layer 0 only, while the
 * combat raycaster enables layer 1. That keeps hit detection geometry out of
 * the draw call budget without hiding it from raycasts (three's Raycaster
 * filters by layers, not by `visible`).
 */
export const HITBOX_LAYER = 1;

export interface ZombieFactoryDeps {
  assets: AssetManager;
}

/**
 * Loads the character models once, normalises them, and stamps out entities.
 *
 * Skinned meshes are duplicated with SkeletonUtils.clone so each zombie owns its
 * own skeleton; frames are shared through AnimationClip instances, which is what
 * makes an animated crowd affordable without instancing skinned characters.
 */
export class ZombieFactory {
  private readonly templates = new Map<ZombieKind, ZombieModelTemplate>();
  private readonly assets: AssetManager;
  private nextId = 1;
  private readonly hitboxGeometry: { head: SphereGeometry; body: CapsuleGeometry };
  private readonly hitboxMaterial: MeshBasicMaterial;

  constructor(deps: ZombieFactoryDeps) {
    this.assets = deps.assets;
    this.hitboxGeometry = {
      head: new SphereGeometry(1, 8, 6),
      body: new CapsuleGeometry(1, 1, 3, 8),
    };
    this.hitboxMaterial = new MeshBasicMaterial({ color: 0xff4444, wireframe: false });
  }

  async load(kinds: readonly ZombieKind[]): Promise<{ loaded: ZombieKind[]; failed: ZombieKind[] }> {
    const loaded: ZombieKind[] = [];
    const failed: ZombieKind[] = [];
    for (const kind of kinds) {
      const stats = ZOMBIE_TYPES[kind];
      try {
        const model = await this.assets.loadModel(stats.modelPath);
        const root = normalizeCharacter(model.scene, stats);
        const bounds = new Box3().setFromObject(root);
        const size = new Vector3();
        bounds.getSize(size);
        this.templates.set(kind, {
          kind,
          stats,
          root,
          animations: model.animations,
          size: { width: size.x, height: size.y, depth: size.z },
          clipNames: model.animations.map((clip) => clip.name),
          clipMapping: resolveClipMap(model.animations),
          clipMotion: model.animations.map((clip) => analyseClip(clip)),
          bones: collectBoneNames(root),
          borrowed: [],
        });
        loaded.push(kind);
      } catch (error) {
        console.error('[factory] character failed to load', kind, error);
        failed.push(kind);
      }
    }

    this.shareMissingClips();
    return { loaded, failed };
  }

  /**
   * Fills animation gaps by borrowing an equivalent clip from a sibling model.
   *
   * The pack's characters share one rig family ("CharacterArmature"), so a clip
   * written for one model binds to another by track name with no retargeting.
   * That is measured per clip rather than assumed: a donor is only accepted when
   * every one of its tracks has a bone in the target skeleton, because a partial
   * bind silently leaves limbs unanimated while the rest of the body moves.
   *
   * Concretely this is what gives the Runner a real attack: its own model ships
   * no attack clip, so without this it swung its walk cycle.
   */
  private shareMissingClips(): void {
    const states = Object.keys(ANIMATION_CLIP_NAMES) as AnimationState[];

    for (const [kind, template] of this.templates) {
      for (const state of states) {
        const own = resolveClip(template.animations, state);
        // A dedicated clip exists when the request was satisfied directly; a
        // clip reached through the fallback chain is a substitute, not a match.
        if (!own.usedFallback) continue;

        for (const [donorKind, donor] of this.templates) {
          if (donorKind === kind) continue;
          const donorClip = resolveClip(donor.animations, state);
          if (!donorClip.clip || donorClip.usedFallback) continue;

          const compatibility = clipCompatibility(donorClip.clip, template.bones);
          if (compatibility < 0.999) {
            const missing = missingBindings(donorClip.clip, template.bones);
            console.warn(
              `[anim] ${kind}: refusing to borrow "${donorClip.clip.name}" from ${donorKind} `
              + `for state "${state}" — only ${(compatibility * 100).toFixed(1)}% of its tracks bind; `
              + `bones this skeleton lacks: ${missing.slice(0, 20).join(', ')}`
              + `${missing.length > 20 ? ` (+${missing.length - 20} more)` : ''}`,
            );
            continue;
          }

          template.animations.push(donorClip.clip);
          template.borrowed.push({
            state,
            fromKind: donorKind,
            clipName: donorClip.clip.name,
            compatibility,
          });
          console.info(
            `[anim] ${kind}: borrowed "${donorClip.clip.name}" from ${donorKind} for state "${state}" `
            + `(all ${donorClip.clip.tracks.length} tracks bind)`,
          );
          break;
        }
      }
    }
  }

  has(kind: ZombieKind): boolean {
    return this.templates.has(kind);
  }

  get clipInventory(): Array<{
    kind: ZombieKind;
    clips: string[];
    mapping: Record<string, string | null>;
    motion: ClipMotion[];
    borrowed: BorrowedClip[];
  }> {
    return [...this.templates.values()].map((template) => ({
      kind: template.kind,
      // The mapping is recomputed after sharing so it reports the clips the
      // animator will actually bind, not the ones the model shipped with.
      clips: template.clipNames,
      mapping: resolveClipMap(template.animations),
      motion: template.animations.map((clip) => analyseClip(clip)),
      borrowed: template.borrowed,
    }));
  }

  getTemplate(kind: ZombieKind): ZombieModelTemplate | null {
    return this.templates.get(kind) ?? null;
  }

  /** Builds one entity. Returns null when its model is not available. */
  create(kind: ZombieKind): Zombie | null {
    const template = this.templates.get(kind);
    if (!template) return null;

    const root = new Group();
    root.name = `zombie-${kind}`;
    const body = cloneSkinned(template.root) as Object3D;
    body.name = `${kind}-body`;
    root.add(body);

    const hitboxes = this.createHitboxes(template);
    for (const hitbox of hitboxes) root.add(hitbox);

    const animator = new ZombieAnimator(body, template.animations, template.stats);
    const zombie = new Zombie(this.nextId, kind, template.stats, root, animator);
    this.nextId += 1;
    for (const hitbox of hitboxes) zombie.hitboxes.push(hitbox);
    return zombie;
  }

  /**
   * Hitboxes share one unit geometry per shape and are sized with `scale`, so
   * spawning a zombie allocates no geometry at all.
   */
  private createHitboxes(template: ZombieModelTemplate): Object3D[] {
    const { height } = template.size;
    const { radius } = template.stats;

    // CapsuleGeometry(1, 1) is a 1 m radius capsule with a 1 m straight section;
    // its total height is 3 m, hence the /3 scaling for the body.
    const bodyHeight = Math.max(0.6, height * 0.74);
    const bodyRadius = Math.max(0.22, Math.min(radius, template.size.width * 0.75));
    const body = new Mesh(this.hitboxGeometry.body, this.hitboxMaterial);
    body.scale.set(bodyRadius, bodyHeight / 3, bodyRadius);
    body.position.y = bodyHeight / 2;
    body.name = 'hitbox-body';
    body.visible = false;
    body.layers.set(HITBOX_LAYER);
    body.userData.hitZone = 'body';

    const headRadius = Math.max(0.15, height * 0.105);
    const head = new Mesh(this.hitboxGeometry.head, this.hitboxMaterial);
    head.scale.setScalar(headRadius);
    head.position.y = Math.max(bodyHeight + headRadius * 0.4, height - headRadius);
    head.name = 'hitbox-head';
    head.visible = false;
    head.layers.set(HITBOX_LAYER);
    head.userData.hitZone = 'head';

    return [body, head];
  }

  /** Debug helper: shows or hides all hitbox geometry. */
  static setHitboxVisible(zombie: Zombie, visible: boolean): void {
    for (const hitbox of zombie.hitboxes) hitbox.visible = visible;
  }

  dispose(): void {
    this.hitboxGeometry.head.dispose();
    this.hitboxGeometry.body.dispose();
    this.hitboxMaterial.dispose();
    this.templates.clear();
  }
}

/**
 * Uniformly scales the character so it is `stats.height` tall, centres its
 * footprint on the origin and drops its feet to y = 0. Export units differ
 * between formats, so the target is always computed from the measured bounds.
 */
function normalizeCharacter(model: Group, stats: ZombieStats): Object3D {
  const box = new Box3();
  const size = new Vector3();
  const center = new Vector3();

  box.setFromObject(model);
  box.getSize(size);
  const reference = size.y > 1e-4 ? size.y : 1;
  const targetHeight = stats.height / stats.scaleMultiplier;
  const scale = (targetHeight / reference) * stats.scaleMultiplier;
  model.scale.multiplyScalar(scale);
  model.updateMatrixWorld(true);

  box.setFromObject(model);
  box.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);

  if (stats.tint !== null) {
    const tint = stats.tint;
    model.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const tintColor = new Color(tint);
      const cloned = materials.map((material) => {
        const copy = material.clone();
        if ('color' in copy && copy.color instanceof Color) {
          copy.color.lerp(tintColor, 0.35);
        }
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
    });
  }

  return model;
}
