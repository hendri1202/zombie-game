import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { PlayerController } from '../src/player/PlayerController';
import { CollisionWorld } from '../src/level/CollisionWorld';
import { PLAYER } from '../src/app/gameConfig';
import { jumpAirTime, jumpPeakHeight, stepVertical } from '../src/player/jumpPhysics';
import type { InputSnapshot } from '../src/input/InputManager';

/** One simulation frame, the same step the game loop runs. */
const STEP = 1 / 60;

function snapshot(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
  return {
    forward: 0,
    right: 0,
    sprint: false,
    lookX: 0,
    lookY: 0,
    firing: false,
    firePressed: false,
    jumpPressed: false,
    reloadPressed: false,
    meleePressed: false,
    weaponSlotRequested: null,
    ...overrides,
  };
}

function harness(collision?: CollisionWorld) {
  const world = collision ?? new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
  const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
  const player = new PlayerController({ camera, collision: world });

  /**
   * Advances the controller in fixed sub-steps of one frame, the way `GameLoop` drives it, so
   * the arc under test is the one the game actually integrates rather than a single long step.
   */
  const step = (seconds: number, input: InputSnapshot | null = null): void => {
    let remaining = seconds;
    while (remaining > 1e-9) {
      const dt = Math.min(STEP, remaining);
      player.update(dt, input);
      remaining -= dt;
    }
  };

  const frame = (input: InputSnapshot = snapshot()): void => step(STEP, input);

  return { player, collision: world, step, frame };
}

/**
 * Steps the arc out to its landing and reports the highest point reached.
 *
 * Bounded rather than `while`: a jump that never lands is the bug this is here to catch, and
 * a loop with no end would report a timeout instead of a measurement.
 */
function measureJump(
  player: PlayerController,
  step: (seconds: number, input?: InputSnapshot | null) => void,
  input: InputSnapshot,
): { peak: number; frames: number; sawAirborne: boolean } {
  let peak = 0;
  let frames = 0;
  let sawAirborne = false;
  while (frames < 600) {
    step(STEP, input);
    frames += 1;
    if (!player.grounded) sawAirborne = true;
    peak = Math.max(peak, player.position.y);
    if (player.grounded) break;
  }
  return { peak, frames, sawAirborne };
}

describe('the jump arc', () => {
  it('rises on launch and comes back down to the ground', () => {
    const h = harness();
    h.frame(snapshot({ jumpPressed: true }));

    expect(h.player.velocity.y).toBeGreaterThan(0);
    expect(h.player.grounded).toBe(false);

    const { sawAirborne, peak } = measureJump(h.player, h.step, snapshot());

    expect(sawAirborne).toBe(true);
    expect(h.player.grounded).toBe(true);
    // Landed exactly on the ground plane: not below it, not hovering.
    expect(h.player.position.y).toBe(0);
    expect(h.player.velocity.y).toBe(0);
    expect(peak).toBeGreaterThan(0);
  });

  it('lasts about 2v/g and peaks at about v²/2g', () => {
    const h = harness();
    h.frame(snapshot({ jumpPressed: true }));
    const { peak, frames } = measureJump(h.player, h.step, snapshot());

    // The simulation is semi-implicit Euler, whose first-order error makes the discrete peak a
    // little lower than the closed form; the tolerance covers that and nothing more. A jump run
    // on a different gravity than the config names would miss by far more than that.
    const idealPeak = jumpPeakHeight(PLAYER.jumpSpeed, PLAYER.gravity);
    expect(peak).toBeLessThanOrEqual(idealPeak + 1e-6);
    expect(peak).toBeGreaterThan(idealPeak * 0.9);

    // Symmetric arc: air time is 2v/g to within a frame either way.
    const idealAirTime = jumpAirTime(PLAYER.jumpSpeed, PLAYER.gravity);
    expect(frames * STEP).toBeGreaterThan(idealAirTime - STEP);
    expect(frames * STEP).toBeLessThan(idealAirTime + STEP);
  });

  it('keeps the peak a sane height: visible, and short of the world ceiling', () => {
    // Not a restatement of the tuning values but the bound the feature has to respect: above the
    // player's own height the jump would clear chest-high cover, and near zero it would not read
    // as a jump at all.
    const peak = jumpPeakHeight(PLAYER.jumpSpeed, PLAYER.gravity);
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(PLAYER.height);
    expect(peak).toBeLessThan(2);
  });
});

