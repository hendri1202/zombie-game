import type { WeaponId } from '../app/gameConfig';

/**
 * Gunshot samples, and the pure pieces of playing them.
 *
 * The game synthesised every sound with oscillators and a noise buffer, which is why a
 * shot read as a burst of static rather than a gun: a real gunshot is a transient crack,
 * a body, and a tail off the buildings. The samples here are real recordings (see
 * ASSET_CREDITS.md), the transient layer is still synthesised on top for punch, and the
 * tail is a convolution reverb with a generated impulse response, so the street answers
 * back.
 *
 * Everything that can be decided without an AudioContext lives in this module as a pure
 * function, so the mapping, the variation and the impulse response are unit tested rather
 * than trusted.
 */

/** Which recorded shot a weapon fires. */
export type ShotRole = 'pistol' | 'rifle' | 'shotgun' | 'heavy';

/** Files per role, under `public/assets/audio/`. Several variants beat one repeated. */
export const SHOT_SAMPLES: Record<ShotRole, readonly string[]> = {
  pistol: ['pistol-1.wav', 'pistol-2.wav'],
  rifle: ['rifle-1.wav', 'rifle-2.wav'],
  shotgun: ['shotgun-1.wav'],
  heavy: ['heavy-1.wav'],
} as const;

/** Public path for a sample file. */
export function samplePath(file: string): string {
  return `/assets/audio/${file}`;
}

/**
 * The role a weapon's shot uses.
 *
 * Weapons that do not exist yet are mapped by intent so adding them needs no change here:
 * a submachine gun uses the rifle recording, a light machine gun the heavy one.
 */
export function shotRoleFor(id: WeaponId | string): ShotRole {
  switch (id) {
    case 'shotgun': return 'shotgun';
    case 'lmg': return 'heavy';
    // The compact SMG, the MP5-class and the P90-class bullpup are all rifle recordings:
    // the work order asks for existing roles, not new samples.
    case 'rifle':
    case 'smg':
    case 'mp5':
    case 'p90': return 'rifle';
    default: return 'pistol';
  }
}

/** Every sample file the game expects, so the loader can report what failed. */
export function allSampleFiles(): string[] {
  const files: string[] = [];
  for (const list of Object.values(SHOT_SAMPLES)) files.push(...list);
  return files;
}

/**
 * Per-shot pitch variation, as a playback rate.
 *
 * Without it a burst of fire is the same waveform pasted end to end, which is instantly
 * recognisable as a recording on a loop.
 */
export function shotPlaybackRate(random: () => number): number {
  return 0.96 + random() * 0.08;
}

/** Per-shot gain variation, as a multiplier. */
export function shotGain(random: () => number): number {
  return 0.88 + random() * 0.2;
}

/** How long the synthesised transient layer is, seconds. It only adds the crack. */
export const TRANSIENT_SECONDS = 0.055;

/** How much of the synthesised crack is mixed on top of the sample. */
export const TRANSIENT_MIX = 0.35;

/** Reverb tail: length and decay, seconds. The street between the buildings. */
export const TAIL_SECONDS = 0.9;
export const TAIL_DECAY = 3.2;
/** How much of the tail is mixed in. */
export const TAIL_MIX = 0.34;

/**
 * An impulse response for the tail, as raw samples.
 *
 * Noise with an exponential decay: no measured impulse response to download, and it is
 * enough to put the shot in a street rather than in a vacuum. Deterministic given the
 * random source, so a test can assert the shape.
 */
export function createImpulseResponse(
  sampleRate: number, seconds = TAIL_SECONDS, decay = TAIL_DECAY, random: () => number = Math.random,
): Float32Array {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const impulse = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / length;
    // Squared envelope: a fast initial fall then a longer low-level rumble.
    const envelope = Math.pow(1 - t, decay) * (1 - t);
    impulse[i] = (random() * 2 - 1) * envelope;
  }
  return impulse;
}

/** Peak of an impulse response, for a test to check it actually starts loud and fades. */
export function impulsePeakNear(impulse: Float32Array, fraction: number): number {
  const centre = Math.floor(impulse.length * fraction);
  const span = Math.max(1, Math.floor(impulse.length * 0.02));
  let peak = 0;
  for (let i = Math.max(0, centre - span); i < Math.min(impulse.length, centre + span); i += 1) {
    peak = Math.max(peak, Math.abs(impulse[i]));
  }
  return peak;
}
