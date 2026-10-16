import { describe, expect, it } from 'vitest';
import { hudVisibleFor } from '../src/ui/HUD';
import type { GamePhase } from '../src/core/GameState';

/**
 * The HUD is the in-run readout, so the phase decides whether it is up — not the death path,
 * and not the reader's guess about what phase the game is in.
 *
 * This is the invariant a browser gate misread: it found `#hud` carrying `hidden` and reported
 * a regression while the run it was reading had already ended (the player was at 0 health and
 * the harness restarted the run on its next line). The rule is pinned here so the two cannot
 * drift apart, and the game's phases that legitimately hide the HUD are written down as data.
 */
describe('HUD visibility follows the phase', () => {
  it('shows the HUD for a live run and for nothing else', () => {
    const hidden: GamePhase[] = ['loading', 'title', 'paused', 'gameOver'];
    expect(hudVisibleFor('playing')).toBe(true);
    for (const phase of hidden) expect(hudVisibleFor(phase), phase).toBe(false);
  });

  it('hides the HUD for both endings, which share a phase', () => {
    // A won run reuses `gameOver` and shows its own results screen instead of "You died". The
    // HUD comes down either way, because in both cases the run it was reporting is over — so a
    // hidden HUD on the mission-complete screen is the design, not a bug to chase.
    expect(hudVisibleFor('gameOver')).toBe(false);
  });

  it('covers every phase the state machine can be in', () => {
    const all: GamePhase[] = ['loading', 'title', 'playing', 'paused', 'gameOver'];
    // Nothing left out: a phase added to GamePhase without a decision here would default to
    // hidden, and a live run that never gets its HUD back is the failure this file is about.
    expect(all.filter((phase) => hudVisibleFor(phase))).toEqual(['playing']);
  });
});
