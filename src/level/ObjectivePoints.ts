import { MISSION, WORLD } from '../app/gameConfig';
import type { RandomSource } from '../utils/math';
import type { NavigationGrid } from '../zombies/NavigationGrid';

/** A marked point and how far it was from the player when it was chosen. */
export interface ObjectivePoint {
  x: number;
  z: number;
  distance: number;
}

export interface ObjectiveQuery {
  playerX: number;
  playerZ: number;
  grid: NavigationGrid;
  random: RandomSource;
  /** Annulus the point is drawn from, metres. Defaults to the MISSION tuning. */
  minDistance?: number;
  maxDistance?: number;
  /** A candidate inside this of the player is rejected. Defaults to MISSION.clearRadius. */
  clearRadius?: number;
  /** Random samples before the deterministic fallback. Defaults to MISSION.attempts. */
  attempts?: number;
}

/** The eight compass points, clockwise from north. */
export const COMPASS_DIRECTIONS = [
  'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest',
] as const;

export type CompassDirection = (typeof COMPASS_DIRECTIONS)[number];

/**
 * Wraps an angle into [-pi, pi].
 *
 * The bearing helpers all subtract angles that came from `atan2`, so the raw difference can
 * be up to two turns away from the shortest one; without the wrap, a target just across the
 * -pi/pi seam reads as "turn almost all the way around".
 */
function wrapAngle(angle: number): number {
  let wrapped = angle % (Math.PI * 2);
  if (wrapped > Math.PI) wrapped -= Math.PI * 2;
  if (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

/**
 * Compass name for a direction given as a world-space offset.
 *
 * Uses the same convention as the rest of the project (`atan2(dx, dz)`), where +Z is north
 * and +X is east — so the name the HUD prints matches the way facing is computed everywhere
 * else, instead of being a second, private set of axes.
 */
export function compassBearing(dx: number, dz: number): CompassDirection {
  const sector = Math.round(Math.atan2(dx, dz) / (Math.PI / 4));
  const index = ((sector % 8) + 8) % 8;
  return COMPASS_DIRECTIONS[index];
}

/**
 * Bearing of a target relative to where the player is facing, radians in [-pi, pi].
 *
 * Zero is straight ahead; positive turns clockwise (to the player's right). This is what
 * rotates the HUD arrow, and it is a separate number from the compass name because "which
 * way do I turn" and "which way is that on a map" are different questions.
 */
export function relativeBearing(playerYaw: number, dx: number, dz: number): number {
  return wrapAngle(Math.atan2(dx, dz) - playerYaw);
}

/**
 * The one-line instruction the HUD shows for the current objective.
 *
 * Distance is rounded to whole metres: a countdown that jitters between 42.31 and 42.29 is
 * noise, and the arrow already carries the precision that matters.
 */
export function formatObjectiveInstruction(options: {
  distance: number;
  bearing: CompassDirection;
  /** Prefix describing what to do; defaults to the marker hunt this feature uses. */
  label?: string;
}): string {
  const label = options.label ?? 'REACH THE MARKER';
  const metres = Math.max(0, Math.round(options.distance));
  return `${label} — ${metres} m ${options.bearing}`;
}

/**
 * Picks a marked point that the player can definitely walk to.
 *
 * The rule that matters is the one spawn placement already learned the hard way: *walkable
 * is not the same as reachable*. The city is a blockout, so it has cells that are open but
 * sealed off from the street; an objective dropped into one can never be reached, and a
 * mission that cannot be finished is worse than no mission at all. Candidates are therefore
 * taken from the player's own connected nav region (the flood-fill labelling already on
 * `NavigationGrid`), and the same region is used by the fallback.
 *
 * Sampling keeps the points varied; the fallback keeps the guarantee. If the random pass
 * finds nothing in the annulus the whole region is scanned, so a point is returned whenever
 * the region has one — the caller never has to handle `null` on a real map.
 */
export function pickObjectivePoint(query: ObjectiveQuery): ObjectivePoint | null {
  const { playerX, playerZ, grid, random } = query;
  const minDistance = query.minDistance ?? MISSION.minDistance;
  const maxDistance = query.maxDistance ?? MISSION.maxDistance;
  const clearRadius = query.clearRadius ?? MISSION.clearRadius;
  const attempts = query.attempts ?? MISSION.attempts;
  const area = WORLD.playArea;

  // A player standing inside inflated geometry has no region of their own; the largest
  // region is the street network they are almost certainly on, and spawning makes the same
  // substitution rather than giving up.
  const component = grid.componentAt(playerX, playerZ);
  const target = component >= 0 ? component : grid.largestComponent;
  if (target < 0) return null;

  let inRange: ObjectivePoint | null = null;
  let beyondClear: ObjectivePoint | null = null;

  for (let i = 0; i < attempts; i += 1) {
    const x = random.range(area.minX + 2, area.maxX - 2);
    const z = random.range(area.minZ + 2, area.maxZ - 2);
    const distance = Math.hypot(x - playerX, z - playerZ);
    // Rejected before the region test: an objective under the player's feet would be
    // complete the instant it appeared, which is not an objective.
    if (distance <= clearRadius) continue;
    if (grid.componentAt(x, z) !== target) continue;
    const point = { x, z, distance };
    // Prefer the far edge of the annulus so the walk is a walk, not a shuffle.
    if (distance >= minDistance && distance <= maxDistance) {
      if (!inRange || distance > inRange.distance) inRange = point;
    }
    if (!beyondClear || distance > beyondClear.distance) beyondClear = point;
  }

  if (inRange) return inRange;
  if (beyondClear) return beyondClear;
  // Sampling failed: a small or mostly-enclosed region. One pass over every cell of the
  // player's region is the answer that cannot miss. It may return a point closer than the
  // annulus — a short walk beats a mission that never starts — but on a map this size it
  // almost always finds one inside the annulus anyway.
  return scanRegion(grid, target, playerX, playerZ, minDistance, maxDistance, clearRadius);
}

/**
 * Deterministic last resort: the best cell of `target`, preferring the annulus, then
 * anything clear of the player, then simply the farthest cell the region has.
 *
 * The final step exists so the function never returns null for a non-empty region. A point
 * that is merely close still lets the player finish; null would strand the mission.
 */
function scanRegion(
  grid: NavigationGrid,
  target: number,
  playerX: number,
  playerZ: number,
  minDistance: number,
  maxDistance: number,
  clearRadius: number,
): ObjectivePoint | null {
  const { width, height, cells } = grid.grid;
  let inRange: ObjectivePoint | null = null;
  let beyondClear: ObjectivePoint | null = null;
  let farthest: ObjectivePoint | null = null;
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (cells[z * width + x] === 0) continue;
      const world = grid.gridToWorld(x, z);
      if (grid.componentAt(world.x, world.z) !== target) continue;
      const distance = Math.hypot(world.x - playerX, world.z - playerZ);
      const point = { x: world.x, z: world.z, distance };
      if (!farthest || distance > farthest.distance) farthest = point;
      if (distance > clearRadius && (!beyondClear || distance > beyondClear.distance)) {
        beyondClear = point;
      }
      if (distance >= minDistance && distance <= maxDistance
        && (!inRange || distance > inRange.distance)) {
        inRange = point;
      }
    }
  }
  return inRange ?? beyondClear ?? farthest;
}
