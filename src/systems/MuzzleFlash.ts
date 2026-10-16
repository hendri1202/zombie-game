import {
  AdditiveBlending, Camera, DataTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, NormalBlending,
  PlaneGeometry, PointLight, Quaternion, RGBAFormat, Scene, SRGBColorSpace, Vector3,
} from 'three';
import type { Disposable } from '../core/Disposable';
import type { RandomSource } from '../utils/math';

/**
 * Muzzle flash, in layers.
 *
 * What was here before was a 4.5 cm sphere with an untextured material: a small ball
 * that appears at the muzzle for 50 ms and lights the scene. Nothing about it reads as
 * burning propellant — there is no shape, no smoke, and the light came from the view
 * model rather than from the muzzle, so in third person the character's rifle lit up
 * the space around the camera instead of the space around its barrel.
 *
 * A shot is six short layers, not one: the flash quad, a second smaller core quad, the
 * point light, and smoke that outlives all of them. Each is pooled and cheap; the
 * layered timing is what separates "gun fired" from "bright thing appeared".
 *
 * Textures are computed pixel by pixel into a DataTexture rather than drawn on a canvas
 * so the whole module runs under `node --test` with no DOM.
 */

export interface MuzzleFlashDeps {
  scene: Scene;
  camera: Camera;
  /** Maximum simultaneous flash quads; smoke and the light are separate and capped too. */
  budget: number;
  /** Injected so tests and replays are deterministic. */
  random: RandomSource;
}

interface Flash {
  mesh: Mesh;
  life: number;
  maxLife: number;
  scale: number;
  spin: number;
}

interface Puff {
  mesh: Mesh;
  life: number;
  maxLife: number;
  size: number;
  grow: number;
  velocity: Vector3;
}

export const FLASH_TEXTURE_SIZE = 64;
export const SMOKE_TEXTURE_SIZE = 64;

/**
 * Hot core with tapered spikes, as RGBA bytes.
 *
 * A plain radial gradient reads as a glowing dot; the spikes are what make it read as
 * a flash of burning gas. Alpha is the important channel — the colour only has to be
 * hot at the centre and cooler at the tips.
 */
