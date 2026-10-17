import {
  AdditiveBlending, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  RingGeometry, Scene, SphereGeometry, TorusGeometry, Vector3,
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
 * The blast, drawn: how long it lasts in seconds, and the fractions of the radius the pieces of
 * it start at and grow to.
 *
 * The visual used to be whatever the shared impact dust happened to be — three quads of an
 * eleventh of a metre, at the very centre — which is why a 6 m blast read as a spark. A blast has
 * a size and the effect has to state it, so the shockwave ring is left at exactly `config.radius`:
 * the drawn edge of the explosion and the edge the damage used are the same number, by
 * construction rather than by eye.
 *
 * Three pieces, because one sphere at full radius over the whole street reads as fog: a small hot
 * core for the punch, a fireball that grows into the middle of the radius, and the ring that
 * carries the edge outward to the rim. The first frames of a captured 8 m blast were a pale dome
 * with no readable edge — that is what the split is for.
 *
 * Fast and short on purpose. A lingering explosion reads as a smoke cloud, and this is the
 * read-out of a blast already resolved in the frame it spawned.
 */
const BLAST_SECONDS = 0.45;
/** Fireball: starts at the core's edge, stops short of the rim so the ring has something to say. */
const BLAST_FIREBALL_START = 0.3;
const BLAST_FIREBALL_END = 0.7;
/** The hot core, which is over almost at once. */
const BLAST_CORE_START = 0.18;
const BLAST_CORE_END = 0.3;
/** The shockwave ring: starts inset, and its last frame is the radius itself. */
const BLAST_RING_START = 0.55;
/**
 * Fraction of the life at which each piece starts to fade.
 *
 * The ring is held almost to the end, because it is the piece that states the size: fading it on
 * the same curve as the fireball left the widest frames of a captured 8 m blast with a barely
 * visible edge — exactly the complaint this change is answering.
 */
const BLAST_FADE_START = 0.5;
const BLAST_RING_FADE_START = 0.65;
/** Fireball, core and ring colours. Warm, so it reads as fire against the cold street. */
const BLAST_FIREBALL_COLOR = 0xff7a2a;
const BLAST_CORE_COLOR = 0xfff0c0;
const BLAST_RING_COLOR = 0xffb257;

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
 * One explosion being drawn.
 *
 * Its own materials rather than the shared ones: the fade is per-blast (two grenades can be in
 * the air together) and a material carries the opacity, so this is the one thing a blast cannot
 * share. The geometry is shared, so an explosion costs two meshes and no allocation of vertices.
 */
interface BlastVisual {
  group: Group;
  fireball: Mesh;
  core: Mesh;
  ring: Mesh;
  fireballMaterial: MeshBasicMaterial;
  coreMaterial: MeshBasicMaterial;
  ringMaterial: MeshBasicMaterial;
  /** The radius this blast is drawn at, metres: the config radius at the moment it went off. */
  radius: number;
  /** Seconds of life remaining. */
  life: number;
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
  /** Explosions currently drawn: one per blast, cleared when it fades. */
  private readonly blasts: BlastVisual[] = [];
  /** Grenades in the player's pouch. Limited on purpose; this is the whole resource. */
  private count: number;
  private thrownTotal = 0;
  private readonly direction = new Vector3();
  private readonly losOrigin = new Vector3();
  private readonly meshGeometry: SphereGeometry | null = null;
  private readonly bandGeometry: TorusGeometry | null = null;
  private readonly meshMaterial: MeshStandardMaterial | null = null;
  /** Unit sphere and unit ring, scaled per explosion to the blast radius. Shared, like the meshes. */
  private readonly blastSphereGeometry: SphereGeometry | null = null;
  private readonly blastRingGeometry: RingGeometry | null = null;

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
      // The blast, at unit size: scaled to `config.radius` per explosion (see spawnBlast), so the
      // fireball and the ground ring always state the radius the damage actually used.
      this.blastSphereGeometry = new SphereGeometry(1, 24, 16);
      this.blastRingGeometry = new RingGeometry(0.86, 1, 48);
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

  /** Explosions currently drawn. One per blast, gone when it fades — for diagnostics and tests. */
  get blastCount(): number {
    return this.blasts.length;
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
    this.updateBlasts(delta);
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
    // The blast is drawn at the radius the damage used, so what the player sees is the area that
    // was actually resolved (see spawnBlast).
    this.spawnBlast(position);
    // A blast is an impact on the world too: this is what puts the burst and the dust on screen
    // at the point of detonation, through the effect path the guns already use.
    this.events.emit('combat:world-hit', { tag: 'grenade', point });
    return { point, radius: this.config.radius, damage: totalDamage, damaged, killed };
  }

  /** Removes every projectile in flight without detonating it, and every blast still drawn. */
  clear(): void {
    for (let index = this.live.length - 1; index >= 0; index -= 1) this.removeAt(index);
    for (let index = this.blasts.length - 1; index >= 0; index -= 1) this.releaseBlast(index);
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
    this.blastSphereGeometry?.dispose();
    this.blastRingGeometry?.dispose();
  }

  // -------------------------------------------------------------------------
  // The blast, drawn
  // -------------------------------------------------------------------------

  /**
   * Draws one explosion, sized to the blast radius.
   *
   * Three pieces, all scaled from the same shared unit geometry: a hot core, a fireball that grows
   * into the middle of the radius, and a flat shockwave ring that sweeps out to exactly the
   * radius and dies there. The ring is the point: the old effect was a handful of dust quads a
   * tenth of a metre wide, so for a 6 m blast the player could not see where it ended. The ring
   * shows the footprint the damage rules use — and the fireball stops short of it, so the edge the
   * player reads is the edge the damage used.
   *
   * Nothing here runs without a scene: the damage has already been applied by the time this is
   * called, and every unit test exercises `explode` with `scene: null`.
   *
   * @returns The group that was added, or null when there is no scene to draw in.
   */
  private spawnBlast(position: Vector3): Group | null {
    if (!this.scene || !this.blastSphereGeometry || !this.blastRingGeometry) return null;
    const radius = this.config.radius;
    if (!(radius > 0)) return null;

    const group = new Group();
    group.name = 'GrenadeBlast';
    group.position.set(position.x, Math.max(position.y, GROUND_Y), position.z);

    // Each piece gets its own materials: the opacity is the fade and has to be per-blast, since
    // two grenades can be in the air together. The geometry is shared, so a blast allocates three
    // materials and no vertices.
    const makeFlash = (color: number, opacity: number): MeshBasicMaterial => new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const fireballMaterial = makeFlash(BLAST_FIREBALL_COLOR, 0.55);
    const coreMaterial = makeFlash(BLAST_CORE_COLOR, 0.95);
    const ringMaterial = makeFlash(BLAST_RING_COLOR, 0.9);

    // A little above the road, or half of every sphere is under it and the burst reads as a
    // puddle. The ring stays on the ground, because a footprint belongs there.
    const lift = radius * 0.2;
    const fireball = new Mesh(this.blastSphereGeometry, fireballMaterial);
    fireball.name = 'GrenadeBlastFireball';
    fireball.position.y = lift;
    fireball.scale.setScalar(radius * BLAST_FIREBALL_START);
    fireball.renderOrder = 6;

    const core = new Mesh(this.blastSphereGeometry, coreMaterial);
    core.name = 'GrenadeBlastCore';
    core.position.y = lift;
    core.scale.setScalar(radius * BLAST_CORE_START);
    core.renderOrder = 7;

    const ring = new Mesh(this.blastRingGeometry, ringMaterial);
    ring.name = 'GrenadeBlastRing';
    // Laid flat so it is a footprint on the road, and nudged up off it: coplanar with the ground
    // it would z-fight with the road at this size.
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    ring.scale.setScalar(radius * BLAST_RING_START);
    ring.renderOrder = 6;
    // Side-on the ring is a line, so it is given some body to read from eye height.
    ringMaterial.side = DoubleSide;

    group.add(fireball, core, ring);
    this.scene.add(group);
    this.blasts.push({
      group, fireball, core, ring, fireballMaterial, coreMaterial, ringMaterial, radius,
      life: BLAST_SECONDS,
    });
    return group;
  }

  /** Grows and fades every blast being drawn, and drops the ones whose life has run out. */
  private updateBlasts(delta: number): void {
    for (let index = this.blasts.length - 1; index >= 0; index -= 1) {
      const blast = this.blasts[index];
      blast.life -= delta;
      if (blast.life <= 0) {
        this.releaseBlast(index);
        continue;
      }
      const progress = 1 - blast.life / BLAST_SECONDS;
      // The last frame of the sweep is the radius itself: the drawn explosion ends exactly where
      // the damage stopped, which is what the tests assert.
      blast.ring.scale.setScalar(blast.radius * (BLAST_RING_START + (1 - BLAST_RING_START) * progress));
      blast.fireball.scale.setScalar(
        blast.radius * (BLAST_FIREBALL_START + (BLAST_FIREBALL_END - BLAST_FIREBALL_START) * progress),
      );
      blast.core.scale.setScalar(
        blast.radius * (BLAST_CORE_START + (BLAST_CORE_END - BLAST_CORE_START) * progress),
      );
      // Bright while they grow, and only faded out over the second half: an explosion that starts
      // dimming on the frame it appears never reads as one. The ring is held longer still, since
      // it is the piece that shows the player how big the blast was.
      const fade = Math.max(0, 1 - (Math.max(0, progress - BLAST_FADE_START) / (1 - BLAST_FADE_START)));
      const ringFade = Math.max(0, 1 - (Math.max(0, progress - BLAST_RING_FADE_START) / (1 - BLAST_RING_FADE_START)));
      blast.fireballMaterial.opacity = 0.55 * fade;
      blast.ringMaterial.opacity = 0.9 * ringFade;
      // The core is over almost at once; it is the pop, not the shape.
      blast.coreMaterial.opacity = 0.95 * (1 - progress);
    }
  }

  private releaseBlast(index: number): void {
    const blast = this.blasts[index];
    blast.group.removeFromParent();
    blast.fireballMaterial.dispose();
    blast.coreMaterial.dispose();
    blast.ringMaterial.dispose();
    this.blasts.splice(index, 1);
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
