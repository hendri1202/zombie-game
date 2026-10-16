import {
  Group, Mesh, MeshStandardMaterial, Object3D, Scene, SphereGeometry, TorusGeometry, Vector3,
} from 'three';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Tuple } from '../app/GameEvents';
import type { CollisionWorld } from '../level/CollisionWorld';
import type { Zombie } from '../zombies/Zombie';
import type { ZombieDirector } from '../zombies/ZombieDirector';
import { DEFAULT_GRENADE, GRENADE_GRAVITY, GRENADES, type GrenadeConfig, type GrenadeId } from '../app/grenadeConfig';

/**
 * Below this height the grenade is on the ground and stops moving. Its own radius, so a 0.06
 * m sphere does not sink into the road.
 */
const GROUND_Y = 0.12;
/** Physics sub-step, seconds. Small on purpose: a thrown grenade moves ~0.23 m per step. */
const PHYSICS_STEP = 0.02;
/** Blast line-of-sight is traced flat at this height, like melee: a blast does not creep under a step-over prop. */
const BLAST_LOS_HEIGHT = 1.0;
/** Below this the two bodies are touching and there is nothing between them to test for. */
const WALL_CHECK_MIN_DISTANCE = 0.05;

/**
 * Damage of one blast at a given distance from its centre.
 *
 * Linear falloff: full damage at the centre, nothing at the rim, and a straight line between
 * the two. Deliberately pure and free of any scene, collision world or three.js object, so the
 * whole rule — including the exact point where a blast stops being lethal — is a unit test
 * rather than something only a running game can demonstrate (see tests/slots-and-grenades.test.ts).
 *
 * `distance` at or beyond `radius` returns exactly 0, which is what makes "the blast does not
 * reach past its radius" true by construction instead of by a caller remembering to check.
 */
export function grenadeDamageAt(distance: number, radius: number, maxDamage: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(radius) || !Number.isFinite(maxDamage)) return 0;
  if (radius <= 0 || maxDamage <= 0) return 0;
  if (distance >= radius) return 0;
  if (distance <= 0) return maxDamage;
  return maxDamage * (1 - distance / radius);
}

/** One candidate a blast is tested against. Plain numbers, so a test needs no scene. */
export interface GrenadeCandidate {
  id: number;
  x: number;
  z: number;
  /** Collision radius, metres. Used for the surface test, not for the damage falloff. */
  radius: number;
  alive: boolean;
}

export interface GrenadeTargetHit {
  target: GrenadeCandidate;
  /** Metres from the blast centre to the centre of the target. */
  distance: number;
}

/**
 * Every live target inside the blast, nearest first.
 *
 * The same shape as `selectMeleeTargets`, because a blast and a swing answer the same
 * question — "what is within reach of this point" — and giving the two different answers would
 * make "in range" mean two things. The whole list is returned rather than just the nearest:
 * the caller still has to walk it, since a target behind a wall is skipped and the next one
 * out is then still caught by the same blast.
 *
 * Pure, so the geometry of the blast is testable without a browser.
 */
