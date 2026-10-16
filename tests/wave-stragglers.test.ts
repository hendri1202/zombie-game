import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/EventBus';
import { WaveManager, type ZombieSpawner } from '../src/systems/WaveManager';
import { WAVES } from '../src/app/gameConfig';
import { SeededRandom } from '../src/utils/math';
import type { GameEvents } from '../src/app/GameEvents';
import { NavigationGrid } from '../src/zombies/NavigationGrid';

/** A grid with everything walkable and one connected region: the happy path. */
function openGrid(): NavigationGrid {
  const grid = new NavigationGrid({ minX: -60, maxX: 60, minZ: -60, maxZ: 60 });
  grid.grid.cells.fill(1);
  return grid;
}

/**
 * A spawner that always succeeds and can be made to hold zombies alive forever, which is
 * the shape of the stall: zombies counted as remaining that the player cannot reach.
 */
class StubSpawner implements ZombieSpawner {
  count = 0;
  maxActive = 12;
  spawned = 0;
  recalls = 0;
  /** When true, spawned zombies never die, so the wave can never clear. */
  holdAlive = true;

  spawn(): unknown {
    if (this.holdAlive) this.count += 1;
    this.spawned += 1;
    return {};
  }

  recallNear(): number {
    this.recalls += 1;
    return 1;
  }
}

class SilentSpawner implements ZombieSpawner {
  count = 1;
  maxActive = 12;
  spawn(): unknown { return {}; }
}

const context = () => ({
  playerX: 0, playerZ: 0, playerYaw: 0,
  surface: openGrid(),
});

function runUntilPhase(
  manager: WaveManager, phase: string, spawner: StubSpawner, seconds = 120,
): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) {
    manager.update(0.1, context());
    if (manager.currentPhase === phase && spawner.spawned > 0) return;
  }
}

describe('wave straggler watchdog', () => {
  it('asks the spawner to bring unreachable zombies back when a wave will not clear', () => {
    const events = new EventBus<GameEvents>();
    const spawner = new StubSpawner();
    const manager = new WaveManager({
      events, spawner, random: new SeededRandom(21), activeCap: 12,
      availableKinds: ['walker'],
    });
    const recalls: number[] = [];
    events.on('wave:stragglers-recalled', ({ moved }) => recalls.push(moved));

    manager.start();
    runUntilPhase(manager, 'clearing', spawner);
    expect(manager.currentPhase).toBe('clearing');
    expect(spawner.recalls).toBe(0);

    // Just under the threshold: the wave is still allowed to sort itself out.
    for (let elapsed = 0; elapsed < WAVES.stragglerRecallSeconds - 1; elapsed += 0.1) {
      manager.update(0.1, context());
    }
    expect(spawner.recalls).toBe(0);

    // Past it, the stragglers are recalled rather than the run sitting there forever.
    for (let elapsed = 0; elapsed < 2; elapsed += 0.1) manager.update(0.1, context());
    expect(spawner.recalls).toBe(1);
    expect(recalls).toEqual([1]);

    // And it does not loop: a broken map gets a bounded number of attempts per wave.
    for (let elapsed = 0; elapsed < 400; elapsed += 0.1) manager.update(0.1, context());
    expect(spawner.recalls).toBeLessThanOrEqual(WAVES.maxStragglerRecalls);
  });

  it('leaves a cleared wave alone and starts the next one', () => {
    const events = new EventBus<GameEvents>();
    const spawner = new StubSpawner();
    spawner.holdAlive = false;   // spawned zombies count as dead immediately
    const manager = new WaveManager({
      events, spawner, random: new SeededRandom(4), activeCap: 12, availableKinds: ['walker'],
    });
    let cleared = 0;
    events.on('wave:cleared', () => { cleared += 1; });
    manager.start();
    for (let elapsed = 0; elapsed < 60; elapsed += 0.1) manager.update(0.1, context());
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(spawner.recalls).toBe(0);
    expect(manager.currentWave).toBeGreaterThanOrEqual(1);
  });

  it('works with a spawner that does not implement recall at all', () => {
    const events = new EventBus<GameEvents>();
    const manager = new WaveManager({
      events, spawner: new SilentSpawner(), random: new SeededRandom(8), activeCap: 12,
      availableKinds: ['walker'],
    });
    manager.start();
    // A stub without recallNear must not throw; it simply has no way to help.
    for (let elapsed = 0; elapsed < WAVES.stragglerRecallSeconds * 2; elapsed += 0.1) {
      manager.update(0.1, context());
    }
    expect(manager.currentPhase).toBe('clearing');
  });
});
