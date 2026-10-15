import { AnimationClip, Group, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';
import { ANIMATION, ZOMBIE_TYPES } from '../src/app/gameConfig';
import { analyseClip, clipCompatibility, collectBoneNames, requiredTimeScale } from '../src/zombies/animationAnalysis';
import { ZombieAnimator } from '../src/zombies/ZombieAnimator';

/** Position track for the hips: 3 keys over 1 second. */
function hipsTrack(start: [number, number, number], end: [number, number, number]): VectorKeyframeTrack {
  return new VectorKeyframeTrack('Hips.position', [0, 0.5, 1], [
    start[0], start[1], start[2],
    (start[0] + end[0]) / 2, start[1], (start[2] + end[2]) / 2,
    end[0], end[1], end[2],
  ]);
}

describe('analyseClip', () => {
  it('reports zero travel for an in-place cycle', () => {
    const clip = new AnimationClip('walk', 1, [hipsTrack([0, 1, 0], [0, 1, 0])]);
    const motion = analyseClip(clip);
    expect(motion.horizontalTravel).toBeCloseTo(0, 5);
    expect(motion.rootTrackName).toBe('Hips.position');
    expect(motion.cadence).toBeCloseTo(1, 5);
  });

  it('measures the net horizontal travel of a clip with root motion', () => {
    const clip = new AnimationClip('walk', 1, [hipsTrack([0, 1, 0], [1.2, 1, 0.9])]);
    const motion = analyseClip(clip);
    expect(motion.horizontalTravel).toBeCloseTo(Math.hypot(1.2, 0.9), 5);
  });

  it('ignores vertical motion when measuring travel', () => {
    const clip = new AnimationClip('walk', 1, [hipsTrack([0, 0.8, 0], [0, 1.1, 0])]);
    const motion = analyseClip(clip);
    expect(motion.horizontalTravel).toBeCloseTo(0, 5);
    expect(motion.verticalRange).toBeCloseTo(0.3, 5);
  });

  it('handles a clip with no root position track at all', () => {
    const clip = new AnimationClip('idle', 2, [
      new QuaternionKeyframeTrack('Hips.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    const motion = analyseClip(clip);
    expect(motion.rootTrackName).toBeNull();
    expect(motion.horizontalTravel).toBe(0);
    expect(motion.cadence).toBeCloseTo(0.5, 5);
  });
});

describe('clipCompatibility', () => {
  const bones = new Set(['hips', 'spine', 'head', 'leftarm', 'rightarm']);

  it('reports full compatibility when every track binds', () => {
    const clip = new AnimationClip('punch', 1, [
      new VectorKeyframeTrack('CharacterArmature/Hips.position', [0, 1], [0, 0, 0, 0, 0, 0]),
      new QuaternionKeyframeTrack('CharacterArmature/Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
      new QuaternionKeyframeTrack('CharacterArmature/Head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    expect(clipCompatibility(clip, bones)).toBe(1);
  });

  it('reports partial compatibility when a bone is missing, so it can be refused', () => {
    const clip = new AnimationClip('punch', 1, [
      new QuaternionKeyframeTrack('CharacterArmature/Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
      new QuaternionKeyframeTrack('OtherRig/LeftHand.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    expect(clipCompatibility(clip, bones)).toBe(0.5);
  });

  it('reports zero for a clip with no tracks rather than dividing by nothing', () => {
    expect(clipCompatibility(new AnimationClip('empty', 1, []), bones)).toBe(0);
  });

  it('ignores the leaf name prefix and matches on the bone only', () => {
    const clip = new AnimationClip('x', 1, [
      new QuaternionKeyframeTrack('Deep/Path/To/LeftArm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    expect(clipCompatibility(clip, bones)).toBe(1);
  });

  it('collects bone names case-insensitively from a hierarchy', () => {
    const root = new Group();
    const child = new Group();
    child.name = 'LeftArm';
    root.add(child);
    const set = collectBoneNames(root);
    expect(set.has('leftarm')).toBe(true);
  });
});

describe('requiredTimeScale', () => {
  it('matches the stride exactly when the clip carries root motion', () => {
    // 2 m of travel per 1 s loop = 2 m/s of animated speed.
    const motion = analyseClip(new AnimationClip('run', 1, [hipsTrack([0, 1, 0], [2, 1, 0])]));
    expect(motion.horizontalTravel * motion.cadence).toBeCloseTo(2, 5);
    expect(requiredTimeScale(motion, 4, ANIMATION.runReferenceSpeed)).toBeCloseTo(2, 5);
  });

  it('falls back to the authored reference speed for an in-place clip', () => {
    const motion = analyseClip(new AnimationClip('walk', 1, [hipsTrack([0, 1, 0], [0, 1, 0])]));
    expect(requiredTimeScale(motion, ANIMATION.walkReferenceSpeed, ANIMATION.walkReferenceSpeed)).toBeCloseTo(1, 5);
    expect(requiredTimeScale(motion, ANIMATION.walkReferenceSpeed * 2, ANIMATION.walkReferenceSpeed)).toBeCloseTo(2, 5);
  });

  it('returns zero for a stationary entity rather than dividing by nothing', () => {
    const motion = analyseClip(new AnimationClip('walk', 1, [hipsTrack([0, 1, 0], [0, 1, 0])]));
    expect(requiredTimeScale(motion, 0, ANIMATION.walkReferenceSpeed)).toBe(0);
  });

  it('does not divide by a zero reference speed', () => {
    const motion = analyseClip(new AnimationClip('walk', 1, [hipsTrack([0, 1, 0], [0, 1, 0])]));
    expect(requiredTimeScale(motion, 2, 0)).toBe(1);
  });
});

/** A clip set shaped like the real pack's, used to exercise the animator. */
function makeClips(): AnimationClip[] {
  return [
    new AnimationClip('CharacterArmature|Idle', 2, []),
    new AnimationClip('CharacterArmature|Walk', 1, []),
    new AnimationClip('CharacterArmature|Run', 0.6, []),
    new AnimationClip('CharacterArmature|Punch', 0.7, []),
    new AnimationClip('CharacterArmature|HitReact', 0.4, []),
    new AnimationClip('CharacterArmature|Death', 1.5, []),
  ];
}

describe('ZombieAnimator locomotion playback', () => {
  it('binds each state to the right clip', () => {
    const animator = new ZombieAnimator(new Group(), makeClips(), ZOMBIE_TYPES.walker);
    expect(animator.clipFor('idle')).toBe('CharacterArmature|Idle');
    expect(animator.clipFor('walk')).toBe('CharacterArmature|Walk');
    expect(animator.clipFor('run')).toBe('CharacterArmature|Run');
    expect(animator.clipFor('attack')).toBe('CharacterArmature|Punch');
    expect(animator.clipFor('hit')).toBe('CharacterArmature|HitReact');
    expect(animator.clipFor('death')).toBe('CharacterArmature|Death');
    animator.dispose();
  });

  it('scales the walk cycle by ground speed so the stride keeps up', () => {
    const animator = new ZombieAnimator(new Group(), makeClips(), ZOMBIE_TYPES.walker);
    animator.setLocomotionSpeed(ANIMATION.walkReferenceSpeed);
    animator.play('walk');
    expect(animator.currentClipTimeScale).toBeCloseTo(1, 2);

    // Walk at half speed: the cycle must slow down, not the zombie skate.
    animator.setLocomotionSpeed(ANIMATION.walkReferenceSpeed / 2);
    expect(animator.currentClipTimeScale).toBeCloseTo(0.5, 2);

    // Sprinting way past the authored speed still clamps.
    animator.setLocomotionSpeed(ANIMATION.walkReferenceSpeed * 10);
    expect(animator.currentClipTimeScale).toBe(ANIMATION.maxTimeScale);
    animator.dispose();
  });

  it('never clamps a real gameplay speed into sliding', () => {
    // Every kind chases and wanders at a known speed; the resulting cycle rate
    // must stay inside the clamp, otherwise the clamp reintroduces sliding.
    const kinds = [ZOMBIE_TYPES.walker, ZOMBIE_TYPES.runner, ZOMBIE_TYPES.tank];
    for (const stats of kinds) {
      const chaseRate = stats.chaseSpeed / ANIMATION.runReferenceSpeed;
      const wanderRate = stats.walkSpeed / ANIMATION.walkReferenceSpeed;
      expect(chaseRate).toBeGreaterThanOrEqual(ANIMATION.minTimeScale);
      expect(chaseRate).toBeLessThanOrEqual(ANIMATION.maxTimeScale);
      expect(wanderRate).toBeGreaterThanOrEqual(ANIMATION.minTimeScale);
      expect(wanderRate).toBeLessThanOrEqual(ANIMATION.maxTimeScale);
    }
  });

  it('does not slow the cycle below the configured floor', () => {
    const animator = new ZombieAnimator(new Group(), makeClips(), ZOMBIE_TYPES.tank);
    animator.play('walk');
    animator.setLocomotionSpeed(0.05);
    expect(animator.currentClipTimeScale).toBe(ANIMATION.minTimeScale);
    animator.dispose();
  });

  it('keeps one-shot clips at the per-kind animation speed', () => {
    const animator = new ZombieAnimator(new Group(), makeClips(), ZOMBIE_TYPES.runner);
    animator.setLocomotionSpeed(ANIMATION.runReferenceSpeed);
    animator.play('attack', { restart: true });
    expect(animator.currentClipTimeScale).toBeCloseTo(ZOMBIE_TYPES.runner.animationSpeed, 5);
    expect(animator.isPlayingOneShot).toBe(true);
    animator.dispose();
  });
});