describe('the double-jump rule', () => {
  it('accepts one jump and ignores the key while airborne', () => {
    const single = harness();
    single.frame(snapshot({ jumpPressed: true }));
    const alone = measureJump(single.player, single.step, snapshot());

    // The same jump, but with the key held down for every frame of it.
    const spammed = harness();
    spammed.frame(snapshot({ jumpPressed: true }));
    const held = measureJump(spammed.player, spammed.step, snapshot({ jumpPressed: true }));

    expect(held.sawAirborne).toBe(true);
    // Identical arcs: a press in the air bought nothing.
    expect(held.peak).toBeCloseTo(alone.peak, 9);
    expect(held.frames).toBe(alone.frames);
  });

  it('never lets the upward speed rise again once it is in the air', () => {
    const h = harness();
    h.frame(snapshot({ jumpPressed: true }));

    let previous = h.player.velocity.y;
    let airborneFrames = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      h.step(STEP, snapshot({ jumpPressed: true }));
      if (h.player.grounded) break;
      airborneFrames += 1;
      // Gravity only ever subtracts while the body is off the ground: there is no second launch
      // and no impulse, so a press in the air cannot add upward speed back.
      expect(h.player.velocity.y).toBeLessThan(previous);
      previous = h.player.velocity.y;
      expect(h.player.position.y).toBeGreaterThanOrEqual(0);
    }
    expect(airborneFrames).toBeGreaterThan(3);
    expect(h.player.grounded).toBe(true);
  });

  it('allows another jump once the player has landed', () => {
    const h = harness();
    h.frame(snapshot({ jumpPressed: true }));
    measureJump(h.player, h.step, snapshot());
    expect(h.player.grounded).toBe(true);

    h.frame(snapshot({ jumpPressed: true }));
    expect(h.player.velocity.y).toBeGreaterThan(0);
    expect(h.player.grounded).toBe(false);
  });
});

describe('nothing else about movement changes', () => {
  it('keeps walk speed identical on the ground and in the air', () => {
    const walk = snapshot({ forward: 1 });
    const ground = harness();
    for (let frame = 0; frame < 180; frame += 1) ground.frame(walk);
    const groundSpeed = Math.hypot(ground.player.velocity.x, ground.player.velocity.z);
    expect(groundSpeed).toBeCloseTo(PLAYER.walkSpeed, 1);

    const airborne = harness();
    airborne.frame({ ...walk, jumpPressed: true });
    for (let frame = 0; frame < 179; frame += 1) airborne.frame(walk);
    const flyingSpeed = Math.hypot(airborne.player.velocity.x, airborne.player.velocity.z);

    // Bit-for-bit the same horizontal velocity: the jump adds a vertical axis and nothing else.
    // The 0.6 s arc means a good part of that run happened off the ground.
    expect(flyingSpeed).toBeCloseTo(groundSpeed, 9);
  });

  it('keeps sprint speed and adds no hidden boost', () => {
    const sprint = snapshot({ forward: 1, sprint: true });
    const h = harness();
    h.frame({ ...sprint, jumpPressed: true });

    let fastest = 0;
    for (let frame = 0; frame < 180; frame += 1) {
      h.frame(sprint);
      fastest = Math.max(fastest, Math.hypot(h.player.velocity.x, h.player.velocity.z));
    }
    expect(fastest).toBeLessThanOrEqual(PLAYER.sprintSpeed + 1e-9);
    expect(fastest).toBeCloseTo(PLAYER.sprintSpeed, 1);
  });

  it('leaves the survivor speeds the game set alone', () => {
    const h = harness();
    h.player.setSpeeds(4.1, 6.6);
    h.frame(snapshot({ jumpPressed: true }));
    expect(h.player.walkSpeedValue).toBeCloseTo(4.1, 9);
    expect(h.player.sprintSpeedValue).toBeCloseTo(6.6, 9);
  });
});

