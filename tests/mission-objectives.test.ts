import { describe, expect, it } from 'vitest';
import { PointLight, Scene } from 'three';
import { MISSION } from '../src/app/gameConfig';
import type { GameEvents } from '../src/app/GameEvents';
import { EventBus } from '../src/core/EventBus';
import {
  COMPASS_DIRECTIONS, compassBearing, formatObjectiveInstruction, pickObjectivePoint,
  relativeBearing,
} from '../src/level/ObjectivePoints';
import { MissionObjectives } from '../src/systems/MissionObjectives';
import { SeededRandom } from '../src/utils/math';
import { NavigationGrid } from '../src/zombies/NavigationGrid';

/**
 * Objective placement shares the exact bug class spawning already had: walkable is not the
 * same as reachable. These tests use the same two-region and pocket grids as
 * spawn-connectivity.test.ts, because a marked point in a sealed pocket is a mission the
 * player can never finish — the stall this whole feature has to avoid.
 */

/** Two walkable regions split by a sealed wall; the unreachable right one is the larger. */
function twoRegionGrid(): NavigationGrid {
  const grid = new NavigationGrid({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
  const { width, height, cells } = grid.grid;
  cells.fill(0);
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 9 || x === 10) continue; // the sealed wall, world x -11..-9
      cells[z * width + x] = 1;
    }
  }
  return grid;
}

/** A big walkable region with a tiny pocket at the origin, where the player stands. */
function pocketGrid(): NavigationGrid {
  const grid = new NavigationGrid({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
  const { width, height, cells } = grid.grid;
  cells.fill(0);
  for (let z = 0; z < height; z += 1) {
    for (let x = 30; x < width; x += 1) cells[z * width + x] = 1;
  }
  for (let z = 19; z <= 21; z += 1) {
    for (let x = 19; x <= 21; x += 1) cells[z * width + x] = 1;
  }
  return grid;
}

/** A wide-open grid the size of the play area. */
function openGrid(): NavigationGrid {
  const grid = new NavigationGrid({ minX: -60, maxX: 60, minZ: -60, maxZ: 60 });
  grid.grid.cells.fill(1);
  return grid;
}

describe('picking a marked objective point', () => {
  it('always stays inside the connected region the player stands in, over many draws', () => {
    const grid = twoRegionGrid();
    const random = new SeededRandom(11);
    const playerX = -15;
    const playerZ = 0;
    const playerRegion = grid.componentAt(playerX, playerZ);
    // Sanity: the region the player is in is the *smaller* one, so a rule-less sampler would
    // land in the unreachable region most of the time.
    expect(grid.componentSize(playerRegion)).toBeLessThan(grid.componentSize(grid.largestComponent));

    let connected = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const point = pickObjectivePoint({ playerX, playerZ, grid, random });
      expect(point).not.toBeNull();
      if (!point) continue;
      // Both ways of asking must agree: the same component, and a real walk between them.
      expect(grid.componentAt(point.x, point.z)).toBe(playerRegion);
      expect(grid.isConnectedWorld(playerX, playerZ, point.x, point.z)).toBe(true);
      connected += 1;
    }
    expect(connected).toBe(200);
  });

  it('places the point a meaningful distance away on an open map', () => {
    const grid = openGrid();
    const random = new SeededRandom(3);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const point = pickObjectivePoint({ playerX: 0, playerZ: 0, grid, random });
      expect(point).not.toBeNull();
      if (!point) continue;
      expect(point.distance).toBeGreaterThanOrEqual(MISSION.minDistance);
      expect(point.distance).toBeLessThanOrEqual(MISSION.maxDistance);
    }
  });

  it('never returns the spot the player is standing on', () => {
    const grid = openGrid();
    const random = new SeededRandom(5);
    // With no minimum distance the annulus opens all the way in, so the only thing keeping
    // the point off the player is the clear rule itself.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const point = pickObjectivePoint({
        playerX: 0, playerZ: 0, grid, random, minDistance: 0,
      });
      expect(point).not.toBeNull();
      if (!point) continue;
      expect(point.distance).toBeGreaterThan(MISSION.clearRadius);
    }
  });

  it('honours a custom clear radius', () => {
    const grid = openGrid();
    const random = new SeededRandom(8);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const point = pickObjectivePoint({
        playerX: 0, playerZ: 0, grid, random, minDistance: 0, clearRadius: 20,
      });
      expect(point).not.toBeNull();
      if (!point) continue;
      expect(point.distance).toBeGreaterThan(20);
    }
  });

  it('never returns null when the region is a pocket the player is boxed into', () => {
    const grid = pocketGrid();
    const random = new SeededRandom(4);
    // Nothing in the 3x3 pocket is minDistance (12 m) away, so sampling cannot succeed and
    // the deterministic fallback has to produce a point anyway.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const point = pickObjectivePoint({ playerX: 0, playerZ: 0, grid, random });
      expect(point).not.toBeNull();
      if (!point) continue;
      expect(point.distance).toBeGreaterThan(0);
      expect(grid.componentAt(point.x, point.z)).toBe(grid.componentAt(0, 0));
    }
  });

  it('never returns null on the deterministic path either', () => {
    const grid = openGrid();
    const random = new SeededRandom(9);
    // attempts: 0 disables sampling entirely, so this exercises the whole-region scan on its
    // own — the branch that has to hold when random placement finds nothing.
    const point = pickObjectivePoint({ playerX: 0, playerZ: 0, grid, random, attempts: 0 });
    expect(point).not.toBeNull();
    if (point) {
      expect(point.distance).toBeGreaterThanOrEqual(MISSION.minDistance);
      expect(point.distance).toBeLessThanOrEqual(MISSION.maxDistance);
      expect(grid.componentAt(point.x, point.z)).toBe(grid.componentAt(0, 0));
    }
  });

  it('falls back to the largest region when the player stands on blocked ground', () => {
    const grid = twoRegionGrid();
    const random = new SeededRandom(6);
    // World (-10.5, 0) is on the sealed wall, so the player has no region of their own.
    expect(grid.componentAt(-10.5, 0)).toBe(-1);
    const point = pickObjectivePoint({ playerX: -10.5, playerZ: 0, grid, random });
    expect(point).not.toBeNull();
    if (point) {
      expect(grid.componentAt(point.x, point.z)).toBe(grid.largestComponent);
    }
  });
});

