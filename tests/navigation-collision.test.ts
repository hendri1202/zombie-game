import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../src/level/CollisionWorld';
import { NavigationGrid } from '../src/zombies/NavigationGrid';

function worldWithWall(): CollisionWorld {
  const world = new CollisionWorld({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
  // A 2 m wide wall along X = 0 spanning most of the block.
  world.addCenteredBox(0, 0, 2, 24, 4, 'wall', { blocksPlayer: true, blocksZombies: true });
  return world;
}

describe('CollisionWorld', () => {
  it('pushes a circle out of a box instead of letting it pass through', () => {
    const world = worldWithWall();
    const position = new Vector3(0.2, 0, 0);
    const corrected = world.resolveCircle(position, 0.5);
    expect(corrected).toBe(true);
    // Position must now be outside the wall's X range plus the radius.
    expect(Math.abs(position.x)).toBeGreaterThanOrEqual(0.99);
  });

  it('leaves a circle that is already free untouched', () => {
    const world = worldWithWall();
    const position = new Vector3(8, 0, 0);
    const corrected = world.resolveCircle(position, 0.5);
    expect(corrected).toBe(false);
    expect(position.x).toBe(8);
  });

  it('hits a wall with a raycast and reports the tag and distance', () => {
    const world = worldWithWall();
    const origin = new Vector3(-10, 1.6, 0);
    const direction = new Vector3(1, 0, 0);
    const hit = world.raycast(origin, direction, 50);
    expect(hit).not.toBeNull();
    expect(hit?.tag).toBe('wall');
    expect(hit?.distance).toBeCloseTo(9, 1);
  });

  it('misses when the ray points away from every box', () => {
    const world = worldWithWall();
    const hit = world.raycast(new Vector3(-10, 1.6, 0), new Vector3(-1, 0, 0), 50);
    expect(hit).toBeNull();
  });

  it('reports line of sight correctly across a wall', () => {
    const world = worldWithWall();
    // The wall spans z = -12..12, so a line at z = 0 crosses it.
    expect(world.hasLineOfSight(-5, 0, 5, 0)).toBe(false);
    // Outside the wall's Z extent the line is clear.
    expect(world.hasLineOfSight(-5, 15, 5, 15)).toBe(true);
  });

  it('ignores low props when the query is about standing sight lines', () => {
    const world = new CollisionWorld({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
    world.addCenteredBox(0, 0, 4, 4, 0.5, 'pallet', { blocksPlayer: true, blocksZombies: true });
    expect(world.hasLineOfSight(-3, 0, 3, 0)).toBe(true);
  });
});

describe('NavigationGrid', () => {
  it('marks wall cells unwalkable and the rest walkable', () => {
    const world = worldWithWall();
    const grid = new NavigationGrid({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, 1);
    grid.rebuild(world, 0.45);

    // A cell in the middle of the wall is blocked.
    expect(grid.isWalkableWorld(0, 0)).toBe(false);
    // A cell away from the wall is not.
    expect(grid.isWalkableWorld(15, 15)).toBe(true);
    expect(grid.walkableRatio).toBeGreaterThan(0.5);
    expect(grid.walkableRatio).toBeLessThan(1);
  });

  it('finds a route around the wall in world coordinates', () => {
    const world = worldWithWall();
    const grid = new NavigationGrid({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, 1);
    grid.rebuild(world, 0.45);

    const path = grid.findPathWorld(-10, 0, 10, 0);
    expect(path).not.toBeNull();
    // Every waypoint must be walkable, and the route has to leave the wall's Z span.
    for (const point of path ?? []) {
      expect(grid.isWalkableWorld(point.x, point.z)).toBe(true);
    }
    expect((path ?? []).some((point) => Math.abs(point.z) > 12)).toBe(true);
  });

  it('snaps a blocked start position to the nearest walkable cell', () => {
    const world = worldWithWall();
    const grid = new NavigationGrid({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, 1);
    grid.rebuild(world, 0.45);
    const nearest = grid.nearestWalkable(0, 0);
    expect(nearest).not.toBeNull();
    expect(Math.abs(nearest?.x ?? 0)).toBeGreaterThan(1);
  });

  it('returns null when nothing walkable is within reach', () => {
    const world = new CollisionWorld({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 });
    world.addCenteredBox(0, 0, 40, 40, 6, 'everything', { blocksPlayer: true, blocksZombies: true });
    const grid = new NavigationGrid({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 }, 1);
    grid.rebuild(world, 0.45);
    expect(grid.nearestWalkable(0, 0, 2)).toBeNull();
  });
});