describe('the world still holds', () => {
  it('cannot jump through a wall: horizontal collision applies in the air', () => {
    const collision = new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
    // A tall wall straight ahead of the spawn, which faces +Z (yaw = PI).
    collision.addCenteredBox(0, 20, 24, 2, 4, 'wall', { blocksPlayer: true, blocksZombies: true });
    const h = harness(collision);

    const input = snapshot({ forward: 1, sprint: true });
    let furthestZ = -Infinity;
    let sawAirborne = false;
    for (let frame = 0; frame < 300; frame += 1) {
      // Leaping at the wall over and over: the only way past it would be through it.
      h.frame(frame % 40 === 0 ? { ...input, jumpPressed: true } : input);
      if (!h.player.grounded) sawAirborne = true;
      furthestZ = Math.max(furthestZ, h.player.position.z);
      // The floor holds on every frame of every jump.
      expect(h.player.position.y).toBeGreaterThanOrEqual(0);
    }

    expect(sawAirborne).toBe(true);
    // The wall's near face is at z = 19 and the player is a circle of PLAYER.radius.
    expect(furthestZ).toBeLessThanOrEqual(19 - PLAYER.radius + 1e-6);
    expect(furthestZ).toBeGreaterThan(17);
  });

  it('cannot leave the play area by jumping at the perimeter', () => {
    // The same shape as the level's own perimeter: a solid, full-height barrier on every side.
    const area = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
    const collision = new CollisionWorld(area);
    const thickness = 2;
    const height = 6;
    const spanX = (area.maxX - area.minX) + thickness * 2;
    const spanZ = (area.maxZ - area.minZ) + thickness * 2;
    collision.addCenteredBox(0, area.maxZ + thickness / 2, spanX, thickness, height, 'perimeter');
    collision.addCenteredBox(0, area.minZ - thickness / 2, spanX, thickness, height, 'perimeter');
    collision.addCenteredBox(area.maxX + thickness / 2, 0, thickness, spanZ, height, 'perimeter');
    collision.addCenteredBox(area.minX - thickness / 2, 0, thickness, spanZ, height, 'perimeter');

    // Jumping in each of the four headings, from the middle of the block.
    const headings: InputSnapshot[] = [
      snapshot({ forward: 1, sprint: true }),   // +Z
      snapshot({ forward: -1, sprint: true }),  // -Z
      snapshot({ right: 1, sprint: true }),     // -X
      snapshot({ right: -1, sprint: true }),    // +X
    ];

    for (const heading of headings) {
      const h = harness(collision);
      const startX = h.player.position.x;
      const startZ = h.player.position.z;
      let sawAirborne = false;
      for (let frame = 0; frame < 400; frame += 1) {
        h.frame(frame % 30 === 0 ? { ...heading, jumpPressed: true } : heading);
        const { x, z, y } = h.player.position;
        if (!h.player.grounded) sawAirborne = true;
        // Never past the inner face of the barrier, so never outside the play area.
        expect(x).toBeGreaterThanOrEqual(area.minX + PLAYER.radius - 1e-6);
        expect(x).toBeLessThanOrEqual(area.maxX - PLAYER.radius + 1e-6);
        expect(z).toBeGreaterThanOrEqual(area.minZ + PLAYER.radius - 1e-6);
        expect(z).toBeLessThanOrEqual(area.maxZ - PLAYER.radius + 1e-6);
        // ...and the height always holds too.
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(PLAYER.height);
        // Sanity: the loop is moving the player, not testing a frozen body.
        expect(Math.abs(x - startX) + Math.abs(z - startZ)).toBeGreaterThan(0);
      }
      expect(sawAirborne).toBe(true);
    }
  });

  it('pauses the arc instead of dropping the player when the world stops', () => {
    const h = harness();
    h.frame(snapshot({ jumpPressed: true }));
    // Past the apex, so the arc is on its way down when the pause starts.
    for (let frame = 0; frame < 25; frame += 1) h.frame();
    const heightBeforePause = h.player.position.y;
    expect(heightBeforePause).toBeGreaterThan(0);
    expect(h.player.velocity.y).toBeLessThan(0);

    // No input is what a non-playing frame passes in (see Game.update).
    for (let frame = 0; frame < 120; frame += 1) h.step(STEP, null);
    expect(h.player.position.y).toBeCloseTo(heightBeforePause, 9);

    // ...and the arc resumes from there when play continues.
    h.frame();
    expect(h.player.position.y).toBeLessThan(heightBeforePause);
  });
});

