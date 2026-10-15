import { describe, expect, it } from 'vitest';
import { createPathBuffers, findPath, isWalkable, type PathGrid } from '../src/zombies/pathfinding';

function makeGrid(width: number, height: number, blocked: Array<[number, number]> = []): PathGrid {
  const cells = new Uint8Array(width * height).fill(1);
  for (const [x, z] of blocked) cells[z * width + x] = 0;
  return { width, height, cells };
}

const out: Array<{ x: number; z: number }> = [];

/** Total distance walked along a grid path, starting from the (excluded) start cell. */
function travelledDistance(path: Array<{ x: number; z: number }>, start: { x: number; z: number }): number {
  let total = 0;
  let previous = start;
  for (const cell of path) {
    total += Math.hypot(cell.x - previous.x, cell.z - previous.z);
    previous = cell;
  }
  return total;
}

describe('findPath', () => {
  it('walks straight across an empty grid', () => {
    const grid = makeGrid(20, 20);
    const buffers = createPathBuffers(grid.width, grid.height);
    const path = findPath(grid, buffers, { startX: 2, startZ: 2, goalX: 10, goalZ: 2 }, out);
    expect(path).not.toBeNull();
    expect(path?.length).toBe(8);
    // Path excludes the start cell and ends exactly on the goal.
    expect(path?.[path.length - 1]).toEqual({ x: 10, z: 2 });
  });

  it('routes around an obstacle instead of through it', () => {
    const blocked: Array<[number, number]> = [];
    // A wall with a single gap at z = 0.
    for (let z = 0; z < 12; z += 1) {
      if (z === 4) continue;
      blocked.push([5, z]);
    }
    const grid = makeGrid(16, 16, blocked);
    const buffers = createPathBuffers(grid.width, grid.height);
    const path = findPath(grid, buffers, { startX: 1, startZ: 1, goalX: 12, goalZ: 1 }, out);

    expect(path).not.toBeNull();
    for (const cell of path ?? []) {
      expect(isWalkable(grid, cell.x, cell.z)).toBe(true);
      expect(grid.cells[cell.z * grid.width + cell.x]).toBe(1);
    }
    // It has to use the single gap in the wall.
    expect(path?.some((cell) => cell.x === 5 && cell.z === 4)).toBe(true);

    // Diagonal steps mean the detour has the same *step count* as a straight
    // run (11), so the meaningful check is travelled distance: the route goes
    // up to z = 4 and back, making it longer than the 11 m straight line.
    const travelled = travelledDistance(path ?? [], { x: 1, z: 1 });
    expect(travelled).toBeGreaterThan(11);
  });

  it('returns null when the goal is walled off', () => {
    const blocked: Array<[number, number]> = [];
    for (let z = 0; z < 12; z += 1) blocked.push([5, z]);
    const grid = makeGrid(12, 12, blocked);
    const buffers = createPathBuffers(grid.width, grid.height);
    expect(findPath(grid, buffers, { startX: 1, startZ: 1, goalX: 10, goalZ: 1 }, out)).toBeNull();
  });

  it('returns null when the start or goal is blocked', () => {
    const grid = makeGrid(8, 8, [[3, 3]]);
    const buffers = createPathBuffers(grid.width, grid.height);
    expect(findPath(grid, buffers, { startX: 3, startZ: 3, goalX: 5, goalZ: 5 }, out)).toBeNull();
    expect(findPath(grid, buffers, { startX: 1, startZ: 1, goalX: 3, goalZ: 3 }, out)).toBeNull();
  });

  it('gives up instead of running forever when the node budget is tiny', () => {
    const grid = makeGrid(60, 60);
    const buffers = createPathBuffers(grid.width, grid.height);
    const path = findPath(grid, buffers, { startX: 0, startZ: 0, goalX: 59, goalZ: 59, maxNodes: 5 }, out);
    expect(path).toBeNull();
  });

  it('refuses a diagonal squeeze when both orthogonal cells are blocked', () => {
    const grid = makeGrid(6, 6, [[1, 0], [0, 1]]);
    const buffers = createPathBuffers(grid.width, grid.height);
    // The only geometric route is the diagonal (0,0)->(1,1), which would slip
    // between two blocked cells. There is no legal route, so A* must fail
    // rather than cheat through the corner.
    const path = findPath(grid, buffers, { startX: 0, startZ: 0, goalX: 1, goalZ: 1 }, out);
    expect(path).toBeNull();
  });

  it('takes the two-step legal route instead of a one-step diagonal cut', () => {
    const grid = makeGrid(6, 6, [[1, 0]]);
    const buffers = createPathBuffers(grid.width, grid.height);
    const path = findPath(grid, buffers, { startX: 0, startZ: 0, goalX: 1, goalZ: 1 }, out);
    expect(path).toEqual([{ x: 0, z: 1 }, { x: 1, z: 1 }]);
  });

  it('finds a one-cell path when the goal is adjacent', () => {
    const grid = makeGrid(6, 6);
    const buffers = createPathBuffers(grid.width, grid.height);
    const path = findPath(grid, buffers, { startX: 2, startZ: 2, goalX: 3, goalZ: 2 }, out);
    expect(path).toEqual([{ x: 3, z: 2 }]);
  });
});
