import { AnimationAction, AnimationClip, AnimationMixer, LoopOnce, LoopRepeat, Object3D } from 'three';
import { ANIMATION, ANIMATION_CLIP_NAMES, type AnimationState, type ZombieStats } from '../app/gameConfig';
import type { Disposable } from '../core/Disposable';
import { analyseClip, requiredTimeScale, type ClipMotion } from './animationAnalysis';
import { findClip, shortName } from '../utils/clipResolve';

// Re-exported so existing diagnostics keep working after the move to a shared util.
export { findClip, shortName };

interface ClipResolution {
  clip: AnimationClip | null;
  matchedName: string | null;
  /** True when the requested state had no clip and a fallback was substituted. */
  usedFallback: boolean;
}

/** Fallback chain per state, used when the requested clip does not exist. */
const FALLBACK_ORDER: Record<AnimationState, AnimationState[]> = {
  idle: [],
  walk: ['idle'],
  run: ['walk', 'idle'],
  attack: ['walk', 'idle'],
  hit: ['idle'],
  death: ['idle'],
};

/**
 * Resolves one state against the clips a model actually ships, including the
 * fallback chain. Pure and exported so the loader can report the mapping before
 * a single zombie exists.
 */
export function resolveClip(clips: AnimationClip[], state: AnimationState): ClipResolution {
  const direct = findClip(clips, ANIMATION_CLIP_NAMES[state]);
  if (direct) return { clip: direct, matchedName: direct.name, usedFallback: false };

  for (const fallback of FALLBACK_ORDER[state]) {
    const resolved = findClip(clips, ANIMATION_CLIP_NAMES[fallback]);
    if (resolved) return { clip: resolved, matchedName: resolved.name, usedFallback: true };
  }
  return { clip: null, matchedName: null, usedFallback: true };
}

/** Which clip each animation state actually maps to, for logs and diagnostics. */
export function resolveClipMap(clips: AnimationClip[]): Record<AnimationState, string | null> {
  const states = Object.keys(ANIMATION_CLIP_NAMES) as AnimationState[];
  const map = {} as Record<AnimationState, string | null>;
  for (const state of states) map[state] = resolveClip(clips, state).matchedName;
  return map;
}

/**
 * Wraps one AnimationMixer per zombie.
 *
 * Clip names are never assumed: candidates are matched against the clips present
 * in the loaded model, and a missing clip falls back to the safest available
 * state instead of freezing the character.
 */
export class ZombieAnimator implements Disposable {
  private readonly mixer: AnimationMixer;
  private readonly root: Object3D;
  private readonly stats: ZombieStats;
  private readonly actions = new Map<string, AnimationAction>();
  private readonly resolution = new Map<AnimationState, ClipResolution>();
  private currentState: AnimationState | null = null;
  private currentAction: AnimationAction | null = null;
  private oneShotActive = false;
  /** Ground speed of the entity, used to match the locomotion cycle rate. */
  private locomotionSpeed = 0;
  /** Measured motion of the clips bound to locomotion states. */
  private readonly motion = new Map<AnimationState, ClipMotion>();
  readonly clipNames: string[];

  constructor(root: Object3D, clips: AnimationClip[], stats: ZombieStats) {
    this.root = root;
    this.stats = stats;
    this.mixer = new AnimationMixer(root);
    this.clipNames = clips.map((clip) => clip.name);

    const states = Object.keys(ANIMATION_CLIP_NAMES) as AnimationState[];
    for (const state of states) {
      const resolved = resolveClip(clips, state);
      this.resolution.set(state, resolved);
      if (resolved.clip) this.motion.set(state, analyseClip(resolved.clip));
      if (resolved.usedFallback && state !== 'idle' && !resolved.clip) {
        console.warn(`[anim] ${stats.kind}: no clip for "${state}" and no fallback available`);
      }
    }

    const walk = this.motion.get('walk');
    const run = this.motion.get('run');
    if (walk && run && walk.horizontalTravel < 0.02 && run.horizontalTravel < 0.02) {
      // Expected for this pack: the cycles are in place, so playback rate is what
      // keeps the feet planted. Logged once per kind so the assumption is visible.
      console.info(
        `[anim] ${stats.kind}: in-place locomotion clips `
        + `(walk ${walk.duration.toFixed(2)}s, run ${run.duration.toFixed(2)}s) `
        + `-> cycle rate matched to ground speed`,
      );
    }
  }

