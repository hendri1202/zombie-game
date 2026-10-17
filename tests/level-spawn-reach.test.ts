import { describe, expect, it } from 'vitest';
import { buildLevelWorld, type LevelWorld } from './helpers/levelWorld';
import { PLAYER, WAVES, WORLD, ZOMBIE_AI } from '../src/app/gameConfig';
import { MAX_SPAWN_DISTANCE, pickNearbySpawnPoint, pickSpawnPoint } from '../src/level/SpawnPoints';
import { SeededRandom } from '../src/utils/math';

/**
 * Guards on where the horde is allowed to appear.
 *
 * Measured on the shipped block before these rules: a third of the sampled placements landed
 * further from the player than a zombie can notice them from, the farthest 73 m out, and a
 * browser run showed eight zombies alive with one engaged and the last of them 105 m away.
 * Those zombies wander their own spawn point for the rest of the wave: the HUD says enemies
 * remain, nothing arrives, and the run only continues when the 25-second straggler recall
 * moves them by hand. That is the "game stuck in the middle of the road" report.
 *
 * The recall has the mirror-image failure: it placed nobody at all whenever the player stood
 * somewhere the (0.45 m inflated) nav grid called blocked, which is 1.5% of the spots a
 * 0.42 m player body fits in — and it is the last line of defence for a wave.
 */

let cachedWorld: Promise<LevelWorld> | null = null;
const world = (): Promise<LevelWorld> => (cachedWorld ??= buildLevelWorld());

/** Player positions the horde is placed from: the spawn plus a spread across the block. */
const PLAYER_SPOTS: Array<[number, number]> = [
  [PLAYER.spawn.x, PLAYER.spawn.z],
  [0, 40], [0, -40], [30, 0], [-30, 0],
  [12, 12], [-12, -12], [40, 40], [-40, -40],
  [9.6, 30], [-9.6, -30], [50, 5], [-50, -5],
];

describe('the horde is placed where it can find the player', () => {
  it('never places a zombie further than it can notice the player from', async () => {
    const { grid } = await world();
    const worst: Array<{ spot: string; distance: number }> = [];
    let samples = 0;
    let beyondSense = 0;

    for (const [px, pz] of PLAYER_SPOTS) {
      const random = new SeededRandom(Math.round(px * 31 + pz * 17) + 7);
      for (let i = 0; i < 40; i += 1) {
        const point = pickSpawnPoint({ playerX: px, playerZ: pz, playerYaw: 0.5, grid, random });
        expect(point, `no spawn point from (${px}, ${pz})`).not.toBeNull();
        if (!point) continue;
        samples += 1;
        if (point.distance > MAX_SPAWN_DISTANCE) {
          beyondSense += 1;
          worst.push({ spot: `(${px}, ${pz})`, distance: Number(point.distance.toFixed(1)) });
        }
      }
    }

    expect(samples).toBeGreaterThan(400);
    expect(worst.slice(0, 5)).toEqual([]);
    expect(beyondSense).toBe(0);
  });

  it('keeps the placement at least the configured distance from the player', async () => {
    const { grid } = await world();
    for (const [px, pz] of PLAYER_SPOTS) {
      const random = new SeededRandom(Math.round(px * 13 - pz * 29) + 3);
      for (let i = 0; i < 20; i += 1) {
        const point = pickSpawnPoint({ playerX: px, playerZ: pz, playerYaw: 0, grid, random });
        if (!point) continue;
        // The block has room everywhere, so the fallback that accepts a closer point never
        // applies here: every placement has to respect the minimum the config asks for.
        expect(point.distance, `from (${px}, ${pz})`).toBeGreaterThanOrEqual(WAVES.minSpawnDistance - 1e-6);
      }
    }
  });

  it('places every zombie in a region the player can walk into', async () => {
    const { grid } = await world();
    for (const [px, pz] of PLAYER_SPOTS) {
      const random = new SeededRandom(Math.round(px * 7 + pz * 5) + 11);
      for (let i = 0; i < 20; i += 1) {
        const point = pickSpawnPoint({ playerX: px, playerZ: pz, playerYaw: 0, grid, random });
        if (!point) continue;
        expect(grid.isWalkableWorld(point.x, point.z), `(${point.x}, ${point.z})`).toBe(true);
        const playerRegion = grid.componentAt(px, pz);
        const region = playerRegion >= 0 ? playerRegion : grid.largestComponent;
        expect(grid.componentAt(point.x, point.z), `from (${px}, ${pz})`).toBe(region);
      }
    }
  });
});

