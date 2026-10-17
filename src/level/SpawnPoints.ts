import { WAVES, WORLD, ZOMBIE_AI } from '../app/gameConfig';
import type { RandomSource } from '../utils/math';
import type { NavigationGrid } from '../zombies/NavigationGrid';

/**
 * The farthest from the player a zombie may be placed, metres.
 *
 * `ZombieStateMachine.canSense` only notices the player inside `ZOMBIE_AI.sightRange`
 * without line of sight — and only inside `maxTargetRange` at all. A zombie put down
 * further away than this, on the far side of a building, therefore never leaves its
 * `wander` state: it orbits its own spawn point for the rest of the wave, the HUD keeps
 * promising enemies that never arrive, and the wave only ends when the straggler recall
 * moves it by hand 25 seconds later. That is the stall a player describes as "the game
 * is stuck": standing in the street with the counter saying eight zombies remain and
 * nothing coming.
 *
 * The rule is therefore not "spawn far away, it is harder", it is "spawn where the
 * zombie will find the fight": inside the distance it is guaranteed to sense the player
 * from, which is what keeps a wave finishable by playing it. Measured on the built
 * block before this cap: a third of the sampled placements landed beyond the sense
 * range with no line of sight, the farthest 73 m from the player, and a browser run
 * showed eight zombies alive with one engaged and the farthest 105 m away.
 */
export const MAX_SPAWN_DISTANCE = ZOMBIE_AI.sightRange;


export interface SpawnCandidate {
  x: number;
  z: number;
  /** Distance from the player when the point was evaluated. */
  distance: number;
  blocked: boolean;
  inView: boolean;
}

export interface SpawnQuery {
  playerX: number;
  playerZ: number;
  /** Player facing yaw in radians (camera forward on the XZ plane). */
  playerYaw: number;
  grid: NavigationGrid;
  random: RandomSource;
  attempts?: number;
}

export interface NearbySpawnQuery {
  playerX: number;
  playerZ: number;
  /** Player facing yaw, or undefined to accept any direction. */
  playerYaw?: number;
  grid: NavigationGrid;
  random: RandomSource;
  /** Annulus around the player, metres: where a recalled straggler is put down. */
  minDistance: number;
  maxDistance: number;
}

function angleTo(playerYaw: number, dx: number, dz: number): number {
  const toCandidate = Math.atan2(dx, dz);
  let delta = (toCandidate - playerYaw) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Picks a spawn position that is walkable, far enough away, outside the player's view
 * cone when possible, and — new — **in the same connected region as the player**.
 *
 * The connectivity rule is the important one. Walkability alone let a spawn land in a
 * pocket of the blockout sealed off from the street: the zombie counted as remaining,
 * never reached anyone, and the wave never cleared, so the run was stuck on a HUD
 * promising enemies that could not be found. Any candidate in another region is now
 * rejected outright.
 *
 * If random sampling cannot find anything closer than the minimum distance, the farthest
 * cell of the player's own region is used instead, so a wave can always be placed rather
 * than silently stalling.
 */
export function pickSpawnPoint(query: SpawnQuery): SpawnCandidate | null {
  const { playerX, playerZ, playerYaw, grid, random } = query;
  const attempts = query.attempts ?? 24;
  const area = WORLD.playArea;

  let fallback: SpawnCandidate | null = null;

  for (let i = 0; i < attempts; i += 1) {
    const x = random.range(area.minX + 2, area.maxX - 2);
    const z = random.range(area.minZ + 2, area.maxZ - 2);
    const dx = x - playerX;
    const dz = z - playerZ;
    const distance = Math.hypot(dx, dz);

    if (!grid.isConnectedWorld(playerX, playerZ, x, z)) continue;

    // Beyond the distance a zombie can notice the player from, a placement is not a
    // harder spawn, it is a zombie that never joins the wave. See MAX_SPAWN_DISTANCE.
    if (distance > MAX_SPAWN_DISTANCE) continue;

    const inView = Math.abs(angleTo(playerYaw, dx, dz)) < WAVES.viewConeHalfAngle;
    const candidate: SpawnCandidate = { x, z, distance, blocked: false, inView };

    if (distance >= WAVES.minSpawnDistance && !inView) return candidate;
    if (distance >= WAVES.minSpawnDistanceInView && inView) {
      if (!fallback || distance > fallback.distance) fallback = candidate;
      continue;
    }
    if (distance >= WAVES.minSpawnDistance && (!fallback || distance > fallback.distance)) {
      fallback = candidate;
    }
  }

  return fallback ?? farthestInReach(grid, playerX, playerZ, WAVES.minSpawnDistance, MAX_SPAWN_DISTANCE);
}

/**
 * The connected region to place from: the player's own when their cell is walkable, and
 * the largest region otherwise.
 *
 * The player can stand in spots the grid calls blocked — the grid inflates obstacles by
 * the zombie radius (0.45 m) and the player body is 0.42 m, so a shoulder against a wall
 * is enough. Substituting the largest region for "no region of my own" is what keeps a
 * spawn (and a recall) possible from a doorway instead of silently returning nothing.
 */
function regionFor(grid: NavigationGrid, x: number, z: number): number {
  const component = grid.componentAt(x, z);
  return component >= 0 ? component : grid.largestComponent;
}

/**
 * The farthest walkable cell of the player's region as a last resort.
 *
 * One pass over the grid, taken only when sampling fails. Three relaxations, in order:
 * inside the player's region prefer a cell in the spawn annulus, then the farthest cell
 * that is still inside the sense range however close it is (a wave placed badly beats a
 * wave that never ends), and only for a region with nothing at all inside the sense
 * range — a player boxed into a pocket — the farthest cell it has.
 */
function farthestInReach(
  grid: NavigationGrid, playerX: number, playerZ: number, minDistance: number, maxDistance: number,
): SpawnCandidate | null {
  const target = regionFor(grid, playerX, playerZ);
  if (target < 0) return null;
  const { width, height, cells } = grid.grid;
  let inAnnulus: SpawnCandidate | null = null;
  let insideSense: SpawnCandidate | null = null;
  let farthest: SpawnCandidate | null = null;
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (cells[z * width + x] === 0) continue;
      const world = grid.gridToWorld(x, z);
      if (grid.componentAt(world.x, world.z) !== target) continue;
      const distance = Math.hypot(world.x - playerX, world.z - playerZ);
      const candidate: SpawnCandidate = { x: world.x, z: world.z, distance, blocked: false, inView: false };
      if (!farthest || distance > farthest.distance) farthest = candidate;
      if (distance <= maxDistance && (!insideSense || distance > insideSense.distance)) {
        insideSense = candidate;
      }
      if (distance >= minDistance && distance <= maxDistance
        && (!inAnnulus || distance > inAnnulus.distance)) {
        inAnnulus = candidate;
      }
    }
  }
  return inAnnulus ?? insideSense ?? farthest;
}