  /** Clip names actually bound to each state, for diagnostics. */
  get mapping(): Record<string, string | null> {
    const map: Record<string, string | null> = {};
    for (const [state, entry] of this.resolution) map[state] = entry.matchedName;
    return map;
  }

  /** States for which no clip exists at all. */
  get missingStates(): AnimationState[] {
    const missing: AnimationState[] = [];
    for (const [state, entry] of this.resolution) {
      if (!entry.clip && state !== 'idle') missing.push(state);
    }
    return missing;
  }

  private actionFor(state: AnimationState): AnimationAction | null {
    const entry = this.resolution.get(state);
    if (!entry?.clip) return null;
    const key = `${state}:${entry.matchedName}`;
    let action = this.actions.get(key);
    if (!action) {
      action = this.mixer.clipAction(entry.clip);
      action.clampWhenFinished = true;
      this.actions.set(key, action);
    }
    return action;
  }

  /**
   * Ground speed of the entity for this frame. Locomotion clips are played at
   * `speed / reference` so the stride keeps up with the movement; one-shot
   * clips keep their authored rate scaled by the per-kind animation speed.
   */
  setLocomotionSpeed(speed: number): void {
    this.locomotionSpeed = speed;
    const state = this.currentState;
    if (state !== 'walk' && state !== 'run') return;
    const action = this.currentAction;
    if (action) action.timeScale = this.locomotionTimeScale(state);
  }

  private locomotionTimeScale(state: AnimationState): number {
    const motion = this.motion.get(state);
    const reference = state === 'run' ? ANIMATION.runReferenceSpeed : ANIMATION.walkReferenceSpeed;
    const raw = motion ? requiredTimeScale(motion, this.locomotionSpeed, reference) : 1;
    return Math.min(Math.max(raw, ANIMATION.minTimeScale), ANIMATION.maxTimeScale);
  }

  play(state: AnimationState, options: { fade?: number; restart?: boolean } = {}): void {
    const fade = options.fade ?? ANIMATION.fadeLocomotion;
    const oneShot = state === 'attack' || state === 'hit' || state === 'death';
    if (this.currentState === state && !options.restart && !oneShot) return;

    const action = this.actionFor(state);
    if (!action) return;

    if (oneShot) {
      action.setLoop(LoopOnce, 1);
      action.reset();
      action.timeScale = this.stats.animationSpeed;
    } else {
      action.setLoop(LoopRepeat, Number.POSITIVE_INFINITY);
      action.timeScale = this.locomotionTimeScale(state);
      if (!action.isRunning()) action.reset().play();
    }

    const previous = this.currentAction;
    if (previous && previous !== action) {
      action.reset().play();
      previous.crossFadeTo(action, fade, false);
    } else {
      action.play();
    }
    this.currentAction = action;
    this.currentState = state;
    this.oneShotActive = oneShot;
  }

  get isPlayingOneShot(): boolean {
    return this.oneShotActive;
  }

  /** Playback rate of the current clip, for diagnostics and tests. */
  get currentClipTimeScale(): number {
    return this.currentAction?.timeScale ?? 0;
  }

  /** Name of the clip currently bound to a state, for diagnostics and tests. */
  clipFor(state: AnimationState): string | null {
    return this.resolution.get(state)?.matchedName ?? null;
  }

  update(delta: number): void {
    this.mixer.update(delta);
  }

  /** Restarts the mixer root so pooled zombies do not inherit the old pose. */
  reset(): void {
    this.mixer.stopAllAction();
    this.actions.clear();
    this.currentState = null;
    this.currentAction = null;
    this.oneShotActive = false;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
    this.resolution.clear();
  }
}
