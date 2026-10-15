import {
  AdditiveBlending, BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, Scene, Vector3,
} from 'three';
import { WEAPON_FEEL } from '../app/gameConfig';
import type { Disposable } from '../core/Disposable';
import type { RandomSource } from '../utils/math';

interface Impact {
  mesh: Mesh;
  position: Vector3;
  /** Seconds of life remaining. */
  life: number;
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

export interface ImpactEffectsDeps {
  scene: Scene;
  /** Maximum simultaneous effects, taken from the quality preset. */
  budget: number;
  random: RandomSource;
}

const LIFETIME_SECONDS = 0.26;
const WORLD_SIZE = 0.18;
const FLESH_SIZE = 0.3;
/**
 * How far the flare is pulled towards the camera, in metres.
 *
 * The flare is centred exactly on the impact point, so without this it is half
 * buried in the surface it was spawned on and the depth test eats it — the shot
 * lands, the game reports an impact, and nothing is visible.
 */
const CAMERA_NUDGE = 0.12;

/**
 * Short-lived hit feedback: a small additive flare at the impact point.
 *
 * Meshes come from a pool and share one geometry and one material, so spawning an
 * effect allocates nothing and adds one draw call that lives for a quarter of a
 * second. The whole system is skipped when the quality preset gives it a budget
 * of zero, which is how the low preset avoids it entirely.
 */
export class ImpactEffects implements Disposable {
  private readonly scene: Scene;
  private readonly group = new Group();
  private readonly geometry: PlaneGeometry;
  private readonly materials: MeshBasicMaterial[];
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
    this.budget = Math.max(0, deps.budget);

    this.geometry = new PlaneGeometry(1, 1);
    this.materials = [
      // World spark, blood mist, head burst.
      new MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
      new MeshBasicMaterial({ color: 0x8f1f1f, transparent: true, opacity: 0.75, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
      new MeshBasicMaterial({ color: 0xff6a6a, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
    ];
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

  get enabled(): boolean {
    return this.budget > 0;
  }

  /** Spawns one flare. `kind`: 0 world, 1 body, 2 head. */
  spawn(pointX: number, pointY: number, pointZ: number, kind: 0 | 1 | 2): void {
    if (!this.enabled) return;
    if (this.active.length >= this.budget) {
      // Recycle the oldest rather than dropping the newest: the newest hit is the
      // one the player just caused and is looking at.
      const oldest = this.active.shift();
      if (oldest) this.release(oldest.mesh);
    }

    const mesh = this.pool.pop() ?? new Mesh(this.geometry, this.materials[kind]);
    mesh.material = this.materials[kind];
    mesh.visible = true;
    const size = kind === 0 ? WORLD_SIZE : FLESH_SIZE;
    mesh.scale.setScalar(size);
    mesh.position.set(pointX, pointY, pointZ);
    this.group.add(mesh);

    this.active.push({
      mesh,
      position: new Vector3(pointX, pointY, pointZ),
      life: LIFETIME_SECONDS,
      kind,
      size,
      spin: this.random.range(0, Math.PI * 2),
    });
  }

  get activeCasingCount(): number {
    return this.casings.length;
  }

  /** Billboard the flares towards the camera and fade them out; drop casings. */
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
      const progress = 1 - impact.life / LIFETIME_SECONDS;
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
    for (const material of this.materials) material.dispose();
  }
}
