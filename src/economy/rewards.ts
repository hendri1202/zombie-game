/**
 * Point rules for the run economy.
 *
 * Data plus pure functions only: everything here is "value in, points out", so the payout
 * can be reasoned about and tested without a game running. `Game` owns the event wiring and
 * `ProfileStore` owns the balance; neither decision lives here.
 *
 * The numbers, and why:
 *
 * - Walker 5 / Runner 8 / Tank 25. The walker is the unit every wave is built out of, so it
 *   sets the scale: a 30-zombie opening wave pays about 150, which is one cheap melee weapon.
 *   The runner is worth 60% more because it is at the player's back before a slow reload
 *   finishes — it is the more expensive one to leave alive. The tank pays five walkers
 *   because it carries 420 hit points against the walker's 100: roughly five times the
 *   ammunition for one kill, and it is the only zombie that can delete a careless player
 *   outright.
 *
 * - A headshot *replaces* the body value rather than adding to it (8 for a walker, not
 *   5 + 8). Precision should pay better than a body shot without doubling every payout in
 *   the game; the plan this follows specifies exactly that ("8, bukan 5+8"). Because it is a
 *   single value, a headshot kill can never stack with a body-kill award — there is no second
 *   award to stack with.
 *
 * - A cleared wave pays 50 + 10 x wave. It rises with the wave because waves get larger and
 *   longer, and it is paid once per wave, so it rewards finishing a wave rather than farming
 *   stragglers. Points are only awarded while the simulation is running (see Game): there is
 *   no payout for a kill once the wave has ended.
 */
import type { ZombieKind } from '../app/gameConfig';

/** Why a payout happened, for the HUD and for the debug report. */
export type PointReason = 'kill' | 'headshot' | 'wave';

export const POINTS: {
  /** Points for a kill by kind, landing on the body. */
  kill: Record<ZombieKind, number>;
  /** Points for a kill by kind when the killing blow was a headshot. A replacement. */
  headshot: Record<ZombieKind, number>;
  /** Flat part of the wave-clear bonus. */
  waveClearBase: number;
  /** Added per wave number, so deeper waves pay more for the same work-per-zombie. */
  waveClearPerWave: number;
} = {
  kill: { walker: 5, runner: 8, tank: 25 },
  headshot: { walker: 8, runner: 12, tank: 35 },
  waveClearBase: 50,
  waveClearPerWave: 10,
};

/**
 * Points for one dead zombie.
 *
 * `headshot` is a replacement value, not a bonus: a headshot kill pays `POINTS.headshot`
 * and nothing else, which is what keeps a single kill from ever being counted twice.
 */
export function pointsForKill(kind: ZombieKind, headshot = false): number {
  return headshot ? POINTS.headshot[kind] : POINTS.kill[kind];
}

/** Points for clearing a wave. Wave numbers below 1 are treated as wave 1. */
export function pointsForWaveCleared(wave: number): number {
  const safeWave = Number.isFinite(wave) ? Math.max(1, Math.floor(wave)) : 1;
  return POINTS.waveClearBase + POINTS.waveClearPerWave * safeWave;
}
