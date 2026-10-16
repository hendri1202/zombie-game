import { Object3D, Scene, Vector3 } from 'three';
import { NAV, WAVES, WORLD, type ZombieKind } from '../app/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import type { CollisionWorld } from '../level/CollisionWorld';
import { pickNearbySpawnPoint } from '../level/SpawnPoints';
import type { RandomSource } from '../utils/math';
import type { NavigationGrid } from './NavigationGrid';
import type { Zombie } from './Zombie';
import type { ZombieFactory } from './ZombieFactory';

export interface ZombieDirectorDeps {
  scene: Scene;
  factory: ZombieFactory;
  collision: CollisionWorld;
  navigation: NavigationGrid;
  events: EventBus<GameEvents>;
  random: RandomSource;
}

export interface DirectorUpdateResult {
  damageToPlayer: number;
  attackers: number;
  activeCount: number;
}

/** Pooled entities above this count are destroyed instead of kept alive. */
const MAX_POOL_PER_KIND = 8;
/** At most this many A* requests are served per simulation step. */
const PATH_REQUESTS_PER_STEP = 3;
/** Radius used when computing neighbour separation. */
const SEPARATION_CELL = 4;

/**
 * Owns every live zombie: spawning, per-step updates, separation steering,
 * attack resolution and cleanup.
 *
 * Update cost is kept predictable by three throttles that the brief asks for:
 * a shared per-step A* budget, a lower AI tick rate for distant zombies, and a
 * cheap spatial bucket for separation instead of an all-pairs loop.
 */
export class ZombieDirector {
  private readonly active: Zombie[] = [];
  private readonly pool = new Map<ZombieKind, Zombie[]>();
  private readonly scene: Scene;
  private readonly factory: ZombieFactory;
  private readonly collision: CollisionWorld;
  private readonly navigation: NavigationGrid;
  private readonly events: EventBus<GameEvents>;
  private readonly random: RandomSource;
  private readonly pathBudget = { remaining: PATH_REQUESTS_PER_STEP };
  private readonly separationX = new Map<number, number>();
  private readonly separationZ = new Map<number, number>();
  private readonly buckets = new Map<string, Zombie[]>();

  maxActive = WORLD.ambientZombieCap;

  constructor(deps: ZombieDirectorDeps) {
    this.scene = deps.scene;
    this.factory = deps.factory;
    this.collision = deps.collision;
    this.navigation = deps.navigation;
    this.events = deps.events;
    this.random = deps.random;
  }

  get count(): number {
    return this.active.length;
  }

  get list(): readonly Zombie[] {
    return this.active;
  }

  get pooledCount(): number {
    let total = 0;
    for (const bucket of this.pool.values()) total += bucket.length;
    return total;
  }

  /** Spawns a zombie at a world position, reusing a pooled entity when possible. */
  spawn(kind: ZombieKind, x: number, z: number, yaw = 0): Zombie | null {
    if (this.active.length >= this.maxActive) return null;
    const bucket = this.pool.get(kind);
    let zombie: Zombie | null = null;
    if (bucket && bucket.length > 0) {
      zombie = bucket.pop() ?? null;
    }
    if (!zombie) zombie = this.factory.create(kind);
    if (!zombie) return null;

    zombie.reset(x, z, yaw);
    this.active.push(zombie);
    this.scene.add(zombie.root);
    this.events.emit('zombie:spawned', { kind, active: this.active.length });
    return zombie;
  }

  /**
   * Brings zombies that are out of the fight back into it.
   *
   * The wave director calls this when a wave has been stuck in its clearing phase: the
   * zombies are alive, counted as remaining, and somewhere the player cannot get to, so
   * the run cannot continue. Each one far enough away to be irrelevant is put down in a
   * ring around the player instead — a cheat in the player's favour, which beats a run
   * that can never be finished.
   */
  recallNear(playerX: number, playerZ: number, playerYaw?: number): number {
    let moved = 0;
    for (const zombie of this.active) {
      if (!zombie.isAlive) continue;
      const distance = Math.hypot(zombie.position.x - playerX, zombie.position.z - playerZ);
      if (distance < WAVES.recallOnlyBeyond) continue;
      const point = pickNearbySpawnPoint({
        playerX,
        playerZ,
        playerYaw,
        grid: this.navigation,
        random: this.random,
        minDistance: WAVES.recallMinDistance,
        maxDistance: WAVES.recallMaxDistance,
      });
      if (!point) break;
      zombie.reset(point.x, point.z, 0);
      moved += 1;
    }
    return moved;
  }

  /** All hitboxes currently in the world, for the combat raycaster. */
  hitboxTargets(): Object3D[] {
    const targets: Object3D[] = [];
    for (const zombie of this.active) {
      if (!zombie.isAlive) continue;
      for (const hitbox of zombie.hitboxes) targets.push(hitbox);
    }
    return targets;
  }