export function selectGrenadeTargets(
  center: { x: number; z: number },
  targets: readonly GrenadeCandidate[],
  blastRadius: number,
): GrenadeTargetHit[] {
  const hits: GrenadeTargetHit[] = [];
  if (!(blastRadius > 0)) return hits;
  for (const target of targets) {
    if (!target.alive) continue;
    const distance = Math.hypot(target.x - center.x, target.z - center.z);
    // Measured to the target's surface so a brute is not missed by a blast that clipped its
    // shoulder: a bigger body is a bigger target, for a blast as much as for a bullet.
    if (distance - Math.max(0, target.radius) > blastRadius) continue;
    hits.push({ target, distance });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

export interface GrenadeExplosionReport {
  point: Vec3Tuple;
  radius: number;
  /** Total damage actually applied across every target caught. */
  damage: number;
  /** Targets the blast touched, walls included in the count as not touched. */
  damaged: number;
  killed: number;
}

export interface GrenadeSystemDeps {
  /** Scene to draw the projectiles in. Null in a unit test: the logic runs without one. */
  scene: Scene | null;
  director: ZombieDirector;
  collision: CollisionWorld;
  events: EventBus<GameEvents>;
  grenade?: GrenadeId;
}

interface LiveGrenade {
  position: Vector3;
  velocity: Vector3;
  /** Seconds left before detonation. */
  fuse: number;
  /** True once it has come to rest against the ground or a wall; physics stops, the fuse does not. */
  resting: boolean;
  object: Object3D | null;
}

/**
 * Thrown grenades: flight, fuse and blast.
 *
 * Deliberately small and self-contained. The flight is a moving point under gravity that asks
 * the shared `CollisionWorld` before every step, so a grenade cannot pass through a wall; the
 * blast is a radius test whose wall check is the same flat ray the melee swing uses, so an
 * explosion cannot reach through a building either. The count is the resource: it is spent on
 * the throw, refilled by the store and by drops, and shown in the HUD.
 *
 * Nothing here touches the firearm or melee paths: it is handed a world and it reports through
 * events, exactly as `MeleeSystem` does.
 */
export class GrenadeSystem {
  readonly config: GrenadeConfig;
  private readonly scene: Scene | null;
  private readonly director: ZombieDirector;
  private readonly collision: CollisionWorld;
  private readonly events: EventBus<GameEvents>;
  private readonly live: LiveGrenade[] = [];
  /** Grenades in the player's pouch. Limited on purpose; this is the whole resource. */
  private count: number;
  private thrownTotal = 0;
  private readonly direction = new Vector3();
  private readonly losOrigin = new Vector3();
  private readonly meshGeometry: SphereGeometry | null = null;
  private readonly bandGeometry: TorusGeometry | null = null;
  private readonly meshMaterial: MeshStandardMaterial | null = null;

  constructor(deps: GrenadeSystemDeps) {
    this.config = GRENADES[deps.grenade ?? DEFAULT_GRENADE];
    this.scene = deps.scene;
    this.director = deps.director;
    this.collision = deps.collision;
    this.events = deps.events;
    this.count = this.config.startingCount;

    if (this.scene) {
      // Geometry is created once and shared by every projectile in flight — a grenade is a
      // handful of meshes, but a throwing spree must not allocate a sphere per throw.
      this.meshGeometry = new SphereGeometry(0.06, 12, 8);
      this.bandGeometry = new TorusGeometry(0.06, 0.012, 6, 12);
      this.meshMaterial = new MeshStandardMaterial({ color: 0x3f4a35, roughness: 0.6, metalness: 0.5 });
    }
  }

  /** Grenades left in the pouch. What the HUD shows and the store tops up. */
  get available(): number {
    return this.count;
  }

  /** Projectiles in the air, for diagnostics and tests. */
  get liveCount(): number {
    return this.live.length;
  }

  /**
   * Where the grenades in flight are right now.
   *
   * Read-only snapshots rather than the live vectors: a test that asked where a thrown grenade
   * got to needs the answer, not a handle it can move from outside the physics.
   */
  get livePositions(): ReadonlyArray<{ x: number; y: number; z: number }> {
    return this.live.map((grenade) => ({
      x: grenade.position.x, y: grenade.position.y, z: grenade.position.z,
    }));
  }

  get thrown(): number {
    return this.thrownTotal;
  }

  /** Adds grenades (a purchase, a pickup) and returns the new total. */
  add(amount: number): number {
    const add = Math.floor(amount);
    if (!Number.isFinite(add) || add <= 0) return this.count;
    this.count += add;
    return this.count;
  }

  /** Back to the starting pouch with nothing in the air. Every run restart goes through here. */
  reset(): void {
    this.clear();
    this.count = this.config.startingCount;
    this.thrownTotal = 0;
  }

  /** Empties the pouch, for a test or a mode with no ordnance. */
  setCount(count: number): void {
    this.count = Math.max(0, Math.floor(count));
  }

  /**
   * Throws one grenade along `direction`, if the pouch is not empty.
   *
   * The lift is added here rather than baked into the aim vector so the arc is the weapon's
   * property: the player aims at a target and the grenade lobs towards it, instead of having
   * to aim above the target the way a thrown rock would demand.
   */
  throw(origin: Vector3, direction: Vector3): boolean {
    if (this.count <= 0) return false;
    if (this.live.length >= this.config.maxLive) return false;

    const velocity = direction.clone();
    if (velocity.lengthSq() < 1e-8) velocity.set(0, 0, 1);
    velocity.normalize().multiplyScalar(this.config.throwSpeed);
    velocity.y += this.config.throwLift;

    const position = origin.clone();
    this.count -= 1;
    this.thrownTotal += 1;
    this.live.push({
      position,
      velocity,
      fuse: this.config.fuseSeconds,
      resting: false,
      object: this.spawnMesh(position),
    });
    this.events.emit('grenade:thrown', { count: this.count });
    return true;
  }

  /** Advances every grenade in flight and detonates the ones whose fuse has run out. */
  update(delta: number): void {
    if (!(delta > 0)) return;
    for (let index = this.live.length - 1; index >= 0; index -= 1) {
      const grenade = this.live[index];
      this.integrate(grenade, delta);
      grenade.fuse -= delta;
      if (grenade.fuse <= 0) {
        this.detonate(index);
      } else if (this.outOfBounds(grenade.position)) {
        // Flew clear of the map: it leaves rather than detonating at the world edge or leaking.
        this.removeAt(index);
      }
    }
  }

  /**
   * One blast at `position`.
   *
   * Public so the blast rule can be exercised directly, without having to fly a projectile to
   * the spot first. Damage is the falloff from `grenadeDamageAt`, gated by a wall check so the
   * explosion cannot reach a target the player cannot see through geometry.
   */
  explode(position: Vector3): GrenadeExplosionReport {
    const candidates: GrenadeCandidate[] = [];
    for (const zombie of this.director.list) {
      candidates.push({
        id: zombie.id,
        x: zombie.position.x,
        z: zombie.position.z,
        radius: zombie.stats.radius,
        alive: zombie.isAlive,
      });
    }

    const hits = selectGrenadeTargets(position, candidates, this.config.radius);
    let totalDamage = 0;
    let damaged = 0;
    let killed = 0;
    for (const hit of hits) {
      if (!this.hasClearPath(position, hit.target, hit.distance)) continue;
      const damage = grenadeDamageAt(hit.distance, this.config.radius, this.config.maxDamage);
      if (damage <= 0) continue;
      const zombie = this.findZombie(hit.target.id);
      if (!zombie || !zombie.isAlive) continue;

      const outcome = zombie.applyDamage(damage);
      totalDamage += outcome.applied;
      damaged += 1;
      if (outcome.died) {
        killed += 1;
        this.events.emit('zombie:killed', { kind: zombie.kind, kills: 0 });
      }
      // The same payload a bullet emits, so the hitmarker, the blood spurt and the drop roll
      // react to a grenade exactly as they react to a shot.
      this.events.emit('combat:hit', {
        zone: 'body',
        killed: outcome.died,
        kind: zombie.kind,
        point: [
          hit.target.x,
          zombie.stats.height * 0.55,
          hit.target.z,
        ] satisfies Vec3Tuple,
      });
    }

    const point: Vec3Tuple = [position.x, Math.max(position.y, GROUND_Y), position.z];
    // A blast is an impact on the world too: this is what puts the burst and the dust on screen
    // at the point of detonation, through the effect path the guns already use.
    this.events.emit('combat:world-hit', { tag: 'grenade', point });
    return { point, radius: this.config.radius, damage: totalDamage, damaged, killed };
  }

  /** Removes every projectile in flight without detonating it. */
  clear(): void {
    for (let index = this.live.length - 1; index >= 0; index -= 1) this.removeAt(index);
  }

  /** Live state, for the smoke harness. */
  report(): { count: number; live: number; thrown: number } {
    return { count: this.count, live: this.live.length, thrown: this.thrownTotal };
  }

  dispose(): void {
    this.clear();
    this.meshGeometry?.dispose();
    this.bandGeometry?.dispose();
    this.meshMaterial?.dispose();
  }

  // -------------------------------------------------------------------------
  // Flight
  // -------------------------------------------------------------------------

  /**
   * Moves one grenade for one frame, in fixed sub-steps.
   *
   * The sub-steps are the whole point: at fourteen metres a second a grenade covers a quarter
   * of a metre in a frame, and a single step tested against a wall would let it jump clean
   * through a thin one. Every step is a raycast against the shared collision world, so a
   * grenade stops against geometry instead of appearing on the far side of it.
   */
  private integrate(grenade: LiveGrenade, delta: number): void {
    if (grenade.resting) return;
    let remaining = delta;
    while (remaining > 1e-6) {
      const step = Math.min(remaining, PHYSICS_STEP);
      remaining -= step;

      grenade.velocity.y -= GRENADE_GRAVITY * step;

      const moveX = grenade.velocity.x * step;
      const moveY = grenade.velocity.y * step;
      const moveZ = grenade.velocity.z * step;
      const stepLength = Math.hypot(moveX, moveY, moveZ);

      if (stepLength > 1e-6) {
        this.direction.set(moveX, moveY, moveZ).multiplyScalar(1 / stepLength);
        const hit = this.collision.raycast(grenade.position, this.direction, stepLength);
        if (hit) {
          // Stop against the wall rather than sliding along it: a grenade that keeps its
          // speed would need a bounce model, and "it lies where it lands" is both simpler and
          // unambiguous about never being on the far side of the geometry.
          grenade.position.set(hit.pointX, hit.pointY, hit.pointZ);
          grenade.position.addScaledVector(this.direction, -0.08);
          grenade.velocity.set(0, 0, 0);
          grenade.resting = true;
          this.syncMesh(grenade);
          return;
        }
        grenade.position.x += moveX;
        grenade.position.y += moveY;
        grenade.position.z += moveZ;
      }

      if (grenade.position.y <= GROUND_Y) {
        grenade.position.y = GROUND_Y;
        grenade.velocity.set(0, 0, 0);
        grenade.resting = true;
        this.syncMesh(grenade);
        return;
      }
    }
    this.syncMesh(grenade);
  }

  private detonate(index: number): void {
    const grenade = this.live[index];
    const report = this.explode(grenade.position);
    this.removeAt(index);
    this.events.emit('grenade:exploded', {
      point: report.point,
      radius: report.radius,
      damage: report.damage,
      killed: report.killed,
    });
  }

  /**
   * True when no wall stands between the blast and the target.
   *
   * A flat ray at chest height, the same one `MeleeSystem.hasClearPath` uses: it makes the
   * collision world ignore the low props a player steps over and stop at full-height walls, so
   * "you cannot grenade through a building" is enforced by the same geometry that stops the
   * player walking through it.
   */
  private hasClearPath(origin: Vector3, target: GrenadeCandidate, distance: number): boolean {
    const toSurface = distance - Math.max(0, target.radius);
    if (toSurface <= WALL_CHECK_MIN_DISTANCE) return true;
    this.direction.set(target.x - origin.x, 0, target.z - origin.z);
    if (this.direction.lengthSq() < 1e-8) return true;
    this.direction.normalize();
    this.losOrigin.set(origin.x, BLAST_LOS_HEIGHT, origin.z);
    return this.collision.raycast(this.losOrigin, this.direction, toSurface) === null;
  }

  private outOfBounds(position: Vector3): boolean {
    const bounds = this.collision.bounds;
    const margin = 20;
    return position.x < bounds.minX - margin || position.x > bounds.maxX + margin
      || position.z < bounds.minZ - margin || position.z > bounds.maxZ + margin
      || position.y < -10;
  }

  private findZombie(id: number): Zombie | null {
    for (const zombie of this.director.list) {
      if (zombie.id === id) return zombie;
    }
    return null;
  }

  private spawnMesh(position: Vector3): Object3D | null {
    if (!this.scene || !this.meshGeometry || !this.bandGeometry || !this.meshMaterial) return null;
    const group = new Group();
    group.name = `Grenade:${this.thrownTotal}`;
    const body = new Mesh(this.meshGeometry, this.meshMaterial);
    body.castShadow = false;
    const band = new Mesh(this.bandGeometry, this.meshMaterial);
    band.rotation.x = Math.PI / 2;
    group.add(body, band);
    group.position.copy(position);
    this.scene.add(group);
    return group;
  }

  private syncMesh(grenade: LiveGrenade): void {
    grenade.object?.position.copy(grenade.position);
  }

  private removeAt(index: number): void {
    const grenade = this.live[index];
    grenade.object?.removeFromParent();
    this.live.splice(index, 1);
  }
}
