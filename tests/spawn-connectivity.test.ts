import { describe, expect, it } from 'vitest';
import { NavigationGrid } from '../src/zombies/NavigationGrid';
import { pickNearbySpawnPoint, pickSpawnPoint } from '../src/level/SpawnPoints';
import { SeededRandom } from '../src/utils/math';

/**
 * A grid with two walkable regions separated by a blocked column, the shape that broke
 * spawning: a pocket of the blockout that is walkable but unreachable.
 *
 * Left region (x < 9) is small, right region (x > 10) is large — so random sampling
 * hits the unreachable one far more often than the reachable one, which is exactly the
 * case where walkability alone gives the wrong answer.
 */
function twoRegionGrid(): NavigationGrid {
  // Default cell size: the constructor's parameter is typed to NAV.cellSize's literal.
  const grid = new NavigationGrid({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
  const { width, height, cells } = grid.grid;
  cells.fill(0);
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 9 || x === 10) continue; // the sealed wall
      cells[z * width + x] = 1;
    }
  }
  return grid;
}

/** A grid where the player's own region is only a few cells. */
function pocketGrid(): NavigationGrid {
  const grid = new NavigationGrid({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
  const { width, height, cells } = grid.grid;
  cells.fill(0);
  // Big region on the far right.
  for (let z = 0; z < height; z += 1) {
    for (let x = 30; x < width; x += 1) cells[z * width + x] = 1;
  }
  // Tiny pocket at the origin, where the player stands.
  for (let z = 19; z <= 21; z += 1) {
    for (let x = 19; x <= 21; x += 1) cells[z * width + x] = 1;
  }
  return grid;
}

describe('navigation connectivity', () => {
  it('labels walkable cells by the region they belong to', () => {
    const grid = twoRegionGrid();
    expect(grid.componentCount).toBe(2);
    // The wall sits on grid columns 9 and 10, which is world x -11..-9.
    expect(grid.componentAt(-15, 0)).toBe(grid.componentAt(-18, 10));
    expect(grid.componentAt(-15, 0)).not.toBe(grid.componentAt(0, 0));
    expect(grid.isConnectedWorld(-15, 0, 0, 0)).toBe(false);
    expect(grid.isConnectedWorld(-15, 0, -18, 5)).toBe(true);
    // A blocked cell belongs to no region at all.
    expect(grid.componentAt(-10, 0)).toBe(-1);
    expect(grid.isConnectedWorld(-10, 0, -15, 0)).toBe(false);
    // The larger region is reported as the main one, with its size.
    expect(grid.componentSize(grid.largestComponent)).toBeGreaterThan(grid.componentSize(0));
  });

  it('invalidates the regions when the grid is rebuilt', () => {
    const grid = twoRegionGrid();
    expect(grid.componentCount).toBe(2);
    grid.grid.cells.fill(0);
    // The cache is only dropped by a rebuild; the test reaches into the grid the same way
    // rebuild does, so the count stays stale until then — which is the point of the guard.
    grid.rebuild({ isCircleBlocked: () => false } as never, 0.4);
    expect(grid.componentCount).toBe(1);
  });
});

describe('spawning inside the player’s own region', () => {
  it('never returns a point the player cannot walk to', () => {
    const grid = twoRegionGrid();
    const random = new SeededRandom(11);
    // Inside the small left region; the unreachable one is the big right region.
    const playerX = -15;
    const playerZ = 4;
    // The unreachable region here is the bigger one, so a rule-less sampler would pick it
    // most of the time and the wave would strand its zombies.
    let inside = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const point = pickSpawnPoint({
        playerX, playerZ, playerYaw: 0, grid, random,
      });
      expect(point).not.toBeNull();
      if (point) {
        expect(grid.componentAt(point.x, point.z)).toBe(grid.componentAt(playerX, playerZ));
        inside += 1;
      }
    }
    expect(inside).toBe(200);
  });

  it('finds a point even when the player is boxed into a small pocket', () => {
    const grid = pocketGrid();
    const random = new SeededRandom(3);
    // The pocket is 3x3 cells, so nothing in it is minSpawnDistance (18 m) away: the
    // sampler cannot succeed and the fallback has to place the spawn anyway.
    const point = pickSpawnPoint({ playerX: 0, playerZ: 0, playerYaw: 0, grid, random });
    expect(point).not.toBeNull();
    if (point) {
      expect(grid.componentAt(point.x, point.z)).toBe(grid.componentAt(0, 0));
      expect(point.distance).toBeGreaterThan(0);
    }
  });
});

describe('recalling stragglers', () => {
  it('places a recalled zombie in a ring around the player, inside reach', () => {
    const grid = new NavigationGrid({ minX: -60, maxX: 60, minZ: -60, maxZ: 60 });
    grid.grid.cells.fill(1);
    const random = new SeededRandom(5);
    const point = pickNearbySpawnPoint({
      playerX: 0, playerZ: 0, grid, random,
      minDistance: 11,
      maxDistance: 24,
    });
    expect(point).not.toBeNull();
    if (point) {
      expect(point.distance).toBeGreaterThanOrEqual(10.5);
      expect(point.distance).toBeLessThanOrEqual(24.5);
    }
  });

  it('accepts any direction when no facing is given', () => {
    const grid = new NavigationGrid({ minX: -60, maxX: 60, minZ: -60, maxZ: 60 });
    grid.grid.cells.fill(1);
    const point = pickNearbySpawnPoint({
      playerX: 0, playerZ: 0, grid, random: new SeededRandom(9), minDistance: 11, maxDistance: 24,
    });
    expect(point).not.toBeNull();
  });
});