/**
 * A point in a ring around the player, used to bring a stalled zombie back into play.
 *
 * Deliberately close, and outside the view cone if the sampling finds one: a zombie that
 * could not path to the player is of no use placed on the far side of the map again.
 *
 * The fallback matters as much as the sampling: this is the last line of defence for a
 * wave that cannot clear, so it must not be able to return nothing while the map has
 * walkable ground. A player standing in a cell their own region does not cover (see
 * `regionFor`) used to make every sample fail the connectivity test and the recall then
 * moved nobody, every time, for the rest of the run.
 */
export function pickNearbySpawnPoint(query: NearbySpawnQuery): SpawnCandidate | null {
  const { playerX, playerZ, playerYaw, grid, random, minDistance, maxDistance } = query;
  let fallback: SpawnCandidate | null = null;
  for (let i = 0; i < 40; i += 1) {
    const angle = random.range(0, Math.PI * 2);
    const distance = random.range(minDistance, maxDistance);
    const x = playerX + Math.sin(angle) * distance;
    const z = playerZ + Math.cos(angle) * distance;
    if (!grid.isConnectedWorld(playerX, playerZ, x, z)) continue;
    // With no yaw there is nothing to prefer, so the first connected point wins.
    if (playerYaw === undefined) return { x, z, distance, blocked: false, inView: false };
    const inView = Math.abs(angleTo(playerYaw, x - playerX, z - playerZ)) < WAVES.viewConeHalfAngle;
    const candidate: SpawnCandidate = { x, z, distance, blocked: false, inView };
    if (!inView) return candidate;
    if (!fallback) fallback = candidate;
  }
  return fallback ?? closestRingPoint(grid, playerX, playerZ, minDistance, maxDistance);
}

/**
 * Deterministic last resort for the recall: the cell of the player's region (or the
 * largest one) whose distance from the player is closest to the recall ring.
 *
 * Sampled angles are the first choice because a ring is what a recall wants; this scan
 * exists so that a player the grid cannot place a ring around still gets the zombie
 * brought back rather than a wave that ends only when the player dies.
 */
function closestRingPoint(
  grid: NavigationGrid, playerX: number, playerZ: number, minDistance: number, maxDistance: number,
): SpawnCandidate | null {
  const target = regionFor(grid, playerX, playerZ);
  if (target < 0) return null;
  const { width, height, cells } = grid.grid;
  let best: SpawnCandidate | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (cells[z * width + x] === 0) continue;
      const world = grid.gridToWorld(x, z);
      if (grid.componentAt(world.x, world.z) !== target) continue;
      const distance = Math.hypot(world.x - playerX, world.z - playerZ);
      const score = distance < minDistance ? minDistance - distance
        : distance > maxDistance ? distance - maxDistance
        : 0;
      if (score < bestScore) {
        bestScore = score;
        best = { x: world.x, z: world.z, distance, blocked: false, inView: false };
      }
    }
  }
  return best;
}
