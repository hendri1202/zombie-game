import {
  AnimationAction, AnimationClip, AnimationMixer, Group, LoopOnce, Object3D, Quaternion, Vector3,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { MODEL_FORWARD_YAW_OFFSET } from '../app/gameConfig';
import { MELEE_BUNDLE_MESH, type MeleeClip, type MeleeId } from '../app/meleeConfig';
import type { CharacterSpec } from '../app/characters';
import type { Disposable } from '../core/Disposable';
import { analyseClip, requiredTimeScale, type ClipMotion } from '../zombies/animationAnalysis';
import { attachGear, alignToForearm, findBone, placeInHand, slungGearWeapon, FOREARM_BONES, HAND_BONES, type GearAttachmentReport, type GearWeapon } from './proceduralGear';
import { normalizeToHeight, sharpenMaterials } from '../utils/characterGeometry';
import { resolveByCandidates } from '../utils/clipResolve';
import type { JumpPhase } from './jumpPhysics';

export type AvatarState = 'idle' | 'walk' | 'run';

/** Crossfade length between locomotion clips, seconds. */
export const AVATAR_FADE_SECONDS = 0.22;
/**
 * Crossfade into and out of a melee swing.
 *
 * Much shorter than the locomotion fade: the swing has to start moving the frame the
 * button goes down, and a quarter-second blend made the whole attack read as slow.
 */
export const AVATAR_ATTACK_FADE = 0.08;
/**
 * Crossfade into and out of an air pose.
 *
 * Between the two above: a jump is a body state, not a whip-fast attack, so it earns a little
 * more blend than a swing — but it still has to land inside a 0.6 s arc, so it cannot take the
 * locomotion fade's quarter second.
 */
export const AVATAR_JUMP_FADE = 0.12;
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

/**
 * Which clip family holds each air pose, most specific first.
 *
 * The rig that ships with this project has all three of `Jump`, `Jump_Idle` and `Jump_Land`,
 * but the groups are ordered fallbacks rather than a single name so a rig with only some of
 * them still gets an airborne pose instead of a frozen walk cycle. `resolveByCandidates`
 * matches exact short names before prefixes, so a plain `Jump` request does not pick up
 * `Jump_Idle`.
 */
const JUMP_CLIP_CANDIDATES: Record<JumpPhase, readonly (readonly string[])[]> = {
  rise: [['Jump'], ['Jump_Idle'], ['Jump_Land']],
  hang: [['Jump_Idle'], ['Jump'], ['Jump_Land']],
  land: [['Jump_Land'], ['Jump_Idle'], ['Jump']],
};

export interface PlayerAvatarDeps {
  /** A loaded survivor model and its clips, as returned by AssetManager.loadModel. */
  model: { scene: Object3D; animations: AnimationClip[] };
  spec: CharacterSpec;
  /** Renderer max anisotropy, so texture filtering is as sharp as the GPU allows. */
  anisotropy: number;
  /**
   * Meshes for the melee weapons the survivor bundle does not ship, keyed by weapon id.
   *
   * The five code-built melee weapons (`CODE_BUILT_MELEE`) have no mesh to switch on inside
   * the character file, so third person would show an empty fist. Each entry is the weapon's
   * own exported glTF scene, and `PlayerAvatar` pastes it onto the hand bone at construction
   * (see attachHandMeshes). Absent for a caller that has not loaded them, in which case those
   * five simply show nothing in third person, exactly as before.
   */
  meleeHandMeshes?: Partial<Record<MeleeId, Object3D>>;
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
  /** The bundled weapon mesh left visible in the hand, if any. */
  private heldWeaponMesh: import('three').Mesh | null = null;
  /**
   * Bundled melee meshes the character file ships, by weapon id.
   *
   * The pack parents every weapon it models to the hand bone, at the right size and grip,
   * so the third-person melee mesh is one of these switched on rather than a mesh loaded,
   * scaled and rotated into place by hand (see setMeleeWeapon).
   */
  private readonly meleeMeshes = new Map<MeleeId, import('three').Mesh>();
  /**
   * Code-built melee meshes pasted onto the hand bone, by weapon id.
   *
   * The five weapons the bundle does not ship (`CODE_BUILT_MELEE`): their exported glTF is
   * attached at construction so third person can show them, and switched on with the weapon
   * exactly like the bundled meshes above.
   */
  private readonly handMeshes = new Map<MeleeId, Object3D>();
  /** The hand bone the code-built meshes were hung from, or null when none was found. */
  private handMeshBone: Object3D | null = null;
  /** Code-built meshes that could not be attached, with the reason. */
  private readonly handMeshSkipped: string[] = [];
  /** Slung tools from the character's gear, by kind; empty for a character with none. */
  private slungGear: Partial<Record<GearWeapon, Object3D>> = {};
  /** Melee weapon currently shown on the character, or null for the firearm. */
  private meleeWeapon: MeleeId | null = null;

  private readonly mixer: AnimationMixer;
  /** The loaded clips, kept for the melee swings resolved lazily on first use. */
  private readonly clips: AnimationClip[];
  private readonly actions: Record<AvatarState, AnimationAction | null>;
  private readonly motions: Record<AvatarState, ClipMotion | null>;
  /**
   * One-shot swing actions, resolved on first use.
   *
   * `null` is cached too: a rig without the clip must not re-run the search on every
   * swing of a fight.
   */
  private readonly attackActions = new Map<MeleeClip, AnimationAction | null>();
  /** The swing currently playing, if any. */
  private attackAction: AnimationAction | null = null;
  /** Seconds left of it. */
  private attackRemaining = 0;
  /**
   * One-shot air poses, resolved on first use; `null` is cached for a rig that has none.
   *
   * Same caching rule as the swings: a rig without jump clips must not re-run the search
   * every frame of a jump.
   */
  private readonly jumpActions = new Map<JumpPhase, AnimationAction | null>();
  /** The air pose currently playing, if any. */
  private jumpAction: AnimationAction | null = null;
  private jumpPhase: JumpPhase | null = null;
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
    // Reverse lookup: which melee weapon a bundled mesh name in this file stands for.
    const meleeByMeshName = new Map<string, MeleeId>();
    for (const meleeId of Object.keys(MELEE_BUNDLE_MESH) as MeleeId[]) {
      meleeByMeshName.set(MELEE_BUNDLE_MESH[meleeId], meleeId);
    }
    // Where the file hangs its own weapons. The code-built melee meshes are pasted onto the
    // same bone so both sets land at one grip (see attachHandMeshes).
    let bundleMeleeBone: Object3D | null = null;
    body.traverse((child) => {
      const mesh = child as import('three').Mesh & { isSkinnedMesh?: boolean };
      if (!mesh.isMesh || mesh.isSkinnedMesh) return;
      const name = (mesh.name || '').toLowerCase();
      const meleeId = meleeByMeshName.get(name);
      if (meleeId) {
        // A melee weapon the file ships in hand space: kept for setMeleeWeapon to switch on
        // when that weapon is drawn, hidden until then. Recorded in `hidden` because that
        // is what it is at boot, and `meleeMeshes` is what reveals it later.
        mesh.visible = false;
        mesh.castShadow = false;
        this.meleeMeshes.set(meleeId, mesh);
        bundleMeleeBone ??= mesh.parent ?? null;
        hidden.push(mesh.name || '(unnamed)');
        return;
      }
      if (wanted !== null && name === wanted) {
        held.push(mesh.name);
        this.heldWeaponMesh = mesh;
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
      : { attached: [], skipped: [], slung: {} };
    // Slung tools (Jack's axe and bat on his pack) are held here so a drawn melee weapon
    // can hide the one it duplicates.
    this.slungGear = this.gearReport.slung;
    // The five melee weapons with no mesh in the bundle get their own glTF pasted onto the
    // hand bone here, or third person would swing an empty fist for them.
    this.attachHandMeshes(body, deps.meleeHandMeshes ?? {}, bundleMeleeBone);

    this.root.add(body);
    this.root.visible = false;

    this.mixer = new AnimationMixer(body);
    this.clips = deps.model.animations;
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

  /**
   * Pastes the code-built melee meshes onto the hand bone, hidden until their weapon is drawn.
   *
   * The four melee weapons the survivor files ship are switched on where they already hang
   * (see the constructor), but the five built in code have no bundled mesh, which left a
   * drawn katana swinging an empty fist. Their exported glTF is attached here the same way
   * the code-built gear is: `placeInHand` reuses the pack's own grip transform, and
   * `alignToForearm` turns the weapon to hang down the forearm with the arms down — the same
   * correction `attachGear` applies to Jack's axe and bat, and needed for the same reason,
   * because these meshes follow the same "+Z runs to the biting end" convention.
   *
   * `bundleBone` is the bone the file hangs its own weapons from, so a code-built katana
   * lands at the same grip as a bundled spear. A rig that has no such bone falls back to the
   * generic hand bones, and a rig with neither is reported rather than thrown: the character
   * comes out with no hand mesh in third person, which is a gap worth seeing, not a crash.
   */
  private attachHandMeshes(
    body: Object3D,
    meshes: Partial<Record<MeleeId, Object3D>>,
    bundleBone: Object3D | null,
  ): void {
    const entries = Object.entries(meshes) as Array<[MeleeId, Object3D]>;
    if (entries.length === 0) return;

    const hand = bundleBone
      ?? findBone(body, HAND_BONES.left)
      ?? findBone(body, HAND_BONES.right);
    if (!hand) {
      for (const [id] of entries) this.handMeshSkipped.push(`${id}: hand bone not found`);
      return;
    }
    this.handMeshBone = hand;
    // The rig mirrors left to right by negating Y and Z, so a weapon built for the left hand
    // lands behind the right one without this (see placeInHand).
    const mirrored = HAND_BONES.right.some((name) => name === hand.name);
    const forearm = findBone(body, mirrored ? FOREARM_BONES.right : FOREARM_BONES.left);

    // The alignment reads world positions off the bind pose, so it has to be resolved first.
    body.updateMatrixWorld(true);
    for (const [id, mesh] of entries) {
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // A mesh carried over from an earlier avatar is still parented to that avatar's hand
      // bone; add() detaches it from there, so one loaded copy serves every avatar.
      placeInHand(hand, mesh, mirrored);
      // A rig without the forearm bone still gets the weapon, held with the pack's own grip
      // rotation: degraded, not skipped.
      alignToForearm(hand, mesh, forearm);
      this.handMeshes.set(id, mesh);
    }
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

  /**
   * World position of the muzzle of the weapon actually in the character's hands.
   *
   * The pack models its weapons along local +Z, so the muzzle sits that way from the
   * mesh origin. Third person fires from here; first person fires from the view model,
   * which is a different object entirely.
   *
   * Returns null on a character that carries no bundled weapon (Jack's axe and bat are
   * code-built gear, not this mesh).
   */
  heldWeaponMuzzle(out: Vector3): Vector3 | null {
    if (!this.heldWeaponMesh) return null;
    this.heldWeaponMesh.getWorldPosition(out);
    const forward = this.heldWeaponMesh.getWorldQuaternion(new Quaternion());
    return out.add(new Vector3(0, 0, 0.45).applyQuaternion(forward));
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /**
   * Shows the drawn melee weapon on the character, or puts it away again.
   *
   * Third person draws the character, not the view model, so a melee weapon in hand has to
   * be a mesh on the body. Each survivor file already ships the pack's melee meshes
   * parented to the hand bone at the right size and grip, so nothing is loaded here: the
   * mesh matching the weapon is switched on and the bundled firearm mesh switched off.
   * `null` restores the firearm.
   *
   * The slung twin of the drawn weapon is hidden for as long as it is in hand — Jack
   * carries an axe and a bat on his pack, and a drawn axe with the slung axe still on his
   * back is the same tool in two places at once. Every other slung tool stays put, and
   * holstering brings the twin back.
   *
   * Idempotent and cheap: it sets the flags from the requested state on every call, so the
   * frame loop can call it with the current weapon and a call that changes nothing does
   * nothing.
   */
  setMeleeWeapon(id: MeleeId | null): void {
    this.meleeWeapon = id;
    // The firearm mesh leaves the hand while a melee weapon is drawn: the pack draws every
    // weapon at the same grip, so leaving the rifle on would put two weapons in one fist.
    if (this.heldWeaponMesh) this.heldWeaponMesh.visible = id === null;
    for (const [meshId, mesh] of this.meleeMeshes) {
      const shown = meshId === id;
      mesh.visible = shown;
      // A mesh that is off must not cast the shadow of a weapon nobody is holding.
      mesh.castShadow = shown;
      mesh.receiveShadow = shown;
    }
    // The code-built meshes are switched on exactly like the bundled ones. Only ever one of
    // the two sets matches `id` — a bundled id has no hand mesh and a code-built id has no
    // bundled mesh (see CODE_BUILT_MELEE) — so no weapon is ever drawn twice.
    for (const [meshId, mesh] of this.handMeshes) {
      const shown = meshId === id;
      mesh.visible = shown;
      mesh.castShadow = shown;
      mesh.receiveShadow = shown;
    }
    const hiddenSlung = id === null ? null : slungGearWeapon(id);
    for (const kind of Object.keys(this.slungGear) as GearWeapon[]) {
      const group = this.slungGear[kind];
      if (group) group.visible = kind !== hiddenSlung;
    }
  }

  /**
   * What the melee mesh state is, for the diagnostics hook: the weapon shown, the bundled
   * melee meshes the rig actually ships, the code-built meshes pasted onto the hand (and the
   * bone they hang from), and the tools slung on the pack.
   */
  get meleeWeaponReport(): {
    inHand: MeleeId | null;
    bundleMeshes: MeleeId[];
    handMeshes: MeleeId[];
    handBone: string | null;
    handMeshSkipped: string[];
    slung: GearWeapon[];
  } {
    return {
      inHand: this.meleeWeapon,
      bundleMeshes: [...this.meleeMeshes.keys()],
      handMeshes: [...this.handMeshes.keys()],
      handBone: this.handMeshBone?.name ?? null,
      handMeshSkipped: [...this.handMeshSkipped],
      slung: (Object.keys(this.slungGear) as GearWeapon[]).filter((kind) => this.slungGear[kind] !== undefined),
    };
  }

  /** Snaps the avatar to a position/facing without playing a step, for the menu showcase. */
  place(position: { x: number; y?: number; z: number }, yaw: number): void {
    this.root.position.set(position.x, position.y ?? 0, position.z);
    this.root.rotation.y = yaw + MODEL_FORWARD_YAW_OFFSET;
  }

  update(delta: number, position: { x: number; y?: number; z: number }, facing: number, groundSpeed: number): void {
    // `y` is the jump height: omitting it (the menu showcase) stands the character on the road.
    this.root.position.set(position.x, position.y ?? 0, position.z);
    this.root.rotation.y = facing + MODEL_FORWARD_YAW_OFFSET;
    this.lastFacing = facing;
    this.facingSet = true;

    const next = avatarStateForSpeed(groundSpeed);
    // A swing owns the pose for its short duration. Transitioning mid-swing would
    // crossfade the walk cycle into the middle of the attack, which reads as the swing
    // being interrupted by a step.
    //
    // An air pose owns it for the same reason: swapping the walk cycle underneath a jump
    // would put a stride in the middle of the arc, and the cycle is restored on landing
    // (see endJump) with `transition` free to run again on the next frame.
    if (next !== this.currentState && !this.attackAction && !this.jumpAction) {
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
    this.updateAttack(Math.min(delta, 0.1));
    this.mixer.update(Math.min(delta, 0.1));
  }

  /**
   * Plays a melee swing as a one-shot over the locomotion cycle.
   *
   * The rig ships `Slash` and `Stab` but has no attack state of its own, so the swing is a
   * one-shot action: the locomotion clip is faded out for its duration and faded back in
   * afterwards. Two full-weight clips would blend into a pose that is neither a walk nor a
   * swing, which is what makes melee look broken rather than fast.
   *
   * `targetSeconds` compresses or stretches the clip to the weapon's own swing length, so
   * a fast knife and a slow axe are one clip at two speeds instead of two authored clips.
   * Returns false when the rig has neither swing clip, in which case the attack still
   * happens and only the animation is missing.
   */
  playMeleeAttack(clip: MeleeClip, targetSeconds = 0): boolean {
    const action = this.attackActionFor(clip);
    if (!action) return false;

    const duration = action.getClip().duration;
    const speed = targetSeconds > 0 && duration > 0 ? duration / targetSeconds : 1;

    // The cycle is faded rather than stopped: it keeps its own time, so the feet carry on
    // from where they were when the swing ends instead of restarting the stride.
    this.actions[this.currentState]?.fadeOut(AVATAR_ATTACK_FADE);
    action.reset();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(speed);
    action.setEffectiveWeight(1);
    action.enabled = true;
    action.fadeIn(AVATAR_ATTACK_FADE);
    action.play();

    this.attackAction = action;
    this.attackRemaining = Math.max(duration / speed, AVATAR_ATTACK_FADE);
    return true;
  }

  /** Clip name of the swing currently playing, or null. */
  get attackClipName(): string | null {
    return this.attackAction?.getClip().name ?? null;
  }

  /**
   * Holds an air pose while the player is off the ground, or hands the body back to the
   * locomotion cycle on `null`.
   *
   * The jump is an overlay for the same reason the swing is (see playMeleeAttack): the rig has
   * no jumping *state*, only clips, so the way to play them is to fade the walk or run cycle
   * out for the duration of the arc and fade it back in on landing. All three poses are
   * LoopOnce: the whole arc lasts about 0.6 s, so every jump clip is longer than the phase
   * that plays it and none of them needs to loop.
   *
   * Idempotent and cheap — the frame loop calls it with the controller's phase every frame, and
   * a call that changes nothing does nothing. A rig with none of the three clips still jumps;
   * only the animation is missing, and the locomotion cycle is deliberately left playing rather
   * than faded out for a pose that does not exist.
   */
  setJumpPhase(phase: JumpPhase | null): void {
    if (phase === this.jumpPhase) return;

    if (phase === null) {
      this.endJump();
      return;
    }

    const action = this.jumpActionFor(phase);
    if (!action) {
      // No jump clips on this rig: remember the phase so the per-frame calls stay cheap, but
      // touch nothing — a faded-out walk cycle with no pose to replace it would look stuck.
      this.jumpPhase = phase;
      return;
    }

    const from = this.jumpAction;
    // The walk/run cycle leaves the stage, faded rather than stopped so it keeps its own time
    // and the feet carry on from where they were when the arc ends.
    this.actions[this.currentState]?.fadeOut(AVATAR_JUMP_FADE);
    // A swing in flight is faded out too, but its own timer still ends it; see updateAttack,
    // which leaves the walk cycle alone while the jump owns the pose.
    if (this.attackAction) this.attackAction.fadeOut(AVATAR_JUMP_FADE);
    if (from && from !== action) from.fadeOut(AVATAR_JUMP_FADE);

    action.reset();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.enabled = true;
    action.fadeIn(AVATAR_JUMP_FADE);
    action.play();

    this.jumpAction = action;
    this.jumpPhase = phase;
  }

  /** Air pose currently held, or null when the character is on its feet. */
  get jumpPose(): JumpPhase | null {
    return this.jumpAction ? this.jumpPhase : null;
  }

  /**
   * Clip names the rig resolved for each air pose, for the diagnostics hook.
   *
   * Resolves lazily like the poses themselves, so reading this at boot reports what the
   * character would play without a jump having happened yet.
   */
  get jumpClipReport(): Record<JumpPhase, string | null> {
    return {
      rise: this.jumpActionFor('rise')?.getClip().name ?? null,
      hang: this.jumpActionFor('hang')?.getClip().name ?? null,
      land: this.jumpActionFor('land')?.getClip().name ?? null,
    };
  }

  /**
   * Resolves an air pose from the rig's own clips.
   *
   * The fallbacks walk the other jump clips, so a rig that ships only `Jump_Idle` still gets
   * an airborne pose instead of freezing in the walk cycle.
   */
  private jumpActionFor(phase: JumpPhase): AnimationAction | null {
    const cached = this.jumpActions.get(phase);
    if (cached !== undefined) return cached;
    const resolution = resolveByCandidates(this.clips, JUMP_CLIP_CANDIDATES[phase]);
    const action = resolution.clip ? this.mixer.clipAction(resolution.clip) : null;
    this.jumpActions.set(phase, action);
    return action;
  }

  /**
   * Ends the air pose and hands the body back to the locomotion cycle.
   */
  private endJump(): void {
    const action = this.jumpAction;
    this.jumpAction = null;
    this.jumpPhase = null;
    action?.fadeOut(AVATAR_JUMP_FADE);
    // A swing still in flight restores the cycle itself (see updateAttack); fading it in
    // underneath the swing would put a stride in the middle of the attack.
    if (this.attackAction) return;
    const locomotion = this.actions[this.currentState];
    if (!locomotion) return;
    locomotion.enabled = true;
    locomotion.setEffectiveWeight(1);
    locomotion.fadeIn(AVATAR_JUMP_FADE);
    locomotion.play();
  }

  /**
   * Resolves a swing action from the rig's own clips.
   *
   * The second candidate is the other swing family: a rig that ships only one of the two
   * should still swing rather than freeze mid-attack.
   */
  private attackActionFor(clip: MeleeClip): AnimationAction | null {
    const cached = this.attackActions.get(clip);
    if (cached !== undefined) return cached;
    const fallback: MeleeClip = clip === 'Slash' ? 'Stab' : 'Slash';
    const resolution = resolveByCandidates(this.clips, [[clip], [fallback]]);
    const action = resolution.clip ? this.mixer.clipAction(resolution.clip) : null;
    this.attackActions.set(clip, action);
    return action;
  }

  /**
   * Advances the swing and hands the pose back to the locomotion clip when it ends.
   */
  private updateAttack(delta: number): void {
    const attack = this.attackAction;
    if (!attack) return;
    this.attackRemaining -= delta;
    if (this.attackRemaining > 0) return;

    attack.fadeOut(AVATAR_ATTACK_FADE);
    this.attackAction = null;
    // An air pose owns the body until landing: restoring the walk cycle here would put a
    // stride in the middle of the arc, so the cycle waits for endJump.
    if (this.jumpAction) return;
    const locomotion = this.actions[this.currentState];
    if (!locomotion) return;
    locomotion.enabled = true;
    locomotion.setEffectiveWeight(1);
    locomotion.fadeIn(AVATAR_ATTACK_FADE);
    locomotion.play();
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
    this.attackActions.clear();
    this.attackAction = null;
    this.jumpActions.clear();
    this.jumpAction = null;
    this.jumpPhase = null;
    this.root.removeFromParent();
    this.root.clear();
    this.scratch.set(0, 0, 0);
  }
}
