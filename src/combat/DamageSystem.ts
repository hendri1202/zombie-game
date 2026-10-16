import { Object3D, Raycaster, Vector3 } from 'three';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone, Vec3Tuple } from '../app/GameEvents';
import type { CollisionWorld } from '../level/CollisionWorld';
import type { RandomSource } from '../utils/math';
import type { Zombie } from '../zombies/Zombie';
import type { ZombieDirector } from '../zombies/ZombieDirector';
import { HITBOX_LAYER } from '../zombies/ZombieFactory';
import type { ZombieKind } from '../app/gameConfig';

export interface HitscanRequest {
  origin: Vector3;
  /** Normalised aim direction (camera forward). */
  direction: Vector3;
  damage: number;
  range: number;
  /** Cone half-angle in radians applied per shot. */
  spread: number;
  headshotMultiplier: number;
  /**
   * Projectiles per trigger pull, each with its own spread draw.
   *
   * One round of ammunition still leaves the magazine: pellets are how a shotgun works,
   * not a burst. The returned report is the aggregate of every pellet, so the caller and
   * the HUD keep seeing one shot per pull of the trigger.
   */
  pellets?: number;
}

/**
 * Tilts an aim vector inside a cone, given the two random draws that define where it lands.
 *
 * Extracted so the geometry can be tested without a random source: a pellet must land
 * inside the cone it was given, however the draws fall.
 */
