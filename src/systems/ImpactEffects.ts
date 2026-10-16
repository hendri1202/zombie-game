import {
  AdditiveBlending, BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  NormalBlending, PlaneGeometry, Scene, Vector3,
} from 'three';
import { MATERIAL_IMPACTS, WEAPON_FEEL, materialForTag, type MaterialImpactProfile, type MaterialKind } from '../app/gameConfig';
import type { Disposable } from '../core/Disposable';
import type { RandomSource } from '../utils/math';

interface Impact {
  mesh: Mesh;
  position: Vector3;
  /** Seconds of life remaining. */
  life: number;
  /** Life the spark was spawned with, so the fade is per-spark rather than global. */
  maxLife: number;
  /** 0 for a world hit, 1 for flesh, 2 for a head hit. */
  kind: number;
  /** Base size in metres. */
  size: number;
  spin: number;
}

interface Casing {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
  /** Seconds of life remaining. */
  life: number;
}

/** Gravity applied to an ejected casing, m/s^2 (a little heavy so it lands quickly). */
const CASING_GRAVITY = 9.8;

/**
 * The floor on live sparks, whatever the quality preset asks for.
 *
 * The low preset sets `particleBudget` to 0, and before this the whole system
 * early-returned on that: a wall shot at `low` drew nothing at all, so the gun read
 * as fake on exactly the tier the browser harness runs on. This is the same trap the
 * ejected casing fell into. A hit that leaves no mark is not a particle effect that
 * can be trimmed for performance — it is the feedback that says the shot landed —
 * so the budget may only ever *cap* the pool, never switch the system off. Sixteen is
 * two shotgun blasts' worth of metal sparks, and every quad is pooled and shared.
 */
const MIN_IMPACT_BUDGET = 16;

const FLESH_SECONDS = 0.26;
const FLESH_SIZE = 0.3;
/**
 * How far a spark is pulled towards the camera before it is drawn, in metres.
 *
 * A spark spawned exactly on the impact point is centred on the surface it was born
 * against, so half of it is inside the wall and the depth test eats it: the shot
 * lands, the game reports an impact, and nothing is visible. Every spark is nudged
 * this far along the surface-to-camera vector (see `update`) so it sits clear of the
 * geometry it was spawned on.
 */
export const CAMERA_NUDGE = 0.12;

export interface ImpactEffectsDeps {
  scene: Scene;
  /** Maximum simultaneous effects, taken from the quality preset. Clamped up to `MIN_IMPACT_BUDGET`. */
  budget: number;
  random: RandomSource;
}

/**
 * Short-lived hit feedback: sparks whose colour, count and size depend on what the
 * bullet hit.
 *
 * Meshes come from a pool and share one geometry, so spawning costs no allocation
 * and each spark is one draw call that lives for a quarter of a second. The material
 * is chosen from the collision tag the shot already carries (`combat:world-hit`), so
 * a car, a wall, a crate and a window each throw their own kind of debris — see
 * `MATERIAL_IMPACTS`. Flesh and head hits keep their blood flares.
 *
 * Deliberately **not** gated on the particle budget: the preset may cap the pool but
 * never switch the effect off, or `low` would shoot bullet holes that leave nothing
 * on the wall. See `MIN_IMPACT_BUDGET`.
 */
export class ImpactEffects implements Disposable {
  private readonly scene: Scene;
  private readonly group = new Group();
  private readonly geometry: PlaneGeometry;
  private readonly materials: Record<MaterialKind, MeshBasicMaterial>;
  private readonly fleshMaterial: MeshBasicMaterial;
  private readonly headMaterial: MeshBasicMaterial;
  private readonly pool: Mesh[] = [];
  private readonly active: Impact[] = [];
  private readonly budget: number;
  private readonly random: RandomSource;
  private readonly cameraFacing = new Vector3();
  private readonly casingGeometry: BoxGeometry;
  private readonly casingMaterial: MeshStandardMaterial;
  private readonly casings: Casing[] = [];
  private readonly casingPool: Mesh[] = [];

