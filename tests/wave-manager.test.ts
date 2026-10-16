import { describe, expect, it } from 'vitest';
import { WAVES, waveActiveCap, waveComposition, waveTotalCount, type ZombieKind } from '../src/app/gameConfig';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import { WaveManager, type ZombieSpawner, type WaveContext } from '../src/systems/WaveManager';
import { SeededRandom } from '../src/utils/math';
import { NavigationGrid } from '../src/zombies/NavigationGrid';

/**
 * A real navigation grid with every cell walkable.
 *
 * The wave director takes the grid itself rather than a walkability predicate: placing a
 * zombie now also checks that its cell is connected to the player, and the last-resort
 * search reads the grid's cells.
 */
function openGrid(walkable = true): NavigationGrid {
  const grid = new NavigationGrid({ minX: -60, maxX: 60, minZ: -60, maxZ: 60 });
  if (walkable) grid.grid.cells.fill(1);
  return grid;
}

/** Spawner stub: records spawns, exposes a live count the test drives. */
class FakeSpawner implements ZombieSpawner {
  readonly spawned: Array<{ kind: ZombieKind; x: number; z: number }> = [];
  alive = 0;
  maxActive = 99;

  spawn(kind: ZombieKind, x: number, z: number): unknown {
    if (this.alive >= this.maxActive) return null;
    this.spawned.push({ kind, x, z });
    this.alive += 1;
    return { kind };
  }

  get count(): number {
    return this.alive;
  }
}

function makeHarness(seed = 7) {
  const events = new EventBus<GameEvents>();
  const spawner = new FakeSpawner();
  const random = new SeededRandom(seed);
  const manager = new WaveManager({ events, spawner, random, activeCap: WAVES.maxActive });
  const context: WaveContext = {
    playerX: 0,
    playerZ: 0,
    playerYaw: 0,
    surface: openGrid(),
  };
  return { events, spawner, manager, context };
}

/** Runs the manager in fixed steps, returning elapsed simulated seconds. */
function advance(manager: WaveManager, context: WaveContext, seconds: number): number {
  const step = 1 / 30;
  let elapsed = 0;
  while (elapsed < seconds) {
    manager.update(step, context);
    elapsed += step;
  }
  return elapsed;
}

/** Runs until every zombie of the current wave has been spawned. */
function spawnWholeWave(manager: WaveManager, context: WaveContext, spawner: FakeSpawner, wave: number): void {
  const total = waveTotalCount(wave);
  let guard = 0;
  while (spawner.spawned.length < total && guard < 5000) {
    manager.update(1 / 30, context);
    guard += 1;
  }
  expect(spawner.spawned.length).toBe(total);
}

describe('wave definition helpers', () => {
  it('grows the count per wave and respects the ceiling', () => {
    expect(waveTotalCount(1)).toBe(WAVES.baseCount);
    expect(waveTotalCount(2)).toBe(WAVES.baseCount + WAVES.countPerWave);
    expect(waveTotalCount(100)).toBe(WAVES.maxCountPerWave);
  });

  it('keeps the composition shares summing to the requested total', () => {
    for (const wave of [1, 2, 3, 6, 12]) {
      const total = waveTotalCount(wave);
      const composition = waveComposition(wave, total);
      expect(composition.walker + composition.runner + composition.tank).toBe(total);
    }
  });

  it('holds back runners and tanks until their unlock waves', () => {
    const early = waveComposition(1, 20);
    expect(early.runner).toBe(0);
    expect(early.tank).toBe(0);
    const later = waveComposition(8, 40);
    expect(later.runner).toBeGreaterThan(0);
    expect(later.tank).toBeGreaterThan(0);
  });

  it('raises the active cap per wave but never past the world cap', () => {
    expect(waveActiveCap(1)).toBe(WAVES.maxActive);
    expect(waveActiveCap(5)).toBeGreaterThan(waveActiveCap(1));
    expect(waveActiveCap(100)).toBeLessThanOrEqual(26);
  });
});

