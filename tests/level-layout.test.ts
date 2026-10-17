import { describe, expect, it } from 'vitest';
import {
  buildLevelWorld, rectOverlap, walkRoute, type LevelWorld, type Rect,
} from './helpers/levelWorld';
import { MISSION, PLAYER, WORLD } from '../src/app/gameConfig';
import {
  PROP_LAYOUT, PROP_SPECS, ROAD_HALF_WIDTH, STREET_EXTENT, SIDEWALK_BANDS,
  propCollisionFootprint, roadwayRects, sidewalkRects,
} from '../src/level/CityLevel';
import { CollisionWorld } from '../src/level/CollisionWorld';
import { pickObjectivePoint } from '../src/level/ObjectivePoints';
import { SeededRandom } from '../src/utils/math';

/**
 * Guards on where the block's props stand.
 *
 * The owner's report was a sofa in the street and a run that stopped making progress. Both
 * were measured against the shipped geometry, not argued about:
 *
 *  - the couch's collision box sat in the middle of the pavement (x 9.16..10.04 of a
 *    pavement that runs x 8..11.2), leaving 1.16 m of pavement on either side of it. At
 *    night the pavement and the asphalt read the same, so from the middle of the road it
 *    looks like a sofa dumped in the street — and a player walking onto the kerb there is
 *    stopped dead by it (measured: the body halts at x = 8.74, which is the box edge minus
 *    the player radius);
 *  - the chest did the same thing 0.73 m from the kerb on the other side.
 *
 * The rules below are the general form of that: nothing stands in a driving lane unless the
 * level's own cover list says it may, no prop may squeeze the pavement's walking line below
 * a player-and-a-bit, and neither street may ever be walled off.
 *
 * Everything here is measured on the real block: the real layout, the real GLTF bounding
 * boxes, the real building generator, the real perimeter and the real navigation grid (see
 * `helpers/levelWorld`). Revert a placement and these tests say so by name.
 */

let cachedWorld: Promise<LevelWorld> | null = null;
const world = (): Promise<LevelWorld> => (cachedWorld ??= buildLevelWorld());

/**
 * Props the layout deliberately puts on the asphalt: wrecked vehicles, shipping containers
 * and road barriers. It is not a taste list — each one is the level's own cover: `PROP_LAYOUT`
 * places the vehicles as "the main mid-street cover" and the barriers/containers as the
 * containment line down both streets. Everything else belongs on the pavement or in a yard.
 */
const ON_ROAD_PROPS = new Set([
  'pickup', 'pickupArmored', 'sports', 'truck', 'truckArmored',
  'containerGreen', 'containerRed', 'trafficBarrier1', 'trafficBarrier2', 'plasticBarrier',
  'wheelsStack',
]);

/** How close to a pavement edge a prop still counts as kerbside street furniture, metres. */
const KERB_CLEARANCE = 0.6;

/** Pavement left beside a prop: the player's body plus a margin, metres. */
const MIN_PAVEMENT_LANE = 2 * PLAYER.radius + 0.6;

/** Clear centre-line a street has to keep, metres. One player body plus a margin. */
const MIN_STREET_LANE = 1.0;

function inside(rect: Rect, x: number, z: number): boolean {
  return x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ;
}

/** Lane rectangles: the roadway with the pavement strips taken back off it. */
function laneWhereDriving(x: number, z: number): boolean {
  const onRoad = roadwayRects().some((rect) => inside(rect, x, z));
  const onPavement = sidewalkRects().some((rect) => inside(rect, x, z));
  return onRoad && !onPavement;
}

/**
 * Props standing in a driving lane, by tag.
 *
 * The prop's centre decides it, so a barrier reaching a few centimetres over the kerb is
 * still a barrier at the kerb, while furniture parked on the asphalt is never anything else.
 */
