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

/**
 * Picks a spawn position that is walkable, far enough away, and — when possible
 * — outside the player's view cone, so zombies do not pop into existence in
 * front of the crosshair.
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
    const walkable = grid.isWalkableWorld(x, z);

    if (!walkable) continue;

    // Angle between the player's facing and the direction to the candidate.
    const toCandidate = Math.atan2(dx, dz);
    let delta = (toCandidate - playerYaw) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const inView = Math.abs(delta) < WAVES.viewConeHalfAngle;

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

  return fallback;
}