describe('WaveManager', () => {
  it('does nothing before start()', () => {
    const { manager, spawner, context } = makeHarness();
    advance(manager, context, 30);
    expect(spawner.spawned.length).toBe(0);
    expect(manager.currentWave).toBe(0);
  });

  it('starts the first wave only after the configured delay', () => {
    const { manager, context, spawner } = makeHarness();
    manager.start();
    advance(manager, context, WAVES.firstWaveDelay - 1);
    expect(manager.currentWave).toBe(0);
    advance(manager, context, 2.5);
    expect(manager.currentWave).toBe(1);
    expect(spawner.spawned.length).toBeGreaterThan(0);
  });

  it('announces each wave with its composition', () => {
    const { manager, events, context } = makeHarness();
    const announcements: number[] = [];
    events.on('wave:started', ({ wave, total }) => {
      announcements.push(wave);
      expect(total).toBeGreaterThan(0);
    });
    manager.start();
    advance(manager, context, WAVES.firstWaveDelay + 1);
    expect(announcements).toEqual([1]);
  });

  it('never exceeds the active zombie cap even when the wave is bigger', () => {
    const { manager, spawner, context } = makeHarness();
    manager.setActiveCap(4);
    manager.start();
    advance(manager, context, 60);
    expect(spawner.alive).toBeLessThanOrEqual(4);
    expect(spawner.maxActive).toBeLessThanOrEqual(4);
  });

  it('spawns the whole wave eventually when zombies keep dying', () => {
    const { manager, spawner, context } = makeHarness();
    manager.start();
    let guard = 0;
    while (spawner.spawned.length < waveTotalCount(1) && guard < 4000) {
      manager.update(1 / 30, context);
      // Simulate the player killing everything instantly so spawning continues.
      spawner.alive = 0;
      guard += 1;
    }
    expect(spawner.spawned.length).toBe(waveTotalCount(1));
  });

  it('keeps the wave open while a straggler is alive', () => {
    const { manager, spawner, context, events } = makeHarness();
    const cleared: number[] = [];
    events.on('wave:cleared', ({ wave }) => cleared.push(wave));
    manager.start();
    spawnWholeWave(manager, context, spawner, 1);

    spawner.alive = 1;
    advance(manager, context, WAVES.clearSettleSeconds * 4);
    expect(cleared.length).toBe(0);
    expect(manager.currentPhase).toBe('clearing');
  });

  it('clears the wave only after the live count stays at zero for the settle time', () => {
    const { manager, spawner, context, events } = makeHarness();
    const cleared: number[] = [];
    events.on('wave:cleared', ({ wave }) => cleared.push(wave));
    manager.start();
    spawnWholeWave(manager, context, spawner, 1);

    // Everything dead, but not for long enough yet.
    spawner.alive = 0;
    manager.update(1 / 30, context);
    advance(manager, context, WAVES.clearSettleSeconds * 0.5);
    expect(cleared.length).toBe(0);

    // Past the settle window the wave is declared clear.
    advance(manager, context, WAVES.clearSettleSeconds + 0.5);
    expect(cleared).toContain(1);
    expect(manager.currentPhase).toBe('break');
  });

  it('starts the next wave after the break and scales the count', () => {
    const { manager, spawner, context, events } = makeHarness();
    const cleared: number[] = [];
    events.on('wave:cleared', ({ wave }) => cleared.push(wave));
    manager.start();

    spawnWholeWave(manager, context, spawner, 1);
    spawner.alive = 0;
    let guard = 0;
    while (cleared.length === 0 && guard < 20000) {
      manager.update(1 / 30, context);
      spawner.alive = 0;
      guard += 1;
    }
    expect(cleared).toEqual([1]);

    advance(manager, context, WAVES.breakSeconds + 1);
    expect(manager.currentWave).toBe(2);
  });

  it('requests spawn points away from the player', () => {
    const { manager, spawner, context } = makeHarness();
    context.playerX = 0;
    context.playerZ = 0;
    manager.start();
    advance(manager, context, WAVES.firstWaveDelay + 12);
    expect(spawner.spawned.length).toBeGreaterThan(0);
    for (const spawn of spawner.spawned) {
      expect(Math.hypot(spawn.x - context.playerX, spawn.z - context.playerZ)).toBeGreaterThanOrEqual(WAVES.minSpawnDistance);
    }
  });

  it('retries instead of dropping a zombie when no valid spawn point exists', () => {
    const { manager, spawner, context } = makeHarness();
    let allowSpawn = false;
    // Toggling walkability is now a matter of clearing the grid's cells: with nothing
    // walkable the picker (including its last-resort search) has nothing to offer.
    context.surface = openGrid(allowSpawn);
    manager.start();
    advance(manager, context, WAVES.firstWaveDelay + 5);
    expect(spawner.spawned.length).toBe(0);
    // The wave is still pending; enabling walkable cells resumes it.
    allowSpawn = true;
    // A grid is a snapshot, not a live predicate: the toggle has to hand over a new one.
    context.surface = openGrid(true);
    advance(manager, context, 20);
    expect(spawner.spawned.length).toBeGreaterThan(0);
  });

  it('reset returns to a clean pre-run state', () => {
    const { manager, context, spawner } = makeHarness();
    manager.start();
    advance(manager, context, WAVES.firstWaveDelay + 5);
    expect(spawner.spawned.length).toBeGreaterThan(0);
    manager.reset();
    expect(manager.currentWave).toBe(0);
    expect(manager.currentPhase).toBe('idle');
    const before = spawner.spawned.length;
    advance(manager, context, 10);
    expect(spawner.spawned.length).toBe(before);
  });
});
