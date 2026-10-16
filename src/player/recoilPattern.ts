import { clamp } from '../utils/math';

/**
 * F3: a recoil pattern, not a single straight kick.
 *
 * A weapon that only ever kicks upward draws one vertical line up the screen however
 * long the player holds the trigger, and holding a burst becomes a matter of pulling
 * down. Real automatic fire climbs for the first few rounds and then walks sideways as
 * the shooter's hold loses its symmetry, which is why a spray pattern in a shooter is a
 * shape rather than a direction.
 *
 * The pattern is **deterministic and regular** — two fixed tables of multipliers indexed
 * by the shot's place in the burst — rather than a seeded random walk. Two reasons, and
 * both are about being able to hold the feature to account:
 *
 * - A test can name the shot it is talking about ("the third round pulls right") instead
 *   of asserting a statistical property over a sample.
 * - Two runs of the game produce the same burst, so a pattern a player learns is a
 *   pattern that still works next time — the point of a spray pattern in the first place.
 *
 * The first round is the pure climb (`yaw` 0), and the sideways walk only arrives at the
 * second round onward: the shots climb first, *then* drift. Both tables return to zero
 * well within the burst, so the pattern never has to be reset to stop it pulling — the
 * only state that matters is which round of the burst this is.
 */

/** What one round of the burst adds, as a multiplier on the weapon's own kick. */
export interface RecoilOffset {
  /** Multiplier on `WeaponConfig.recoil`, the weapon's own vertical kick. */
  pitch: number;
  /**
   * Sideways multiplier. The sign is the direction: positive is to the shooter's
   * right, which is the camera's negative yaw.
   */
  yaw: number;
}

/** Vertical multipliers per round of the burst: climbs, peaks, then the muzzle settles. */
const VERTICAL: readonly number[] = [1, 1.08, 1.12, 1.1, 1.04, 0.96, 0.88, 0.8, 0.72, 0.66];

/**
 * Sideways multipliers per round: nothing on the first shot (pure climb), then a
 * growing zig-zag, so the burst reads as climbing and then swaying rather than as an
 * arbitrary wobble from the very first round.
 */
const SIDEWAYS: readonly number[] = [0, 0.18, -0.28, 0.42, -0.55, 0.68, -0.78, 0.86, -0.92, 0.96];

/** How many rounds the pattern describes. Past the end it holds on the last entry. */
export const RECOIL_PATTERN_LENGTH = VERTICAL.length;

/** The offset for `step` rounds into the burst. Clamped, so a long burst stays on-pattern. */
export function recoilOffset(step: number): RecoilOffset {
  const index = clamp(Math.floor(step), 0, RECOIL_PATTERN_LENGTH - 1);
  return { pitch: VERTICAL[index], yaw: SIDEWAYS[index] };
}

/** The whole pattern, for tests and diagnostics that need to see its shape at once. */
export function recoilPattern(): RecoilOffset[] {
  const steps: RecoilOffset[] = [];
  for (let step = 0; step < RECOIL_PATTERN_LENGTH; step += 1) steps.push(recoilOffset(step));
  return steps;
}
