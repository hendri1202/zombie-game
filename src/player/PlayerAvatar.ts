import { AnimationAction, AnimationClip, AnimationMixer, Group, Object3D, Vector3 } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { MODEL_FORWARD_YAW_OFFSET } from '../app/gameConfig';
import type { CharacterSpec } from '../app/characters';
import type { Disposable } from '../core/Disposable';
import { analyseClip, requiredTimeScale, type ClipMotion } from '../zombies/animationAnalysis';
import { attachGear, type GearAttachmentReport } from './proceduralGear';
import { normalizeToHeight, sharpenMaterials } from '../utils/characterGeometry';
import { resolveByCandidates } from '../utils/clipResolve';

export type AvatarState = 'idle' | 'walk' | 'run';

/** Crossfade length between locomotion clips, seconds. */
export const AVATAR_FADE_SECONDS = 0.22;
/** Below this ground speed the character is standing, m/s. */
export const AVATAR_IDLE_SPEED = 0.2;
/** Above this ground speed the character runs instead of walking, m/s. */
export const AVATAR_RUN_SPEED = 5.8;
/** In-place stride references measured from this rig's own clips (see diag-animation). */
export const AVATAR_REFERENCE_SPEED = { walk: 1.1, run: 2.4 } as const;
export const AVATAR_MIN_TIME_SCALE = 0.5;
export const AVATAR_MAX_TIME_SCALE = 1.9;

/**
 * Which way the avatar is turned, and which way the player is aiming.
 *
 * Exposed separately because they are *different* conventions: the pack's models
 * face +Z (like the zombies), while the camera looks down its local -Z. Feeding the
 * camera yaw to the model turned the character 180 degrees, so the two are reported
 * apart and asserted in the smoke test.
 */
export interface AvatarFacingReport {
  /** Angle handed to the model, atan2 of the desired facing direction. */
  facing: number;
  source: 'facingAngle' | 'none';
}

export interface AvatarClipReport {
  idle: string | null;
  walk: string | null;
  run: string | null;
  /** True when at least one locomotion state had to fall back. */
  usedFallback: boolean;
}

/** Pure: which locomotion clip a ground speed selects. */
export function avatarStateForSpeed(speed: number): AvatarState {
  if (speed < AVATAR_IDLE_SPEED) return 'idle';
  if (speed < AVATAR_RUN_SPEED) return 'walk';
  return 'run';
}

export interface PlayerAvatarDeps {
  /** A loaded survivor model and its clips, as returned by AssetManager.loadModel. */
  model: { scene: Object3D; animations: AnimationClip[] };
  spec: CharacterSpec;
  /** Renderer max anisotropy, so texture filtering is as sharp as the GPU allows. */
  anisotropy: number;
}

/**
 * The visible player character.
 *
 * Created from the same kind of FBX rig as the zombies, so it is normalised with
 * the shared helper (feet on the ground, one scale across all four survivors) and
 * its locomotion cycle is played at the rate its ground speed implies, which is
 * what stops the feet skating.
 */
export class PlayerAvatar implements Disposable {
  readonly root = new Group();
  readonly clipReport: AvatarClipReport;
  readonly height: number;
  /** Names of the bundled non-character meshes that were switched off. */
  readonly hiddenMeshes: string[];
  /** Names of the bundled meshes that were kept (the weapon in hand). */
  readonly heldMeshes: string[];
  /** Gear added in code on top of the body, and anything that could not be placed. */
  readonly gearReport: GearAttachmentReport;

  private readonly mixer: AnimationMixer;
  private readonly actions: Record<AvatarState, AnimationAction | null>;
  private readonly motions: Record<AvatarState, ClipMotion | null>;
  private currentState: AvatarState = 'idle';
  private lastFacing = 0;
  private facingSet = false;
  private readonly scratch = new Vector3();