describe('objective HUD formatting', () => {
  it('names all eight compass directions correctly', () => {
    expect(compassBearing(0, 1)).toBe('north');
    expect(compassBearing(1, 1)).toBe('northeast');
    expect(compassBearing(1, 0)).toBe('east');
    expect(compassBearing(1, -1)).toBe('southeast');
    expect(compassBearing(0, -1)).toBe('south');
    expect(compassBearing(-1, -1)).toBe('southwest');
    expect(compassBearing(-1, 0)).toBe('west');
    expect(compassBearing(-1, 1)).toBe('northwest');
    // Every result is one of the eight names, never anything else.
    for (const dx of [-3, 0, 2, 7]) {
      for (const dz of [-5, 0, 1, 9]) {
        if (dx === 0 && dz === 0) continue;
        expect(COMPASS_DIRECTIONS).toContain(compassBearing(dx, dz));
      }
    }
  });

  it('rounds the distance to whole metres', () => {
    expect(formatObjectiveInstruction({ distance: 42.4, bearing: 'northwest' }))
      .toBe('REACH THE MARKER — 42 m northwest');
    expect(formatObjectiveInstruction({ distance: 41.5, bearing: 'east' }))
      .toBe('REACH THE MARKER — 42 m east');
    expect(formatObjectiveInstruction({ distance: 0.2, bearing: 'north' }))
      .toBe('REACH THE MARKER — 0 m north');
    expect(formatObjectiveInstruction({ distance: -5, bearing: 'south' }))
      .toBe('REACH THE MARKER — 0 m south');
  });

  it('measures a bearing relative to where the player faces, clockwise positive', () => {
    // Facing north (+Z): a target due east is 90 degrees to the right.
    expect(relativeBearing(0, 1, 0)).toBeCloseTo(Math.PI / 2, 6);
    // Facing east, that same target is dead ahead.
    expect(relativeBearing(Math.PI / 2, 1, 0)).toBeCloseTo(0, 6);
    // Facing east, a target due north is 90 degrees to the left.
    expect(relativeBearing(Math.PI / 2, 0, 1)).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('wraps the relative bearing into [-pi, pi]', () => {
    // Facing nearly southwest and looking at something 6 rad away: the wrap must report the
    // short way round, not the long one.
    const target = 3.0;
    const dx = Math.sin(target);
    const dz = Math.cos(target);
    const bearing = relativeBearing(-3.0, dx, dz);
    expect(bearing).toBeGreaterThanOrEqual(-Math.PI);
    expect(bearing).toBeLessThanOrEqual(Math.PI);
    expect(bearing).toBeCloseTo(6.0 - Math.PI * 2, 6);
  });
});

describe('MissionObjectives', () => {
  function harness(seed = 7, total?: number) {
    const scene = new Scene();
    const events = new EventBus<GameEvents>();
    const grid = openGrid();
    const random = new SeededRandom(seed);
    const objectives = new MissionObjectives({ scene, events, grid, random, total });
    return { scene, events, grid, objectives };
  }

  /** Runs one full objective: stand on the point, then advance the system one frame. */
  function reachCurrent(
    objectives: MissionObjectives,
  ): { x: number; z: number } {
    const point = objectives.point;
    expect(point).not.toBeNull();
    if (!point) return { x: 0, z: 0 };
    objectives.update(1 / 60, { playerX: point.x, playerZ: point.z });
    return point;
  }

  it('places the first point when the run starts and hides the marker before that', () => {
    const { objectives, events } = harness();
    expect(objectives.point).toBeNull();
    expect(objectives.markerVisible).toBe(false);

    const updates: Array<{ index: number; total: number }> = [];
    events.on('objective:updated', ({ index, total }) => updates.push({ index, total }));

    objectives.start(0, 0);
    expect(objectives.point).not.toBeNull();
    expect(objectives.markerVisible).toBe(true);
    expect(objectives.completed).toBe(0);
    expect(objectives.isComplete).toBe(false);
    expect(updates).toEqual([{ index: 1, total: MISSION.objectiveCount }]);
  });

  it('does not advance while the player is outside the reach radius', () => {
    const { objectives } = harness();
    objectives.start(0, 0);
    const point = objectives.point;
    expect(point).not.toBeNull();
    if (!point) return;
    // Stand on the bearing of the point, just outside the completion radius.
    const bearing = Math.atan2(point.x, point.z);
    const along = point.distance - (MISSION.reachRadius + 0.5);
    const x = Math.sin(bearing) * along;
    const z = Math.cos(bearing) * along;
    objectives.update(1 / 60, { playerX: x, playerZ: z });
    expect(objectives.completed).toBe(0);
    expect(objectives.point).toBe(point);
  });

  it('advances the objective and moves the marker when the player arrives', () => {
    const { objectives, events } = harness();
    const reached: Array<{ completed: number; total: number }> = [];
    const updates: number[] = [];
    events.on('objective:reached', ({ completed, total }) => reached.push({ completed, total }));
    events.on('objective:updated', ({ index }) => updates.push(index));

    objectives.start(0, 0);
    const first = reachCurrent(objectives);

    expect(objectives.completed).toBe(1);
    expect(reached).toEqual([{ completed: 1, total: MISSION.objectiveCount }]);
    // A brand-new point, at least clear of where the player now stands.
    const second = objectives.point;
    expect(second).not.toBeNull();
    if (second) {
      expect(Math.hypot(second.x - first.x, second.z - first.z)).toBeGreaterThan(MISSION.clearRadius);
    }
    expect(updates).toEqual([1, 2]);
  });

  it('completes the mission after eight objectives and never counts past it', () => {
    const { objectives, events } = harness();
    const completes: number[] = [];
    events.on('mission:complete', ({ objectives: count }) => completes.push(count));

    objectives.start(0, 0);
    for (let i = 0; i < MISSION.objectiveCount; i += 1) reachCurrent(objectives);

    expect(objectives.completed).toBe(MISSION.objectiveCount);
    expect(objectives.isComplete).toBe(true);
    expect(objectives.point).toBeNull();
    expect(objectives.markerVisible).toBe(false);
    expect(objectives.remaining).toBe(0);
    expect(completes).toEqual([MISSION.objectiveCount]);

    // Further frames — including another stand on the last point — change nothing.
    objectives.update(1 / 60, { playerX: 0, playerZ: 0 });
    objectives.update(1 / 60, { playerX: 0, playerZ: 0 });
    expect(objectives.completed).toBe(MISSION.objectiveCount);
    expect(completes.length).toBe(1);
  });

  it('reports distance, reach and the HUD instruction from the player position', () => {
    const { objectives } = harness();
    objectives.start(0, 0);
    const point = objectives.point;
    expect(point).not.toBeNull();
    if (!point) return;

    expect(objectives.distanceTo(0, 0)).toBeCloseTo(point.distance, 6);
    expect(objectives.isReached(point.x, point.z)).toBe(true);
    expect(objectives.isReached(0, 0)).toBe(false);

    const instruction = objectives.instructionFrom(0, 0);
    expect(instruction).toMatch(/^REACH THE MARKER — \d+ m /);
    expect(instruction).toContain(compassBearing(point.x, point.z));

    // Once the mission is won there is nothing left to instruct or point at.
    for (let i = 0; i < MISSION.objectiveCount; i += 1) reachCurrent(objectives);
    expect(objectives.instructionFrom(0, 0)).toBe('');
    expect(objectives.distanceTo(0, 0)).toBeNull();
    expect(objectives.bearingFrom(0, 0, 0)).toBeNull();
  });

  it('clears back to the pre-run state on reset', () => {
    const { objectives } = harness();
    objectives.start(0, 0);
    reachCurrent(objectives);
    expect(objectives.completed).toBe(1);
    objectives.reset();
    expect(objectives.completed).toBe(0);
    expect(objectives.isComplete).toBe(false);
    expect(objectives.point).toBeNull();
    expect(objectives.markerVisible).toBe(false);
  });

  it('keeps the reached count when the run ends without a win', () => {
    const { objectives } = harness();
    objectives.start(0, 0);
    reachCurrent(objectives);
    reachCurrent(objectives);
    expect(objectives.completed).toBe(2);

    objectives.stop();
    // The marker is gone, but the run still reached two points and reports so.
    expect(objectives.markerVisible).toBe(false);
    expect(objectives.point).toBeNull();
    expect(objectives.completed).toBe(2);
    expect(objectives.isComplete).toBe(false);
  });

  it('keeps its glow as a permanent scene light, dark when there is nothing to chase', () => {
    const { scene, objectives } = harness();
    // One light in the scene, added up front: a light that appeared with the first objective
    // would change the shader key for every material in view on that frame.
    const lights = scene.children.filter((child) => (child as { isLight?: boolean }).isLight);
    expect(lights.length).toBe(1);
    const light = lights[0] as PointLight;
    expect(light.intensity).toBe(0);

    objectives.start(0, 0);
    objectives.update(1 / 60, { playerX: 0, playerZ: 0 });
    expect(light.intensity).toBeGreaterThan(0);

    objectives.reset();
    expect(light.intensity).toBe(0);
  });
});