export function createFlashTexture(size = FLASH_TEXTURE_SIZE): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const radius = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      // Core falloff plus four tapering spokes; the spokes are narrow so the flash
      // keeps a direction instead of becoming a starburst sticker.
      const core = Math.max(0, 1 - radius) ** 2.2;
      const spokes = Math.max(0, 1 - radius) ** 1.4
        * Math.max(0, Math.cos(angle * 2)) ** 8;
      const alpha = Math.min(1, core + spokes * 0.85);
      const offset = (y * size + x) * 4;
      // Hot centre, orange shoulders: written as sRGB and tagged as such below.
      data[offset] = Math.round(255 * Math.min(1, 0.55 + alpha * 0.45));
      data[offset + 1] = Math.round(255 * Math.min(1, 0.35 + alpha * 0.5));
      data[offset + 2] = Math.round(255 * Math.min(1, 0.12 + alpha * 0.3));
      data[offset + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Soft round puff with a slightly ragged edge, as RGBA bytes.
 *
 * Smoke must *not* be additive: additive grey over a dark scene looks like a glowing
 * sticker, which is exactly the cartoon look this replaces. It is a normal-blended
 * sprite with a soft alpha ramp.
 */
export function createSmokeTexture(size = SMOKE_TEXTURE_SIZE): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const radius = Math.hypot(dx, dy);
      // Deterministic per-pixel wobble: keeps the edge from looking like a perfect disc
      // without needing a random source at texture build time.
      const wobble = 0.06 * Math.sin(angleAt(x, y) * 5) * Math.cos(radius * 9);
      const alpha = Math.max(0, Math.min(1, (1 - radius + wobble) / 0.55)) ** 1.6;
      const shade = 168 + Math.round(30 * (1 - radius));
      const offset = (y * size + x) * 4;
      data[offset] = shade;
      data[offset + 1] = shade;
      data[offset + 2] = shade + 6;
      data[offset + 3] = Math.round(190 * alpha);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function angleAt(x: number, y: number): number {
  return Math.atan2(y, x);
}

/** How long smoke lives, seconds. Long enough to hang after the flash is gone. */
export const SMOKE_LIFE = [0.45, 0.8] as const;
/** Where the flash light sits relative to the muzzle, so it lights the barrel too. */
export const FLASH_LIGHT_OFFSET = 0.12;

export class MuzzleFlash implements Disposable {
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly random: RandomSource;
  private readonly budget: number;
  private readonly group = new Group();

  private readonly flashGeometry = new PlaneGeometry(1, 1);
  private readonly smokeGeometry = new PlaneGeometry(1, 1);
  private readonly flashTexture: DataTexture;
  private readonly smokeTexture: DataTexture;
  private readonly flashMaterial: MeshBasicMaterial;
  private readonly smokeMaterial: MeshBasicMaterial;
  private readonly light: PointLight;

  private readonly flashPool: Mesh[] = [];
  private readonly smokePool: Mesh[] = [];
  private readonly flashes: Flash[] = [];
  private readonly puffs: Puff[] = [];
  private readonly smokeBudget: number;

  /** Reused every spawn/update: every sprite is billboarded to the camera. */
  private readonly cameraQuaternion = new Quaternion();
  private readonly direction = new Vector3();

  private spawnedTotal = 0;
  /**
   * Multiplies every effect's lifetime.
   *
   * One, except while a frame is being captured: a screenshot on a software rasteriser
   * costs a frame, one frame here is up to a second, and a 55 ms flash is gone before
   * the capture composites. Stretching the life is the only way to photograph it, and
   * the frame says so in its own log line.
   */
  private lifeScale = 1;
  private lightTimer = 0;
  /** Peak intensity and life of the current light, so a weapon can ask for its own. */
  private lightPeak = 0;
  private lightSeconds = 0.055;

  constructor(deps: MuzzleFlashDeps) {
    this.scene = deps.scene;
    this.camera = deps.camera;
    this.random = deps.random;
    this.budget = Math.max(1, Math.floor(deps.budget));
    this.smokeBudget = Math.max(2, this.budget * 2);

    this.flashTexture = createFlashTexture();
    this.smokeTexture = createSmokeTexture();
    this.flashMaterial = new MeshBasicMaterial({
      map: this.flashTexture, transparent: true, blending: AdditiveBlending,
      depthWrite: false, side: DoubleSide, color: 0xffe3b0,
    });
    this.smokeMaterial = new MeshBasicMaterial({
      map: this.smokeTexture, transparent: true, blending: NormalBlending,
      depthWrite: false, side: DoubleSide, color: 0x8d8d8d, opacity: 0,
    });

    this.group.name = 'muzzle-flash';
    this.group.renderOrder = 12;
    this.scene.add(this.group);

    // A world light, not one bolted to the view model: the point of the flash is that it
    // lights the muzzle end of the barrel and whatever the barrel is pointing at.
    this.light = new PointLight(0xffc98a, 0, 9, 2);
    this.light.visible = false;
    this.scene.add(this.light);
  }

  /** Quads currently visible. */
  get activeCount(): number {
    return this.flashes.length;
  }

  /** Smoke puffs currently visible. */
  get activeSmokeCount(): number {
    return this.puffs.length;
  }

  /** Stretches effect lifetimes, so a capture on a slow host can catch them. */
  setLifeScale(scale: number): void {
    this.lifeScale = Math.max(0.01, scale);
  }

  /** Total spawned since the last clear, for smoke assertions and diagnostics. */
  get spawnCount(): number {
    return this.spawnedTotal;
  }

  /**
   * Fires one shot's worth of flash at `muzzle`, sending smoke down `direction`.
   *
   * Called on the weapon:fired event, so it must stay allocation-light: everything
   * comes from a pool that is only grown up to its budget.
   */
  spawn(muzzle: Vector3, direction: Vector3, intensity: number, seconds: number): void {
    this.spawnedTotal += 1;
    // Two quads, the second smaller and spun differently: one quad alone looks flat when
    // the camera happens to be looking down the barrel.
    for (let index = 0; index < 2; index += 1) {
      const mesh = this.flashPool.pop() ?? this.createFlashMesh();
      const scale = (index === 0 ? 0.42 : 0.26) * this.random.range(0.85, 1.15);
      mesh.position.copy(muzzle);
      mesh.quaternion.copy(this.faceCamera());
      mesh.rotateZ(this.random.range(0, Math.PI * 2));
      mesh.scale.set(scale, scale, scale);
      mesh.visible = true;
      (mesh.material as MeshBasicMaterial).opacity = 1;
      this.group.add(mesh);
      const maxLife = Math.max(0.02, seconds) * (index === 0 ? 1 : 0.7) * this.lifeScale;
      this.flashes.push({ mesh, life: maxLife, maxLife, scale, spin: this.random.range(0, Math.PI) });
    }

    const puffCount = this.random.next() > 0.5 ? 2 : 1;
    for (let index = 0; index < puffCount; index += 1) {
      if (this.puffs.length >= this.smokeBudget) break;
      const mesh = this.smokePool.pop() ?? this.createSmokeMesh();
      const size = this.random.range(0.2, 0.28);
      mesh.position.copy(muzzle);
      mesh.quaternion.copy(this.faceCamera());
      mesh.rotateZ(this.random.range(0, Math.PI * 2));
      mesh.scale.set(size, size, size);
      mesh.visible = true;
      (mesh.material as MeshBasicMaterial).opacity = 0.55;
      this.group.add(mesh);
      const maxLife = this.random.range(SMOKE_LIFE[0], SMOKE_LIFE[1]) * this.lifeScale;
      const velocity = this.direction.copy(direction).normalize()
        .multiplyScalar(this.random.range(1.1, 1.7));
      velocity.y += this.random.range(0.45, 0.75);
      this.puffs.push({ mesh, life: maxLife, maxLife, size, grow: this.random.range(0.55, 0.95), velocity: velocity.clone() });
    }

    this.light.position.copy(muzzle).addScaledVector(direction, FLASH_LIGHT_OFFSET);
    this.light.visible = true;
    this.lightPeak = intensity;
    this.lightSeconds = Math.max(0.02, seconds);
    this.light.intensity = intensity;
    this.lightTimer = this.lightSeconds;
  }

  update(delta: number): void {
    for (let index = this.flashes.length - 1; index >= 0; index -= 1) {
      const flash = this.flashes[index];
      flash.life -= delta;
      if (flash.life <= 0) {
        this.releaseFlash(flash.mesh, index);
        continue;
      }
      const ratio = flash.life / flash.maxLife;
      const scale = flash.scale * (1 + (1 - ratio) * 0.35);
      flash.mesh.scale.set(scale, scale, scale);
      // Quadratic decay: a flash of light, not a lamp switching off.
      (flash.mesh.material as MeshBasicMaterial).opacity = ratio * ratio;
    }

    for (let index = this.puffs.length - 1; index >= 0; index -= 1) {
      const puff = this.puffs[index];
      puff.life -= delta;
      if (puff.life <= 0) {
        this.releaseSmoke(puff.mesh, index);
        continue;
      }
      const ratio = puff.life / puff.maxLife;
      const size = puff.size + (1 - ratio) * puff.grow;
      puff.mesh.scale.set(size, size, size);
      puff.mesh.position.addScaledVector(puff.velocity, delta);
      puff.velocity.multiplyScalar(1 - Math.min(1, delta * 1.6));
      (puff.mesh.material as MeshBasicMaterial).opacity = 0.5 * ratio * ratio;
      // Keep the puff facing the camera as it drifts, so it never turns into a card.
      puff.mesh.quaternion.copy(this.faceCamera());
    }

    if (this.lightTimer > 0) {
      this.lightTimer -= delta;
      const ratio = Math.max(0, this.lightTimer) / this.lightSeconds;
      this.light.intensity = ratio * ratio * this.lightPeak;
      if (this.lightTimer <= 0) {
        this.light.intensity = 0;
        this.light.visible = false;
      }
    }
  }

  /** Drops every live effect without touching the pools, for a run restart. */
  clear(): void {
    for (let index = this.flashes.length - 1; index >= 0; index -= 1) {
      this.releaseFlash(this.flashes[index].mesh, index);
    }
    for (let index = this.puffs.length - 1; index >= 0; index -= 1) {
      this.releaseSmoke(this.puffs[index].mesh, index);
    }
    this.light.intensity = 0;
    this.light.visible = false;
    this.lightTimer = 0;
    this.spawnedTotal = 0;
  }

  /** Camera orientation, shared by every sprite for this frame. */
  private faceCamera(): Quaternion {
    return this.camera.getWorldQuaternion(this.cameraQuaternion);
  }

  private createFlashMesh(): Mesh {
    const mesh = new Mesh(this.flashGeometry, this.flashMaterial);
    mesh.frustumCulled = false;
    return mesh;
  }

  private createSmokeMesh(): Mesh {
    const mesh = new Mesh(this.smokeGeometry, this.smokeMaterial.clone());
    mesh.frustumCulled = false;
    return mesh;
  }

  private releaseFlash(mesh: Mesh, index: number): void {
    this.flashes.splice(index, 1);
    this.group.remove(mesh);
    mesh.visible = false;
    if (this.flashPool.length < this.budget * 2) this.flashPool.push(mesh);
  }

  private releaseSmoke(mesh: Mesh, index: number): void {
    this.puffs.splice(index, 1);
    this.group.remove(mesh);
    mesh.visible = false;
    if (this.smokePool.length < this.smokeBudget) this.smokePool.push(mesh);
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    this.scene.remove(this.light);
    this.group.clear();
    this.flashGeometry.dispose();
    this.smokeGeometry.dispose();
    this.flashMaterial.dispose();
    // Smoke materials are cloned per sprite, so they are disposed with the pool.
    for (const mesh of this.smokePool) (mesh.material as MeshBasicMaterial).dispose();
    for (const puff of this.puffs) (puff.mesh.material as MeshBasicMaterial).dispose();
    this.smokeMaterial.dispose();
    this.flashTexture.dispose();
    this.smokeTexture.dispose();
    
  }
}