  constructor(deps: PlayerAvatarDeps) {
    const body = cloneSkinned(deps.model.scene as Group) as Object3D;
    this.height = deps.spec.height;
    normalizeToHeight(body, deps.spec.height);
    sharpenMaterials(body, { anisotropy: deps.anisotropy });
    body.traverse((child) => {
      const mesh = child as import('three').Mesh;
      if (!mesh.isMesh) return;
      // Only what is actually drawn takes part in the shadow pass: the bundled
      // weapon meshes are switched off just below and must not cast shadows.
      const drawn = mesh.visible;
      mesh.castShadow = drawn;
      mesh.receiveShadow = drawn;
      mesh.frustumCulled = true;
    });
    /**
     * Each character file bundles the whole pack's inventory as extra non-skinned
     * meshes - Pistol, Rifle, Shotgun, Spear, SMG, Guitar, two wooden bats, an axe,
     * a knife and a shoulder pad. The glTF exporter parented the weapons to the
     * hand bone, so leaving them all on stacks ten weapons in one fist and reads as
     * a single oversized weapon clipping through the chest.
     *
     * So exactly one of them is kept, named by `spec.weaponMesh`, which puts a
     * rifle in the character's hand and lets the gun-holding clips pose it. The
     * rest are switched off.
     */
    const wanted = deps.spec.weaponMesh?.toLowerCase() ?? null;
    const hidden: string[] = [];
    const held: string[] = [];
    body.traverse((child) => {
      const mesh = child as import('three').Mesh & { isSkinnedMesh?: boolean };
      if (!mesh.isMesh || mesh.isSkinnedMesh) return;
      const name = (mesh.name || '').toLowerCase();
      if (wanted !== null && name === wanted) {
        held.push(mesh.name);
        return;
      }
      mesh.visible = false;
      hidden.push(mesh.name || '(unnamed)');
    });

    /**
     * Code-built gear (Jack's axe, bat, pack and bandolier) is parented to the
     * skeleton, so it animates with the body for free: a weapon in `Middle1.L` swings
     * wherever that hand swings, including through the pack's melee clips.
     */
    this.gearReport = deps.spec.gear
      ? attachGear(body, deps.spec.gear)
      : { attached: [], skipped: [] };

    this.root.add(body);
    this.root.visible = false;

    this.mixer = new AnimationMixer(body);
    const resolved: Record<AvatarState, { action: AnimationAction | null; motion: ClipMotion | null }> = {
      idle: { action: null, motion: null },
      walk: { action: null, motion: null },
      run: { action: null, motion: null },
    };

    let usedFallback = false;
    for (const state of ['idle', 'walk', 'run'] as AvatarState[]) {
      const groups = state === 'idle'
        ? [deps.spec.clips.idle]
        : state === 'walk'
          ? [deps.spec.clips.walk, deps.spec.clips.idle]
          : [deps.spec.clips.run, deps.spec.clips.walk, deps.spec.clips.idle];
      const resolution = resolveByCandidates(deps.model.animations, groups);
      if (!resolution.clip) continue;
      if (resolution.usedFallback) usedFallback = true;
      const action = this.mixer.clipAction(resolution.clip);
      action.setEffectiveWeight(1);
      action.enabled = true;
      resolved[state] = { action, motion: analyseClip(resolution.clip) };
    }

    this.actions = {
      idle: resolved.idle.action,
      walk: resolved.walk.action,
      run: resolved.run.action,
    };
    this.motions = {
      idle: resolved.idle.motion,
      walk: resolved.walk.motion,
      run: resolved.run.motion,
    };
    this.hiddenMeshes = hidden;
    this.heldMeshes = held;
    this.clipReport = {
      idle: resolved.idle.action?.getClip().name ?? null,
      walk: resolved.walk.action?.getClip().name ?? null,
      run: resolved.run.action?.getClip().name ?? null,
      usedFallback,
    };

    this.actions.idle?.play();
    this.currentState = 'idle';
  }

  get state(): AvatarState {
    return this.currentState;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** Facing last handed to the model, for diagnostics and the smoke assertion. */
  get facingReport(): AvatarFacingReport {
    return { facing: this.lastFacing, source: this.facingSet ? 'facingAngle' : 'none' };
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Snaps the avatar to a position/facing without playing a step, for the menu showcase. */
  place(position: { x: number; y?: number; z: number }, yaw: number): void {
    this.root.position.set(position.x, position.y ?? 0, position.z);
    this.root.rotation.y = yaw + MODEL_FORWARD_YAW_OFFSET;
  }

  update(delta: number, position: { x: number; z: number }, facing: number, groundSpeed: number): void {
    this.root.position.set(position.x, 0, position.z);
    this.root.rotation.y = facing + MODEL_FORWARD_YAW_OFFSET;
    this.lastFacing = facing;
    this.facingSet = true;

    const next = avatarStateForSpeed(groundSpeed);
    if (next !== this.currentState) {
      this.transition(next);
    }

    const action = this.actions[this.currentState];
    const motion = this.motions[this.currentState];
    if (action && motion && this.currentState !== 'idle') {
      const reference = this.currentState === 'run' ? AVATAR_REFERENCE_SPEED.run : AVATAR_REFERENCE_SPEED.walk;
      const scale = requiredTimeScale(motion, groundSpeed, reference);
      action.setEffectiveTimeScale(
        Math.min(AVATAR_MAX_TIME_SCALE, Math.max(AVATAR_MIN_TIME_SCALE, scale)),
      );
    }

    // Mixers are advanced with a clamped delta so a tab that was hidden for a
    // minute does not fast-forward the character through its whole cycle.
    this.mixer.update(Math.min(delta, 0.1));
  }

  private transition(next: AvatarState): void {
    const from = this.actions[this.currentState];
    const to = this.actions[next];
    if (to) {
      to.reset();
      to.setEffectiveWeight(1);
      to.enabled = true;
      to.play();
      if (from && from !== to) from.crossFadeTo(to, AVATAR_FADE_SECONDS, false);
    } else if (from) {
      from.fadeOut(AVATAR_FADE_SECONDS);
    }
    this.currentState = next;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() ?? this.root);
    this.root.removeFromParent();
    this.root.clear();
    this.scratch.set(0, 0, 0);
  }
}
