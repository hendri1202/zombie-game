import {
  AdditiveBlending, Camera, DataTexture, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial,
  PlaneGeometry, Quaternion, RGBAFormat, Scene, SRGBColorSpace, Vector3,
} from 'three';
import type { Disposable } from '../core/Disposable';

/**
 * Tracer rounds.
 *
 * The weapon system is hitscan, so before this a shot at anything past a few metres
 * showed a muzzle flash and then an impact — with nothing travelling between them. The
 * eye reads that as "the gun made a noise and something far away moved", which is a
 * large part of why firing looked flat.
 *
 * A tracer is one quad stretched from the muzzle to where the shot landed, billboarded
 * around its own axis so it stays visible from any camera angle, additive, alive for a
 * few dozen milliseconds. Every weapon can ask for one every Nth shot: a slow weapon
 * shows every round, a fast one only every second or third, which is also how tracers
 * read in reality.
 */

export interface TracersDeps {
  scene: Scene;
  camera: Camera;
  budget: number;
}

interface Tracer {
  mesh: Mesh;
  life: number;
  maxLife: number;
}

export const TRACER_TEXTURE_WIDTH = 32;
export const TRACER_TEXTURE_HEIGHT = 8;

/**
 * Bright core fading to nothing at both ends and across the width, as RGBA bytes.
 *
 * Both ends fade because a tracer that ends in a hard edge looks like a painted stick.
 */
export function createTracerTexture(
  width = TRACER_TEXTURE_WIDTH, height = TRACER_TEXTURE_HEIGHT,
): DataTexture {
  const data = new Uint8Array(width * height * 4);
  const centreY = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const v = Math.abs(y - centreY) / centreY;
      // Narrow along its width, tapering over the last third at each end.
      const across = Math.max(0, 1 - v) ** 1.6;
      const along = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, u))));
      const alpha = Math.min(1, across * (0.35 + along * 0.85));
      const offset = (y * width + x) * 4;
      // Warm white-hot core: tracers burn brighter than the round they carry.
      data[offset] = 255;
      data[offset + 1] = Math.round(232 + 23 * across);
      data[offset + 2] = Math.round(180 + 60 * across);
      data[offset + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Orthonormal basis for a tracer quad: local X along the shot, local Z at the camera.
 *
 * Returning plain numbers keeps this testable without building meshes: the projection
 * has to strip the camera direction's component along the shot, or the quad stays edge-on
 * and the tracer is invisible exactly when the player is looking straight down it.
 */
export function tracerBasis(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  camera: readonly [number, number, number],
): { axis: [number, number, number]; up: [number, number, number]; normal: [number, number, number] } | null {
  const axis = new Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const length = axis.length();
  if (length < 1e-6) return null;
  axis.multiplyScalar(1 / length);

  const midpoint = new Vector3(
    (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2,
  );
  const view = new Vector3(camera[0], camera[1], camera[2]).sub(midpoint);
  // Remove the component along the shot, leaving the part of the view that is
  // perpendicular to it. A zero-length result means the camera is on the shot line.
  view.addScaledVector(axis, -view.dot(axis));
  if (view.lengthSq() < 1e-10) view.set(0, 1, 0).addScaledVector(axis, -axis.y);
  if (view.lengthSq() < 1e-10) view.set(1, 0, 0);
  view.normalize();

  const up = new Vector3().crossVectors(view, axis).normalize();
  return {
    axis: [axis.x, axis.y, axis.z],
    up: [up.x, up.y, up.z],
    normal: [view.x, view.y, view.z],
  };
}

export class Tracers implements Disposable {
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly budget: number;
  private readonly group = new Group();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly texture: DataTexture;
  private readonly material: MeshBasicMaterial;
  private readonly pool: Mesh[] = [];
  private readonly active: Tracer[] = [];
  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  // Three separate vectors: makeBasis reads all three arguments, so passing one shared
  // scratch three times would give every axis the last value written.
  private readonly basisX = new Vector3();
  private readonly basisY = new Vector3();
  private readonly basisZ = new Vector3();
  private readonly cameraPositionScratch = new Vector3();
  private spawnedTotal = 0;
  /** Lifetime multiplier, one except while a frame is being captured (see MuzzleFlash). */
  private lifeScale = 1;

  constructor(deps: TracersDeps) {
    this.scene = deps.scene;
    this.camera = deps.camera;
    this.budget = Math.max(1, Math.floor(deps.budget));
    this.texture = createTracerTexture();
    this.material = new MeshBasicMaterial({
      map: this.texture, transparent: true, blending: AdditiveBlending,
      depthWrite: false, side: DoubleSide, color: 0xfff0c0,
    });
    this.group.name = 'tracers';
    this.group.renderOrder = 11;
    this.scene.add(this.group);
  }

  get activeCount(): number {
    return this.active.length;
  }

  get spawnCount(): number {
    return this.spawnedTotal;
  }

  /** Stretches tracer lifetime, so a capture on a slow host can catch one. */
  setLifeScale(scale: number): void {
    this.lifeScale = Math.max(0.01, scale);
  }

  /** Draws one tracer between two world points. */
  spawn(from: Vector3, to: Vector3, width: number, seconds: number): void {
    const length = from.distanceTo(to);
    if (length < 0.05) return;
    this.spawnedTotal += 1;

    const basis = tracerBasis(
      [from.x, from.y, from.z], [to.x, to.y, to.z],
      this.cameraPosition(),
    );
    if (!basis) return;

    const mesh = this.pool.pop() ?? this.createMesh();
    this.matrix.makeBasis(
      this.basisX.set(basis.axis[0], basis.axis[1], basis.axis[2]),
      this.basisY.set(basis.up[0], basis.up[1], basis.up[2]),
      this.basisZ.set(basis.normal[0], basis.normal[1], basis.normal[2]),
    );
    mesh.quaternion.copy(this.quaternion.setFromRotationMatrix(this.matrix));
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.scale.set(length, width, 1);
    mesh.visible = true;
    (mesh.material as MeshBasicMaterial).opacity = 1;
    this.group.add(mesh);
    const life = Math.max(0.02, seconds) * this.lifeScale;
    this.active.push({ mesh, life, maxLife: life });
  }

  update(delta: number): void {
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const tracer = this.active[index];
      tracer.life -= delta;
      if (tracer.life <= 0) {
        this.active.splice(index, 1);
        this.group.remove(tracer.mesh);
        tracer.mesh.visible = false;
        if (this.pool.length < this.budget) this.pool.push(tracer.mesh);
        continue;
      }
      (tracer.mesh.material as MeshBasicMaterial).opacity = tracer.life / tracer.maxLife;
    }
  }

  clear(): void {
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const tracer = this.active[index];
      this.active.splice(index, 1);
      this.group.remove(tracer.mesh);
      tracer.mesh.visible = false;
      if (this.pool.length < this.budget) this.pool.push(tracer.mesh);
    }
    this.spawnedTotal = 0;
  }

  private cameraPosition(): [number, number, number] {
    const position = this.camera.getWorldPosition(this.cameraPositionScratch);
    return [position.x, position.y, position.z];
  }

  private createMesh(): Mesh {
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    return mesh;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    this.group.clear();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