  constructor(deps: ImpactEffectsDeps) {
    this.scene = deps.scene;
    this.random = deps.random;
    // The floor, not the preset's number: a zero budget must not blank the feedback.
    this.budget = Math.max(MIN_IMPACT_BUDGET, Math.floor(deps.budget));

    this.geometry = new PlaneGeometry(1, 1);
    this.materials = {
      metal: this.createSparkMaterial(MATERIAL_IMPACTS.metal),
      concrete: this.createSparkMaterial(MATERIAL_IMPACTS.concrete),
      wood: this.createSparkMaterial(MATERIAL_IMPACTS.wood),
      glass: this.createSparkMaterial(MATERIAL_IMPACTS.glass),
      default: this.createSparkMaterial(MATERIAL_IMPACTS.default),
    };
    // Blood is not a material: a dark mist for the body and a bright burst for the head.
    this.fleshMaterial = new MeshBasicMaterial({
      color: 0x8f1f1f, transparent: true, opacity: 0.75, blending: AdditiveBlending,
      depthWrite: false, side: DoubleSide,
    });
    this.headMaterial = new MeshBasicMaterial({
      color: 0xff6a6a, transparent: true, opacity: 0.95, blending: AdditiveBlending,
      depthWrite: false, side: DoubleSide,
    });
    // Ejected brass: small, cheap, and the single biggest "the gun is real" cue
    // after the muzzle flash.
    this.casingGeometry = new BoxGeometry(0.022, 0.022, 0.062);
    this.casingMaterial = new MeshStandardMaterial({
      color: 0xd9b45c, metalness: 0.85, roughness: 0.32, emissive: 0x1d1508,
    });

    this.group.name = 'impact-effects';
    this.group.renderOrder = 5;
    this.scene.add(this.group);
  }

  /**
   * Ejects a spent casing from the weapon.
   *
   * Kicked out to the shooter's right and slightly up, then left to gravity: a
   * casing that vanishes instantly or flies in a straight line looks worse than
   * none at all.
   */
  spawnCasing(origin: Vector3, right: Vector3, forward: Vector3): void {
    // Deliberately *not* gated on the particle budget: at most twelve small pooled
    // boxes are alive at once, and a shot that ejects no brass is the clearest
    // "this gun is fake" cue there is, so it survives every quality tier.
    if (this.casings.length >= WEAPON_FEEL.casingPool) {
      const oldest = this.casings.shift();
      if (oldest) this.releaseCasing(oldest.mesh);
    }
    const mesh = this.casingPool.pop() ?? new Mesh(this.casingGeometry, this.casingMaterial);
    mesh.material = this.casingMaterial;
    mesh.visible = true;
    mesh.position.copy(origin);
    mesh.rotation.set(this.random.range(0, 3), this.random.range(0, 3), this.random.range(0, 3));
    mesh.scale.setScalar(1);
    this.group.add(mesh);
    this.casings.push({
      mesh,
      velocity: new Vector3(
        right.x * this.random.range(1.1, 1.9) + forward.x * this.random.range(0.1, 0.5),
        this.random.range(1.6, 2.6),
        right.z * this.random.range(1.1, 1.9) + forward.z * this.random.range(0.1, 0.5),
      ),
      spin: new Vector3(
        this.random.range(-14, 14), this.random.range(-14, 14), this.random.range(-14, 14),
      ),
      life: WEAPON_FEEL.casingSeconds,
    });
  }

  get activeCount(): number {
    return this.active.length;
  }

  /** Always true: the budget caps the pool but never switches the feedback off. */
  get enabled(): boolean {
    return this.budget > 0;
  }

  /**
   * Spawns one hit's worth of sparks. `kind`: 0 world, 1 body, 2 head.
   *
   * For a world hit the `tag` from `combat:world-hit` selects the material; an
   * unknown or omitted tag takes the `default` profile. Body and head hits ignore
   * the tag and keep their single blood flare.
   */
  spawn(pointX: number, pointY: number, pointZ: number, kind: 0 | 1 | 2, tag = ''): void {
    if (kind === 0) {
      const profile = MATERIAL_IMPACTS[materialForTag(tag)];
      const material = this.materials[profile.kind];
      // Scatter the pieces around the hit: a single quad at one point reads as a
      // sticker, several spread out read as a strike. The vertical scatter is
      // damped so dust settles into a puff instead of a spherical burst.
      for (let index = 0; index < profile.particles; index += 1) {
        this.spawnSpark(
          pointX + this.random.range(-profile.spread, profile.spread),
          pointY + this.random.range(-profile.spread, profile.spread) * 0.7,
          pointZ + this.random.range(-profile.spread, profile.spread),
          material,
          profile.size * this.random.range(0.7, 1.35),
          profile.seconds,
        );
      }
      return;
    }
    this.spawnSpark(
      pointX, pointY, pointZ,
      kind === 2 ? this.headMaterial : this.fleshMaterial,
      FLESH_SIZE, FLESH_SECONDS,
    );
  }