export function spreadDirection(
  direction: Vector3, angle: number, magnitude: number,
): Vector3 {
  const up = Math.abs(direction.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(direction, up).normalize();
  const realUp = new Vector3().crossVectors(right, direction).normalize();
  return direction
    .addScaledVector(right, Math.cos(angle) * magnitude)
    .addScaledVector(realUp, Math.sin(angle) * magnitude);
}

export interface HitscanReport {
  target: 'zombie' | 'world' | 'none';
  zone: HitZone;
  killed: boolean;
  kind: ZombieKind | null;
  distance: number;
  point: Vector3;
  /** Damage actually applied after multipliers. */
  damage: number;
}

export interface DamageSystemDeps {
  director: ZombieDirector;
  collision: CollisionWorld;
  events: EventBus<GameEvents>;
  random: RandomSource;
}

/**
 * Hitscan resolution.
 *
 * A shot is a real raycast: the bullet direction is perturbed by the weapon's
 * spread and then tested against the world boxes and against each zombie's own
 * hitbox meshes. The nearest intersection wins, so a zombie standing behind a
 * wall is never hit. Headshots only exist because head and body are separate
 * hitboxes; if a model had a single box the multiplier would not be applied.
 */
export class DamageSystem {
  private readonly raycaster = new Raycaster();
  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  private readonly point = new Vector3();
  private readonly director: ZombieDirector;
  private readonly collision: CollisionWorld;
  private readonly events: EventBus<GameEvents>;
  private readonly random: RandomSource;

  constructor(deps: DamageSystemDeps) {
    this.director = deps.director;
    this.collision = deps.collision;
    this.events = deps.events;
    this.random = deps.random;
    // Hitboxes live on layer 1 so the camera never draws them.
    this.raycaster.layers.enable(HITBOX_LAYER);
  }

  /**
   * Resolves a shot, or every pellet of one.
   *
   * A single projectile is the common case and returns its own report. A shotgun fires
   * each pellet as its own ray and returns the aggregate: total damage applied, whether
   * anything died, and the nearest hit for the caller to draw. Every pellet emits its own
   * impact event, which is what puts several impacts and blood spurts on screen from one
   * trigger pull.
   */
  fire(request: HitscanRequest): HitscanReport {
    const pellets = Math.max(1, Math.floor(request.pellets ?? 1));
    if (pellets === 1) return this.resolveShot(request, request.direction);

    let totalDamage = 0;
    let killed = false;
    let target: HitscanReport['target'] = 'none';
    let zone: HitZone = 'body';
    let kind: ZombieKind | null = null;
    let distance = Number.POSITIVE_INFINITY;
    let point: Vector3 | null = null;

    for (let pellet = 0; pellet < pellets; pellet += 1) {
      const report = this.resolveShot(request, request.direction);
      totalDamage += report.damage;
      killed = killed || report.killed;
      if (report.target === 'zombie' && target !== 'zombie') {
        target = 'zombie';
        zone = report.zone;
        kind = report.kind;
      } else if (report.target === 'world' && target === 'none') {
        target = 'world';
      }
      if (report.distance < distance) distance = report.distance;
      if (!point && report.target !== 'none') point = report.point.clone();
    }

    this.point.copy(point ?? this.origin).addScaledVector(request.direction, 0);
    return {
      target,
      zone,
      killed,
      kind,
      distance: Number.isFinite(distance) ? distance : request.range,
      point: point ? point.clone() : this.point.clone(),
      damage: totalDamage,
    };
  }

  private resolveShot(request: HitscanRequest, baseDirection: Vector3): HitscanReport {
    this.origin.copy(request.origin);
    this.direction.copy(baseDirection);

    if (request.spread > 0) {
      this.applySpread(this.direction, request.spread);
    }
    this.direction.normalize();

    this.raycaster.set(this.origin, this.direction);
    this.raycaster.near = 0;
    this.raycaster.far = request.range;

    const worldHit = this.collision.raycast(this.origin, this.direction, request.range);
    const worldDistance = worldHit ? worldHit.distance : Number.POSITIVE_INFINITY;

    const targets = this.director.hitboxTargets();
    let nearestZombie: Zombie | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearestZone: HitZone = 'body';
    let nearestPoint: Vector3 | null = null;

    if (targets.length > 0) {
      const intersections = this.raycaster.intersectObjects(targets, false);
      for (const intersection of intersections) {
        if (intersection.distance >= nearestDistance) continue;
        const owner = findOwningZombie(intersection.object, this.director);
        if (!owner || !owner.isAlive) continue;
        if (intersection.distance > worldDistance) continue;
        nearestZombie = owner;
        nearestDistance = intersection.distance;
        nearestZone = intersection.object.userData.hitZone === 'head' ? 'head' : 'body';
        nearestPoint = intersection.point;
      }
    }

    if (nearestZombie && nearestPoint) {
      const multiplier = nearestZone === 'head' ? request.headshotMultiplier : 1;
      const damage = request.damage * multiplier;
      const outcome = nearestZombie.applyDamage(damage);
      this.point.copy(nearestPoint);
      const pointTuple: Vec3Tuple = [this.point.x, this.point.y, this.point.z];

      this.events.emit('combat:hit', {
        zone: nearestZone,
        killed: outcome.died,
        kind: nearestZombie.kind,
        point: pointTuple,
      });
      if (outcome.died) {
        // Separate event for statistics and drops: the HUD/game-over screens
        // count kills from this, not from the hit feedback event.
        this.events.emit('zombie:killed', { kind: nearestZombie.kind, kills: 0 });
      }

      return {
        target: 'zombie',
        zone: nearestZone,
        killed: outcome.died,
        kind: nearestZombie.kind,
        distance: nearestDistance,
        point: this.point.clone(),
        damage: outcome.applied,
      };
    }

    if (worldHit) {
      this.point.set(worldHit.pointX, worldHit.pointY, worldHit.pointZ);
      this.events.emit('combat:world-hit', {
        tag: worldHit.tag,
        point: [this.point.x, this.point.y, this.point.z],
      });
      return {
        target: 'world',
        zone: 'body',
        killed: false,
        kind: null,
        distance: worldHit.distance,
        point: this.point.clone(),
        damage: 0,
      };
    }

    this.point.copy(this.origin).addScaledVector(this.direction, request.range);
    this.events.emit('combat:miss', {});
    return {
      target: 'none',
      zone: 'body',
      killed: false,
      kind: null,
      distance: request.range,
      point: this.point.clone(),
      damage: 0,
    };
  }

  /** Tilts the aim vector inside a small cone, in camera-local terms. */
  private applySpread(direction: Vector3, spread: number): void {
    spreadDirection(
      direction,
      this.random.range(0, Math.PI * 2),
      this.random.range(0, spread),
    );
  }
}

/** Walks up from a hitbox mesh to the entity that owns it. */
function findOwningZombie(hitbox: Object3D, director: ZombieDirector): Zombie | null {
  for (const zombie of director.list) {
    if (zombie.hitboxes.includes(hitbox)) return zombie;
  }
  return null;
}
