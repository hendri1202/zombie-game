import { Vector3 } from 'three';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Tuple } from '../app/GameEvents';
import type { CollisionWorld } from '../level/CollisionWorld';
import type { Zombie } from '../zombies/Zombie';
import type { ZombieDirector } from '../zombies/ZombieDirector';
import type { ZombieKind } from '../app/gameConfig';

/**
 * Height on the target's body a swing is reported as landing on, as a fraction of its
 * height. Chest, not feet: the blood spurt and the hitmarker read as a body hit there.
 */
const HIT_HEIGHT_FRACTION = 0.55;
/** Below this distance there is nothing between the two bodies to test for. */
const WALL_CHECK_MIN_DISTANCE = 0.05;

/** One candidate the swing cone is tested against. Plain numbers, so a test needs no scene. */
export interface MeleeCandidate {
  id: number;
  x: number;
  z: number;
  /** Collision radius, metres. Reach is measured to this surface, not to the centre. */
  radius: number;
  alive: boolean;
}

export interface MeleeTargetHit {
  target: MeleeCandidate;
  /** Metres from the swing origin to the target's centre. */
  distance: number;
  /** Angle away from the swing's forward axis, radians, always >= 0. */
  angle: number;
}

/**
 * Distance and angle from a swing to a point.
 *
 * Forward is `(sin yaw, cos yaw)`, the convention `PlayerController.facingAngle` and the
 * zombies already share, so "in front of the player" cannot mean two different things in
 * two subsystems. The angle is unsigned: a swing cone is symmetric.
 */
export function meleeBearing(
  origin: { x: number; z: number },
  forwardYaw: number,
  point: { x: number; z: number },
): { distance: number; angle: number } {
  const dx = point.x - origin.x;
  const dz = point.z - origin.z;
  const forwardX = Math.sin(forwardYaw);
  const forwardZ = Math.cos(forwardYaw);
  return {
    distance: Math.hypot(dx, dz),
    angle: Math.abs(Math.atan2(forwardX * dz - forwardZ * dx, forwardX * dx + forwardZ * dz)),
  };
}

/**
 * Every live target inside the swing cone, nearest first.
 *
 * A melee hit is a sweep, not a ray: a ray would only ever catch whatever the crosshair
 * happens to be on, and a bat landing on the zombie beside the one you are looking at
 * would feel broken. So the cone is the shape — targets whose *surface* is within `reach`
 * and whose direction is within `arc / 2` of the facing.
 *
 * The whole list is returned sorted rather than just the nearest, because the caller still
 * has to walk it: the nearest target may be behind a wall, and the next one in the arc is
 * then the swing that connects.
 *
 * Deliberately pure — no scene, no director, no collision world — so the geometry that
 * decides whether a swing lands is testable without a browser (see tests/melee.test.ts).
 */