describe('the air poses', () => {
  it('reports rise, then hang, then land', () => {
    const h = harness();
    h.frame(snapshot({ jumpPressed: true }));
    expect(h.player.jumpPhase).toBe('rise');

    // Climb until the upward speed falls to the apex threshold.
    const climbFrames = Math.ceil((PLAYER.jumpSpeed - PLAYER.jumpApexSpeed) / (PLAYER.gravity * STEP));
    for (let frame = 1; frame < climbFrames; frame += 1) h.frame();
    expect(h.player.jumpPhase).toBe('hang');

    // Down and landed: the landing pose owns the body for a moment, then lets go.
    while (!h.player.grounded) h.frame();
    expect(h.player.jumpPhase).toBe('land');
    const landFrames = Math.ceil(PLAYER.landSeconds / STEP) + 2;
    for (let frame = 0; frame < landFrames; frame += 1) h.frame();
    expect(h.player.jumpPhase).toBeNull();
  });

  it('reports the jump and the landing exactly once each, and never on a plain walk', () => {
    const h = harness();
    const walk = snapshot({ forward: 1 });

    // Walking reports nothing, however long it goes on.
    for (let frame = 0; frame < 60; frame += 1) {
      h.frame(walk);
      expect(h.player.consumeMotionEvents()).toEqual({ jumped: false, landed: false });
    }

    h.frame({ ...walk, jumpPressed: true });
    expect(h.player.consumeMotionEvents()).toEqual({ jumped: true, landed: false });
    // Read once: a frame that consumed the report cannot report it a second time.
    expect(h.player.consumeMotionEvents()).toEqual({ jumped: false, landed: false });

    let jumps = 0;
    let landings = 0;
    while (!h.player.grounded) {
      h.frame(walk);
      const events = h.player.consumeMotionEvents();
      if (events.jumped) jumps += 1;
      if (events.landed) landings += 1;
    }
    expect(jumps).toBe(0);
    expect(landings).toBe(1);

    // And nothing fires on the frames after the arc is over.
    for (let frame = 0; frame < 60; frame += 1) {
      h.frame(walk);
      expect(h.player.consumeMotionEvents()).toEqual({ jumped: false, landed: false });
    }
  });
});

describe('the vertical step on its own', () => {
  it('lands a launched body on the ground and never below it', () => {
    let state = { height: 0, speed: PLAYER.jumpSpeed, grounded: false };
    let peak = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      state = stepVertical(state, PLAYER.gravity, STEP);
      peak = Math.max(peak, state.height);
      expect(state.height).toBeGreaterThanOrEqual(0);
      if (state.grounded) break;
    }
    expect(state.grounded).toBe(true);
    expect(state.height).toBe(0);
    expect(state.speed).toBe(0);
    expect(peak).toBeGreaterThan(0.5 * jumpPeakHeight(PLAYER.jumpSpeed, PLAYER.gravity));
  });

  it('reports a landing only on the step that ends a fall', () => {
    let state = { height: 0, speed: 0, grounded: true };
    for (let frame = 0; frame < 60; frame += 1) {
      const result = stepVertical(state, PLAYER.gravity, STEP);
      state = result;
      expect(result.landed).toBe(false);
      expect(result.height).toBe(0);
      expect(result.grounded).toBe(true);
    }

    const falling = stepVertical({ height: 0.05, speed: -3, grounded: false }, PLAYER.gravity, STEP);
    expect(falling.landed).toBe(true);
    expect(falling.grounded).toBe(true);
    expect(falling.impactSpeed).toBeGreaterThan(0);
  });

  it('describes the arc from the tuning values', () => {
    expect(jumpPeakHeight(6, 20)).toBeCloseTo(0.9, 9);
    expect(jumpAirTime(6, 20)).toBeCloseTo(0.6, 9);
    // Degenerate inputs answer instead of producing NaN or Infinity.
    expect(jumpPeakHeight(6, 0)).toBe(0);
    expect(jumpAirTime(6, 0)).toBe(0);
  });
});
