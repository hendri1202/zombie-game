/**
 * requestAnimationFrame driver with a fixed-step accumulator.
 *
 * Two rules from the project brief are enforced here:
 *  - a huge delta (tab was backgrounded) must not explode the simulation, so the
 *    catch-up work per frame is capped and the accumulator is zeroed when capped;
 *  - gameplay runs on a fixed timestep so AI/combat results do not depend on the
 *    refresh rate.
 */

export const FIXED_STEP_SECONDS = 1 / 60;
export const MAX_SUBSTEPS = 5;
export const MAX_FRAME_DELTA_SECONDS = 0.25;

/** Pure accumulator: no timers, no rAF, so it can be unit tested. */
export class FixedStepAccumulator {
  private accumulator = 0;

  constructor(
    readonly fixedStep: number = FIXED_STEP_SECONDS,
    readonly maxSubSteps: number = MAX_SUBSTEPS,
  ) {}

  /**
   * Returns how many fixed steps should run for this frame's raw delta.
   * Leftover time stays in the accumulator, so the simulation runs at real
   * speed instead of a fraction of it.
   */
  advance(rawDeltaSeconds: number): number {
    const delta = Math.min(Math.max(rawDeltaSeconds, 0), MAX_FRAME_DELTA_SECONDS);
    this.accumulator += delta;
    let steps = Math.floor(this.accumulator / this.fixedStep);
    if (steps > this.maxSubSteps) {
      // Too far behind (tab was hidden): drop the backlog rather than
      // simulating a burst that would teleport zombies through the player.
      steps = this.maxSubSteps;
      this.accumulator = 0;
    } else {
      this.accumulator -= steps * this.fixedStep;
    }
    return steps;
  }

  /** Seconds of unfinished time carried into the next frame (used for render lerp). */
  get alpha(): number {
    return this.accumulator / this.fixedStep;
  }

  reset(): void {
    this.accumulator = 0;
  }
}

export interface GameLoopOptions {
  update: (fixedDeltaSeconds: number) => void;
  render: (frameDeltaSeconds: number, alpha: number) => void;
  now?: () => number;
}

export class GameLoop {
  private readonly update: (fixedDeltaSeconds: number) => void;
  private readonly render: (frameDeltaSeconds: number, alpha: number) => void;
  private readonly now: () => number;
  private readonly accumulator = new FixedStepAccumulator();
  private rafId = 0;
  private lastTime = 0;
  private running = false;

  constructor(options: GameLoopOptions) {
    this.update = options.update;
    this.render = options.render;
    this.now = options.now ?? (() => performance.now());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = this.now();
    this.accumulator.reset();
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Exposed for tests and for the headless capture harness. */
  stepOnce(rawDeltaSeconds: number): void {
    const steps = this.accumulator.advance(rawDeltaSeconds);
    for (let i = 0; i < steps; i += 1) this.update(this.accumulator.fixedStep);
    this.render(rawDeltaSeconds, this.accumulator.alpha);
  }

  private tick = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);
    const time = this.now();
    const rawDelta = (time - this.lastTime) / 1000;
    this.lastTime = time;
    this.stepOnce(rawDelta);
  };
}