export function selectMeleeTargets(
  origin: { x: number; z: number },
  forwardYaw: number,
  targets: readonly MeleeCandidate[],
  arc: number,
  reach: number,
): MeleeTargetHit[] {
  const halfArc = Math.max(0, arc) / 2;
  const hits: MeleeTargetHit[] = [];
  for (const target of targets) {
    if (!target.alive) continue;
    const bearing = meleeBearing(origin, forwardYaw, target);
    // Measuring to the surface keeps the reach honest across body sizes: without the
    // radius a brute would need the player further back than a runner to be hit at all.
    if (bearing.distance - Math.max(0, target.radius) > reach) continue;
    if (bearing.angle > halfArc) continue;
    hits.push({ target, distance: bearing.distance, angle: bearing.angle });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

/** The nearest target a swing would land on, or null. */
export function selectMeleeTarget(
  origin: { x: number; z: number },
  forwardYaw: number,
  targets: readonly MeleeCandidate[],
  arc: number,
  reach: number,
): MeleeCandidate | null {
  return selectMeleeTargets(origin, forwardYaw, targets, arc, reach)[0]?.target ?? null;
}

/**
 * Shape of one swing, 0 at rest, 1 at full extension.
 *
 * A sine half-wave, not a straight ramp: the weapon has to start and stop at the same
 * place or the view model snaps at both ends of every swing, which is more obvious than
 * the swing itself. Exported so both the hit window and the first-person pose use one
 * definition of where in the swing things happen.
 */
export function meleeSwingCurve(progress: number): number {
  const clamped = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  return Math.sin(Math.PI * clamped);
}

export interface MeleeSwingRequest {
  /** Where the swing comes from: the player's eye. */
  origin: Vector3;
  /** Facing the cone points along, in the `facingAngle` convention. */
  forwardYaw: number;
  damage: number;
  /** Total swing arc in radians. */
  arc: number;
  reach: number;
}

export interface MeleeSwingReport {
  target: 'zombie' | 'none';
  /** Director id of the zombie that was hit, or null. */
  targetId: number | null;
  kind: ZombieKind | null;
  killed: boolean;
  distance: number;
  point: Vector3;
  /** Damage actually applied, 0 for a swing that connected with nothing. */
  damage: number;
}

export interface MeleeSystemDeps {
  director: ZombieDirector;
  collision: CollisionWorld;
  events: EventBus<GameEvents>;
}

/**
 * Resolves one melee swing.
 *
 * One target per swing, not the whole arc: the brief's table has no cleave value, and
 * damage-per-swing equal to the weapon's damage is what makes the balance numbers in
 * `meleeConfig` mean something. `selectMeleeTargets` returns the full sorted arc, so a
 * cleave stat later is a one-line change here rather than a rewrite.
 */
export class MeleeSystem {
  private readonly director: ZombieDirector;
  private readonly collision: CollisionWorld;
  private readonly events: EventBus<GameEvents>;
  /** Reused: a swing allocates its candidate list but nothing else. */
  private readonly direction = new Vector3();
  private readonly point = new Vector3();

  constructor(deps: MeleeSystemDeps) {
    this.director = deps.director;
    this.collision = deps.collision;
    this.events = deps.events;
  }

  swing(request: MeleeSwingRequest): MeleeSwingReport {
    const candidates: MeleeCandidate[] = [];
    for (const zombie of this.director.list) {
      candidates.push({
        id: zombie.id,
        x: zombie.position.x,
        z: zombie.position.z,
        radius: zombie.stats.radius,
        alive: zombie.isAlive,
      });
    }

    const hits = selectMeleeTargets(request.origin, request.forwardYaw, candidates, request.arc, request.reach);
    for (const hit of hits) {
      // Nearest first, so a swing at a wall does not skip the zombie in front of it: the
      // blocked target is dropped and the next one in the arc gets the blow.
      if (!this.hasClearPath(request.origin, hit.target, hit.distance)) continue;
      const zombie = this.findZombie(hit.target.id);
      if (!zombie || !zombie.isAlive) continue;

      const outcome = zombie.applyDamage(request.damage);
      this.point.set(hit.target.x, zombie.stats.height * HIT_HEIGHT_FRACTION, hit.target.z);
      const point: Vec3Tuple = [this.point.x, this.point.y, this.point.z];
      // The same payload a bullet emits, on purpose: the hitmarker, the blood spurt, the
      // hit sound and the drop roll all listen on 'combat:hit', so melee feedback is the
      // gunfire feedback and the two can never drift apart.
      this.events.emit('combat:hit', {
        zone: 'body',
        killed: outcome.died,
        kind: zombie.kind,
        point,
      });
      if (outcome.died) {
        // Kills are counted from this event, not from the hit that caused it.
        this.events.emit('zombie:killed', { kind: zombie.kind, kills: 0 });
      }

      return {
        target: 'zombie',
        targetId: zombie.id,
        kind: zombie.kind,
        killed: outcome.died,
        distance: hit.distance,
        point: this.point.clone(),
        damage: outcome.applied,
      };
    }

    // A swing through empty air still happened: the arc's end point is reported so the
    // caller has somewhere real to put a whoosh or a miss.
    this.direction.set(Math.sin(request.forwardYaw), 0, Math.cos(request.forwardYaw));
    this.point.copy(request.origin).addScaledVector(this.direction, request.reach);
    return {
      target: 'none',
      targetId: null,
      kind: null,
      killed: false,
      distance: request.reach,
      point: this.point.clone(),
      damage: 0,
    };
  }

  /**
   * True when no wall stands between the swing and the target.
   *
   * Melee is not exempt from geometry: a bat cannot reach through a wall the player is
   * standing against. The ray is flat and at eye height, which is what makes the
   * collision world ignore the low step-over props and stop at the full-height walls,
   * exactly as the zombies' own line-of-sight test does.
   */
  private hasClearPath(origin: Vector3, target: MeleeCandidate, distance: number): boolean {
    const toSurface = distance - Math.max(0, target.radius);
    if (toSurface <= WALL_CHECK_MIN_DISTANCE) return true;
    this.direction.set(target.x - origin.x, 0, target.z - origin.z);
    if (this.direction.lengthSq() < 1e-8) return true;
    this.direction.normalize();
    return this.collision.raycast(origin, this.direction, toSurface) === null;
  }

  private findZombie(id: number): Zombie | null {
    for (const zombie of this.director.list) {
      if (zombie.id === id) return zombie;
    }
    return null;
  }
}
