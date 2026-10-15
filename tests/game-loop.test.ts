import { describe, expect, it } from 'vitest';
import { FixedStepAccumulator, MAX_FRAME_DELTA_SECONDS, MAX_SUBSTEPS } from '../src/core/GameLoop';

const FIXED_STEP = 1 / 60;

describe('FixedStepAccumulator', () => {
  it('keeps the leftover time so the simulation runs at real speed', () => {
    const accumulator = new FixedStepAccumulator(FIXED_STEP, MAX_SUBSTEPS);
    // 100 frames of 16.67 ms should produce 100 steps in total, not 99 or 101.
    let steps = 0;
    for (let i = 0; i < 100; i += 1) steps += accumulator.advance(1 / 60);
    expect(steps).toBe(100);
  });

  it('does not lose time on a refresh rate above the simulation rate', () => {
    const accumulator = new FixedStepAccumulator(FIXED_STEP, MAX_SUBSTEPS);
    let steps = 0;
    // 240 Hz display: 600 frames of 1/240 s = 2.5 s of simulated time = 150 steps.
    for (let i = 0; i < 600; i += 1) steps += accumulator.advance(1 / 240);
    expect(steps).toBe(150);
  });

  it('caps catch-up after a long stall and discards the backlog', () => {
    const accumulator = new FixedStepAccumulator(FIXED_STEP, MAX_SUBSTEPS);
    const steps = accumulator.advance(30);
    expect(steps).toBe(MAX_SUBSTEPS);
    // Backlog dropped: the next normal frame must not trigger a burst again.
    expect(accumulator.advance(1 / 60)).toBe(1);
  });

  it('never advances backwards for a negative delta', () => {
    const accumulator = new FixedStepAccumulator(FIXED_STEP, MAX_SUBSTEPS);
    expect(accumulator.advance(-5)).toBe(0);
  });

  it('clamps a delta larger than the maximum frame delta', () => {
    const accumulator = new FixedStepAccumulator(FIXED_STEP, MAX_SUBSTEPS);
    const steps = accumulator.advance(MAX_FRAME_DELTA_SECONDS * 4);
    // 0.25 s of clamped time is 15 steps, still limited by maxSubSteps.
    expect(steps).toBeLessThanOrEqual(MAX_SUBSTEPS);
  });
});