describe('the recall can always bring a straggler back', () => {
  it('finds a point from a spot the nav grid calls blocked', async () => {
    const { collision, grid } = await world();
    // Somewhere the player body fits but the zombie-radius grid does not: a shoulder against
    // a wall or a prop. There are hundreds of these on the block, and standing in one used to
    // make the recall place nobody, every time, so a stalled wave could never be unstuck.
    const spots: Array<[number, number]> = [];
    for (let x = WORLD.playArea.minX + 4; x <= WORLD.playArea.maxX - 4 && spots.length < 6; x += 0.5) {
      for (let z = WORLD.playArea.minZ + 4; z <= WORLD.playArea.maxZ - 4; z += 0.5) {
        if (collision.isCircleBlocked(x, z, PLAYER.radius)) continue;
        if (grid.isWalkableWorld(x, z)) continue;
        spots.push([x, z]);
        break;
      }
    }
    expect(spots.length).toBeGreaterThan(0);

    for (const [px, pz] of spots) {
      const point = pickNearbySpawnPoint({
        playerX: px,
        playerZ: pz,
        grid,
        random: new SeededRandom(17),
        minDistance: WAVES.recallMinDistance,
        maxDistance: WAVES.recallMaxDistance,
      });
      expect(point, `no recall point from (${px.toFixed(1)}, ${pz.toFixed(1)})`).not.toBeNull();
      if (!point) continue;
      // It still has to be a point a zombie can stand on and walk from.
      expect(grid.isWalkableWorld(point.x, point.z), `(${point.x}, ${point.z})`).toBe(true);
      expect(grid.largestComponent).toBe(grid.componentAt(point.x, point.z));
    }
  });

  it('finds a point from every spot a player can stand in', async () => {
    const { collision, grid } = await world();
    const random = new SeededRandom(5150);
    let checked = 0;
    for (let i = 0; i < 300; i += 1) {
      const px = random.range(WORLD.playArea.minX + 2, WORLD.playArea.maxX - 2);
      const pz = random.range(WORLD.playArea.minZ + 2, WORLD.playArea.maxZ - 2);
      // Only positions the player could actually be standing in.
      if (collision.isCircleBlocked(px, pz, PLAYER.radius)) continue;
      checked += 1;
      const point = pickNearbySpawnPoint({
        playerX: px,
        playerZ: pz,
        playerYaw: 0,
        grid,
        random: new SeededRandom(i + 1),
        minDistance: WAVES.recallMinDistance,
        maxDistance: WAVES.recallMaxDistance,
      });
      expect(point, `no recall point from (${px.toFixed(1)}, ${pz.toFixed(1)})`).not.toBeNull();
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('places the recalled zombie in the ring around the player, not on the far side of the map', async () => {
    const { grid } = await world();
    const random = new SeededRandom(99);
    let inside = 0;
    for (let i = 0; i < 60; i += 1) {
      const point = pickNearbySpawnPoint({
        playerX: PLAYER.spawn.x,
        playerZ: PLAYER.spawn.z,
        grid,
        random,
        minDistance: WAVES.recallMinDistance,
        maxDistance: WAVES.recallMaxDistance,
      });
      expect(point).not.toBeNull();
      if (!point) continue;
      if (point.distance >= WAVES.recallMinDistance - 1e-6 && point.distance <= WAVES.recallMaxDistance + 1e-6) {
        inside += 1;
      }
    }
    expect(inside).toBe(60);
  });

  it('spawns only inside the distance a zombie senses the player from, on this map', async () => {
    // The two numbers this whole file leans on, asserted against the config rather than
    // hard-coded, so a tuning change that breaks the reasoning is visible.
    expect(MAX_SPAWN_DISTANCE).toBe(ZOMBIE_AI.sightRange);
    expect(MAX_SPAWN_DISTANCE).toBeLessThan(ZOMBIE_AI.maxTargetRange);
    expect(MAX_SPAWN_DISTANCE).toBeGreaterThan(WAVES.minSpawnDistance);
  });
});