  update(delta: number, playerPosition: Vector3, playerAlive: boolean): DirectorUpdateResult {
    this.pathBudget.remaining = PATH_REQUESTS_PER_STEP;
    this.computeSeparation();

    let damageToPlayer = 0;
    let attackers = 0;
    let wroteIndex = 0;

    for (let i = 0; i < this.active.length; i += 1) {
      const zombie = this.active[i];

      const dx = zombie.position.x - playerPosition.x;
      const dz = zombie.position.z - playerPosition.z;
      const distant = dx * dx + dz * dz > WORLD.distantUpdateDistance * WORLD.distantUpdateDistance;

      const result = zombie.update({
        delta,
        playerPosition,
        playerAlive,
        collision: this.collision,
        navigation: this.navigation,
        pathBudget: this.pathBudget,
        separationX: this.separationX.get(zombie.id) ?? 0,
        separationZ: this.separationZ.get(zombie.id) ?? 0,
        random: this.random,
        distant,
      });

      if (result.attackDamageToPlayer > 0 && playerAlive) {
        damageToPlayer += result.attackDamageToPlayer;
        attackers += 1;
        this.events.emit('zombie:attacked', { kind: zombie.kind });
      }

      if (zombie.isRemovable || (distant && Math.hypot(dx, dz) > 140 && zombie.state === 'wander')) {
        this.retire(zombie);
        continue;
      }

      // Compact the array in place: no allocation, no splice shifting.
      this.active[wroteIndex] = zombie;
      wroteIndex += 1;
    }

    this.active.length = wroteIndex;
    return { damageToPlayer, attackers, activeCount: this.active.length };
  }

  /** Number of zombies that are currently chasing or attacking the player. */
  get engagedCount(): number {
    let count = 0;
    for (const zombie of this.active) {
      if (zombie.state === 'chase' || zombie.state === 'attack') count += 1;
    }
    return count;
  }

  /**
   * Separation steering using a coarse spatial bucket: zombies only look at
   * neighbours in their own 4 m cell, which keeps the cost near-linear as the
   * horde grows instead of O(n^2).
   */
  private computeSeparation(): void {
    this.separationX.clear();
    this.separationZ.clear();
    this.buckets.clear();

    for (const zombie of this.active) {
      const key = this.bucketKey(zombie.position.x, zombie.position.z);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = [];
        this.buckets.set(key, bucket);
      }
      bucket.push(zombie);
    }

    const radiusSq = NAV.separationRadius * NAV.separationRadius;
    for (const zombie of this.active) {
      const gx = Math.floor(zombie.position.x / SEPARATION_CELL);
      const gz = Math.floor(zombie.position.z / SEPARATION_CELL);
      let sumX = 0;
      let sumZ = 0;
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oz = -1; oz <= 1; oz += 1) {
          const neighbours = this.buckets.get(`${gx + ox},${gz + oz}`);
          if (!neighbours) continue;
          for (const other of neighbours) {
            if (other === zombie) continue;
            const dx = zombie.position.x - other.position.x;
            const dz = zombie.position.z - other.position.z;
            const distanceSq = dx * dx + dz * dz;
            if (distanceSq > radiusSq || distanceSq < 1e-6) continue;
            const inverse = 1 / Math.sqrt(distanceSq);
            const weight = 1 - Math.sqrt(distanceSq) / NAV.separationRadius;
            sumX += dx * inverse * weight;
            sumZ += dz * inverse * weight;
          }
        }
      }
      if (sumX !== 0 || sumZ !== 0) {
        const length = Math.hypot(sumX, sumZ);
        this.separationX.set(zombie.id, sumX / length);
        this.separationZ.set(zombie.id, sumZ / length);
      }
    }
  }

  private bucketKey(x: number, z: number): string {
    return `${Math.floor(x / SEPARATION_CELL)},${Math.floor(z / SEPARATION_CELL)}`;
  }

  private retire(zombie: Zombie): void {
    zombie.retire();
    const bucket = this.pool.get(zombie.kind);
    if (bucket && bucket.length < MAX_POOL_PER_KIND) {
      bucket.push(zombie);
    } else if (!bucket) {
      this.pool.set(zombie.kind, [zombie]);
    }
    this.events.emit('zombie:despawned', { active: this.active.length - 1 });
  }

  /** Removes every live zombie and returns them to the pool. */
  clear(): void {
    for (const zombie of this.active) {
      zombie.retire();
      const bucket = this.pool.get(zombie.kind);
      if (bucket && bucket.length < MAX_POOL_PER_KIND) bucket.push(zombie);
      else if (!bucket) this.pool.set(zombie.kind, [zombie]);
    }
    this.active.length = 0;
    this.separationX.clear();
    this.separationZ.clear();
    this.buckets.clear();
  }

  dispose(): void {
    // Final teardown: pooled entities are destroyed for real here, since nothing
    // will reuse them once the director is gone.
    for (const zombie of this.active) zombie.dispose();
    this.active.length = 0;
    for (const bucket of this.pool.values()) {
      for (const zombie of bucket) zombie.dispose();
    }
    this.pool.clear();
    this.separationX.clear();
    this.separationZ.clear();
    this.buckets.clear();
  }
}