function propsInDrivingLane(collision: LevelWorld['collision']): string[] {
  const offenders: string[] = [];
  for (const box of collision.boxes) {
    if (!box.tag.startsWith('prop:')) continue;
    const prop = box.tag.slice('prop:'.length);
    if (ON_ROAD_PROPS.has(prop)) continue;
    if (!laneWhereDriving((box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2)) continue;
    offenders.push(`${box.tag} centred at (${((box.minX + box.maxX) / 2).toFixed(2)}, ${((box.minZ + box.maxZ) / 2).toFixed(2)})`);
  }
  return offenders;
}

interface Squeeze { tag: string; band: string; inner: number; outer: number }

/**
 * Props parked in the middle of a pavement: how much pavement is left between them and the
 * kerb, and between them and the building line.
 *
 * A prop is only an offender if it sits clear of both edges by more than `KERB_CLEARANCE`
 * (so a barrel, a hydrant, a lamp post or anything else against the kerb or against the wall
 * is left alone — that is where street furniture belongs) and still leaves less than a
 * player-and-a-bit of pavement to walk along on both sides.
 */
function pavementSqueezes(collision: LevelWorld['collision']): Squeeze[] {
  const found: Squeeze[] = [];
  for (const [bandX, bandZ, width, depth] of SIDEWALK_BANDS) {
    const alongX = depth > width; // the strip runs along Z, so it is measured on X
    const bandMin = (alongX ? bandX : bandZ) - (alongX ? width : depth) / 2;
    const bandMax = (alongX ? bandX : bandZ) + (alongX ? width : depth) / 2;
    for (const box of collision.boxes) {
      if (!box.tag.startsWith('prop:')) continue;
      const min = alongX ? box.minX : box.minZ;
      const max = alongX ? box.maxX : box.maxZ;
      if (min < bandMin || max > bandMax) continue; // not wholly on this pavement
      const inner = min - bandMin;
      const outer = bandMax - max;
      if (inner < KERB_CLEARANCE || outer < KERB_CLEARANCE) continue; // kerbside or against the wall
      if (Math.max(inner, outer) < MIN_PAVEMENT_LANE) {
        found.push({
          tag: box.tag,
          band: alongX ? `x ${bandMin}..${bandMax}` : `z ${bandMin}..${bandMax}`,
          inner: Number(inner.toFixed(2)),
          outer: Number(outer.toFixed(2)),
        });
      }
    }
  }
  return found;
}

/**
 * The tightest point of a street, metres: the widest run of centre positions a body can walk
 * through at the worst station along it.
 *
 * At every station along the street, blocking boxes that span that station are projected onto
 * the cross axis and inflated by the body radius; what is left is the corridor a body could
 * walk through there. The answer is the minimum over stations, so a single wall across the
 * street reports 0 while a street with half of it blocked by wrecks reports the open half.
 */
function narrowestLane(
  collision: LevelWorld['collision'],
  alongIsZ: boolean,
  minCross: number,
  maxCross: number,
  minAlong: number,
  maxAlong: number,
): number {
  const radius = PLAYER.radius;
  const step = 0.1;
  let narrowest = Number.POSITIVE_INFINITY;
  for (let station = minAlong; station <= maxAlong; station += step) {
    const spans: Array<[number, number]> = [];
    for (const box of collision.boxes) {
      if (!box.blocksPlayer) continue;
      const alongMin = (alongIsZ ? box.minZ : box.minX) - radius;
      const alongMax = (alongIsZ ? box.maxZ : box.maxX) + radius;
      if (station <= alongMin || station >= alongMax) continue;
      spans.push([
        (alongIsZ ? box.minX : box.minZ) - radius,
        (alongIsZ ? box.maxX : box.maxZ) + radius,
      ]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = minCross;
    let widest = 0;
    for (const [lo, hi] of spans) {
      if (lo > cursor) widest = Math.max(widest, Math.min(lo, maxCross) - cursor);
      cursor = Math.max(cursor, hi);
      if (cursor >= maxCross) break;
    }
    if (cursor < maxCross) widest = Math.max(widest, maxCross - cursor);
    narrowest = Math.min(narrowest, widest);
  }
  return Number.isFinite(narrowest) ? narrowest : 0;
}

describe('the block keeps its streets walkable', () => {
  it('builds the real geometry, so every other assertion means something', async () => {
    const { collision, grid } = await world();
    // A harness that quietly loaded no props would make every guard below vacuous.
    expect(collision.count).toBeGreaterThan(50);
    expect(grid.walkableRatio).toBeGreaterThan(0.5);
    expect(grid.walkableRatio).toBeLessThan(0.95);
    expect(grid.componentCount).toBeGreaterThan(0);
    // The player's spawn has to be somewhere a zombie could theoretically stand, or the
    // whole spawn/objective chain below is measured from a hole in the map.
    expect(grid.isWalkableWorld(PLAYER.spawn.x, PLAYER.spawn.z)).toBe(true);
  });

  it('keeps every solid prop out of the driving lanes, except the level’s own cover', async () => {
    const { collision } = await world();
    expect(propsInDrivingLane(collision)).toEqual([]);
  });

  it('will not let a prop squeeze the pavement’s walking line', async () => {
    const squeezes = pavementSqueezes((await world()).collision);
    expect(squeezes).toEqual([]);
    expect(MIN_PAVEMENT_LANE).toBeGreaterThan(2 * PLAYER.radius);
  });

  it('never walls off a street', async () => {
    const { collision } = await world();
    // The main street runs along Z, so its lane is measured across X, and the other way
    // round for the cross street. The corridor is confined to the roadway itself: stepping
    // onto the pavement is not "the street is open". The ends stop short of the perimeter
    // walls, which close both streets by design — the guard is about props, not the map edge.
    const from = -STREET_EXTENT + 8;
    const to = STREET_EXTENT - 8;
    const main = narrowestLane(collision, true, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, from, to);
    const cross = narrowestLane(collision, false, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, from, to);
    expect(main).toBeGreaterThanOrEqual(MIN_STREET_LANE);
    expect(cross).toBeGreaterThanOrEqual(MIN_STREET_LANE);
  });

  it('leaves the roads clear of pavement furniture where the owner saw the sofa', async () => {
    const { collision } = await world();
    // The spot the report is about: the main street at z = 22, where a coach stood in the
    // middle of the pavement. Whatever else moves, the driving lane there stays a lane and
    // no prop of the furniture kind sits in it.
    const lane = { minX: -ROAD_HALF_WIDTH, maxX: ROAD_HALF_WIDTH, minZ: 20, maxZ: 24 };
    const inLane = collision.boxes.filter((box) => rectOverlap(box, lane).overlaps
      && !ON_ROAD_PROPS.has(box.tag.replace('prop:', '')));
    expect(inLane.map((box) => box.tag)).toEqual([]);
  });
});

describe('the mission’s routes are walkable end to end', () => {
  it('picks objective points the player can always reach, on foot, from the spawn', async () => {
    const { collision, grid } = await world();
    const spawn = PLAYER.spawn;
    const failures: string[] = [];

    for (let seed = 0; seed < 12; seed += 1) {
      const random = new SeededRandom(seed * 7919 + 13);
      const point = pickObjectivePoint({ playerX: spawn.x, playerZ: spawn.z, grid, random });
      if (!point) { failures.push(`seed ${seed}: no objective point at all`); continue; }
      if (!grid.isWalkableWorld(point.x, point.z)) {
        failures.push(`seed ${seed}: (${point.x.toFixed(1)}, ${point.z.toFixed(1)}) is not walkable`);
        continue;
      }
      if (!grid.isConnectedWorld(spawn.x, spawn.z, point.x, point.z)) {
        failures.push(`seed ${seed}: (${point.x.toFixed(1)}, ${point.z.toFixed(1)}) is in another region`);
        continue;
      }
      const path = grid.findPathWorld(spawn.x, spawn.z, point.x, point.z);
      if (!path) {
        failures.push(`seed ${seed}: no nav path to (${point.x.toFixed(1)}, ${point.z.toFixed(1)})`);
        continue;
      }
      const walk = walkRoute(collision, [{ x: spawn.x, z: spawn.z }, ...path], PLAYER.radius);
      if (!walk.reached) {
        failures.push(`seed ${seed}: the walk to (${point.x.toFixed(1)}, ${point.z.toFixed(1)}) stalled at `
          + `(${walk.stalledAt?.x.toFixed(2)}, ${walk.stalledAt?.z.toFixed(2)})`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps every objective point inside the mission’s own annulus rules', async () => {
    const { grid } = await world();
    const spawn = PLAYER.spawn;
    for (let seed = 0; seed < 12; seed += 1) {
      const point = pickObjectivePoint({ playerX: spawn.x, playerZ: spawn.z, grid, random: new SeededRandom(seed + 1) });
      expect(point).not.toBeNull();
      if (!point) continue;
      // Never underfoot, never outside the stretch the mission is willing to ask for.
      expect(point.distance).toBeGreaterThan(MISSION.clearRadius);
      expect(point.distance).toBeLessThanOrEqual(MISSION.maxDistance + 1e-6);
    }
  });

  it('walks the player down both pavements of the main street without a stall', async () => {
    const { collision, grid } = await world();
    const spawn = PLAYER.spawn;
    const routes: Array<[number, number, string]> = [
      [9.6, -40, '+X pavement, away from the spawn'],
      [9.6, 44, '+X pavement, past the sofa spot'],
      [-9.6, 40, '-X pavement, away from the spawn'],
      [-9.6, -40, '-X pavement, back toward the south end'],
    ];
    for (const [x, z, label] of routes) {
      const path = grid.findPathWorld(spawn.x, spawn.z, x, z);
      expect(path, label).not.toBeNull();
      if (!path) continue;
      const walk = walkRoute(collision, [{ x: spawn.x, z: spawn.z }, ...path], PLAYER.radius);
      expect(walk.reached, `${label} stalled at (${walk.stalledAt?.x.toFixed(2)}, ${walk.stalledAt?.z.toFixed(2)})`).toBe(true);
    }
  });
});

describe('the props the layout declares are the props that get built', () => {
  it('only places props that exist in the catalogue, with the catalogue’s solid flag', async () => {
    const { props } = await world();
    for (const placement of PROP_LAYOUT) {
      const spec = PROP_SPECS.find((entry) => entry.name === placement.prop);
      expect(spec, placement.prop).toBeDefined();
      // A placement of a name the catalogue does not carry is silently skipped by the
      // level, which is how a prop goes missing without anyone noticing.
      expect(props.has(placement.prop), placement.prop).toBe(true);
      expect(spec?.solid, `${placement.prop} solid flag`).toBeDefined();
    }
  });
});

/**
 * The guards above only mean something if they can fail. These tests hand each rule a world
 * with the mistake in it — the old sofa placement, furniture dropped on the asphalt, a wall
 * across the street — and require the rule to report it. A rule that quietly passes on a
 * broken world would keep the suite green through exactly the regression it exists for.
 */
describe('the street guards bite when the level is broken again', () => {
  /** A copy of the built block with extra prop footprints added, as the level would. */
  async function brokenWorld(extra: Array<{ prop: string; x: number; z: number; rotationY: number }>): Promise<LevelWorld['collision']> {
    const { collision: built, props } = await world();
    const collision = new CollisionWorld({ ...WORLD.playArea });
    for (const box of built.boxes) collision.addBox({ ...box });
    for (const placement of extra) {
      const template = props.get(placement.prop);
      expect(template, placement.prop).not.toBeNull();
      if (!template) continue;
      const footprint = propCollisionFootprint(placement.rotationY, template.size);
      collision.addCenteredBox(
        placement.x, placement.z, footprint.width, footprint.depth, template.size.height,
        `prop:${placement.prop}`, { blocksPlayer: true, blocksZombies: true },
      );
    }
    return collision;
  }

  it('names the sofa when the old placement is put back', async () => {
    const collision = await brokenWorld([{ prop: 'couch', x: 9.6, z: 22, rotationY: 1.4 }]);
    const squeezes = pavementSqueezes(collision);
    expect(squeezes.map((entry) => entry.tag)).toContain('prop:couch');
    expect(squeezes.find((entry) => entry.tag === 'prop:couch')?.inner).toBeCloseTo(9.16 - 8, 2);
  });

  it('names a prop parked in the driving lane', async () => {
    const collision = await brokenWorld([{ prop: 'couch', x: 4, z: 22, rotationY: 0 }]);
    expect(propsInDrivingLane(collision).join(' ')).toContain('prop:couch');
  });

  it('reports a street that has been walled off, and a route across it', async () => {
    const { grid } = await world();
    const collision = await brokenWorld([]);
    // A wall across the whole block, so there is no way around its end to argue about.
    collision.addCenteredBox(0, 10, 200, 1, 4, 'prop:testWall', { blocksPlayer: true, blocksZombies: true });
    expect(narrowestLane(collision, true, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, -STREET_EXTENT + 8, STREET_EXTENT - 8))
      .toBeLessThan(MIN_STREET_LANE);
    // And the routes the mission asks the player to walk really do stop dead at it.
    const walking = walkRoute(collision, [{ x: PLAYER.spawn.x, z: PLAYER.spawn.z }, { x: 9.6, z: -40 }], PLAYER.radius);
    expect(walking.reached).toBe(false);
    // The un-broken block, by contrast, is connected across that same line.
    const path = grid.findPathWorld(PLAYER.spawn.x, PLAYER.spawn.z, 9.6, -40);
    expect(path).not.toBeNull();
    expect(grid.isConnectedWorld(PLAYER.spawn.x, PLAYER.spawn.z, 9.6, -40)).toBe(true);
  });
});