  get activeCasingCount(): number {
    return this.casings.length;
  }

  /** Billboard the sparks towards the camera and fade them out; drop casings. */
  update(delta: number, cameraPosition: Vector3): void {
    this.updateCasings(delta);
    if (this.active.length === 0) return;

    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const impact = this.active[i];
      impact.life -= delta;
      if (impact.life <= 0) {
        this.release(impact.mesh);
        this.active.splice(i, 1);
        continue;
      }
      const progress = 1 - impact.life / impact.maxLife;
      // Grow slightly and fade: reads as a spark rather than a floating square.
      impact.mesh.scale.setScalar(impact.size * (1 + progress * 0.8));
      impact.mesh.rotation.z = impact.spin + progress * 2.2;

      // Billboard towards the camera and pull the quad off the surface so it is
      // never inside the geometry it was spawned against.
      this.cameraFacing.copy(cameraPosition).sub(impact.position);
      const distance = this.cameraFacing.length();
      if (distance > 1e-4) {
        this.cameraFacing.multiplyScalar(1 / distance);
        impact.mesh.position.copy(impact.position).addScaledVector(this.cameraFacing, CAMERA_NUDGE);
      } else {
        impact.mesh.position.copy(impact.position);
      }
      impact.mesh.lookAt(cameraPosition);
    }
  }

  private createSparkMaterial(profile: MaterialImpactProfile): MeshBasicMaterial {
    // Hot sparks add; dull debris does not. Additive grey over the dark scene is
    // exactly the "glowing sticker" look the plan set out to remove.
    return new MeshBasicMaterial({
      color: profile.color,
      transparent: true,
      opacity: profile.glowing ? 0.9 : 0.7,
      blending: profile.glowing ? AdditiveBlending : NormalBlending,
      depthWrite: false,
      side: DoubleSide,
    });
  }

  private spawnSpark(
    pointX: number, pointY: number, pointZ: number,
    material: MeshBasicMaterial, size: number, seconds: number,
  ): void {
    if (this.active.length >= this.budget) {
      // Recycle the oldest rather than dropping the newest: the newest hit is the
      // one the player just caused and is looking at.
      const oldest = this.active.shift();
      if (oldest) this.release(oldest.mesh);
    }
    const mesh = this.pool.pop() ?? new Mesh(this.geometry, material);
    mesh.material = material;
    mesh.visible = true;
    mesh.scale.setScalar(size);
    mesh.position.set(pointX, pointY, pointZ);
    this.group.add(mesh);

    this.active.push({
      mesh,
      position: new Vector3(pointX, pointY, pointZ),
      life: seconds,
      maxLife: seconds,
      kind: 0,
      size,
      spin: this.random.range(0, Math.PI * 2),
    });
  }

  private updateCasings(delta: number): void {
    for (let i = this.casings.length - 1; i >= 0; i -= 1) {
      const casing = this.casings[i];
      casing.life -= delta;
      casing.velocity.y -= CASING_GRAVITY * delta;
      casing.mesh.position.addScaledVector(casing.velocity, delta);
      casing.mesh.rotation.x += casing.spin.x * delta;
      casing.mesh.rotation.y += casing.spin.y * delta;
      casing.mesh.rotation.z += casing.spin.z * delta;

      // Lands and disappears; a casing that keeps bouncing would need collision
      // against every prop in the block for a detail nobody is looking at.
      if (casing.life <= 0 || casing.mesh.position.y <= 0.015) {
        this.releaseCasing(casing.mesh);
        this.casings.splice(i, 1);
      }
    }
  }

  private releaseCasing(mesh: Mesh): void {
    mesh.visible = false;
    mesh.removeFromParent();
    if (this.casingPool.length < WEAPON_FEEL.casingPool) this.casingPool.push(mesh);
  }

  private release(mesh: Mesh): void {
    mesh.visible = false;
    mesh.removeFromParent();
    if (this.pool.length < this.budget) this.pool.push(mesh);
  }

  clear(): void {
    for (const impact of this.active) this.release(impact.mesh);
    this.active.length = 0;
    for (const casing of this.casings) this.releaseCasing(casing.mesh);
    this.casings.length = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    for (const mesh of this.pool) mesh.removeFromParent();
    this.pool.length = 0;
    for (const mesh of this.casingPool) mesh.removeFromParent();
    this.casingPool.length = 0;
    this.geometry.dispose();
    this.casingGeometry.dispose();
    this.casingMaterial.dispose();
    this.fleshMaterial.dispose();
    this.headMaterial.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }
}
