import { WAVES, WORLD } from '../app/gameConfig';
import type { RandomSource } from '../utils/math';
import type { NavigationGrid } from '../zombies/NavigationGrid';

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

  return fallback ?? farthestInReach(grid, playerX, playerZ, WAVES.minSpawnDistance);
}

/**
 * The farthest walkable cell as a last resort, preferring the player's own region.
 *
 * One pass over the grid, taken only when sampling fails. Two relaxations, in order:
 * inside the player's region prefer a cell at least `minDistance` away, then accept the
 * farthest cell it has even if that is close (a wave placed badly beats a wave that never
 * ends), and finally — for a player standing somewhere with no walkable region at all —
 * use the largest region in the map.
 */
function farthestInReach(
  grid: NavigationGrid, playerX: number, playerZ: number, minDistance: number,
): SpawnCandidate | null {
  const component = grid.componentAt(playerX, playerZ);
  const target = component >= 0 ? component : grid.largestComponent;
  if (target < 0) return null;
  const { width, height, cells } = grid.grid;
  let far: SpawnCandidate | null = null;
  let near: SpawnCandidate | null = null;
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (cells[z * width + x] === 0) continue;
      const world = grid.gridToWorld(x, z);
      if (grid.componentAt(world.x, world.z) !== target) continue;
      const distance = Math.hypot(world.x - playerX, world.z - playerZ);
      const candidate: SpawnCandidate = { x: world.x, z: world.z, distance, blocked: false, inView: false };
      if ((!near || distance > near.distance)) near = candidate;
      if (distance >= minDistance && (!far || distance > far.distance)) far = candidate;
    }
  }
  return far ?? near;
}

/**
 * A point in a ring around the player, used to bring a stalled zombie back into play.
 *
 * Deliberately close, and outside the view cone if the sampling finds one: a zombie that
 * could not path to the player is of no use placed on the far side of the map again.
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
  return fallback;
}
