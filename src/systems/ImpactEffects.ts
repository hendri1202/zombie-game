import {
  AdditiveBlending, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Scene, Vector3,
} from 'three';
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
    this.group.name = 'impact-effects';
    this.group.renderOrder = 5;
    this.scene.add(this.group);
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

  /** Billboard the flares towards the camera and fade them out. */
  update(delta: number, cameraPosition: Vector3): void {
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

  private release(mesh: Mesh): void {
    mesh.visible = false;
    mesh.removeFromParent();
    if (this.pool.length < this.budget) this.pool.push(mesh);
  }

  clear(): void {
    for (const impact of this.active) this.release(impact.mesh);
    this.active.length = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    for (const mesh of this.pool) mesh.removeFromParent();
    this.pool.length = 0;
    this.geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
