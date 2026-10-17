import {
  DataTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, NormalBlending, PlaneGeometry,
  RGBAFormat, Scene, SRGBColorSpace, Vector3,
} from 'three';
import type { HitZone } from '../app/GameEvents';
import type { Disposable } from '../core/Disposable';
import type { RandomSource } from '../utils/math';

/**
 * Blood on a landed blow: a splat where the wound is, plus a burst of droplets that
 * leave it.
 *
 * Two layers, because one plane is not a wound — it is a decal. The splat is the mark
 * that stays and the droplets are the motion that says something was just hit; both are
 * chosen from the `zone` the hit already carries, so a headshot throws more and brighter
 * blood than a body hit without a second headshot detection anywhere in the game.
 *
 * Same three lessons the sparks already learned, applied here:
 *
 * 1. **Pulled off the surface.** A quad centred exactly on the wound is half inside the
 *    zombie and the depth test eats the half the player can see. Every blood quad is
 *    nudged `BLOOD_NUDGE` along the wound-to-camera vector before it is drawn (see
 *    `place`), so the effect can never be invisible on the geometry it was born against.
 * 2. **Never gated by the particle budget.** `low` sets `particleBudget` to 0, and this
 *    system simply does not read it: a hit that draws no blood reads as a broken gun, so
 *    it is feedback rather than decoration. The pools have their own floors — see
 *    `BLOOD_DROP_CAP` — and a preset may only ever raise them, never switch them off.
 * 3. **Bounded and pooled.** Both layers come from fixed pools that recycle the *oldest*
 *    effect when full, never the newest: the blow the player just caused is the one they
 *    are looking at. Every mesh and material ever created is registered and disposed, so
 *    a thousand hits allocate a bounded set of objects and then nothing.
 *
 * Textures are computed pixel by pixel into a `DataTexture` rather than drawn on a canvas,
 * so the whole module runs under vitest with no DOM — the same trick `MuzzleFlash` uses.
 * Blood is drawn normal-blended, not additive: additive red over the dark scene is exactly
 * the "glowing sticker" look the shooting-effects plan set out to remove.
 */

/** Width and height of the blood textures, pixels. */
export const BLOOD_TEXTURE_SIZE = 32;

/**
 * How far a blood quad is pulled towards the camera before it is drawn, in metres.
 *
 * Deliberately `0.8 m`, rather than the spark system's 0.1 m: `combat:hit` reports the
 * intersection on the gameplay hitbox, which sits inside the rendered skinned surface.
 * A browser pixel-diff showed the quad still occluded at 0.4 m and visible after another
 * 0.4 m; the full view-ray offset clears that visual shell. Kept as one named value for
 * subsequent visual tuning.
 */
export const BLOOD_NUDGE = 0.8;

/** Gravity on a droplet, m/s^2. A touch heavy so a burst lands within its short life. */
const DROP_GRAVITY = 12;

/** How many droplet quads may be alive at once, whatever the quality preset asks for. */
export const BLOOD_DROP_CAP = 32;
/** How many splats may be alive at once. Marks, not particles: eight is already plenty. */
export const BLOOD_DECAL_CAP = 8;

/** Droplet base opacity; the splat is lighter so a wound does not read as paint. */
const DROP_OPACITY = 0.95;
const DECAL_OPACITY = 0.55;

/**
 * How much more blood a killing blow throws, relative to a wounding one.
 *
 * A kill is the moment the blow paid off, so it earns a visibly bigger burst — more
 * droplets and a larger splat. It is deliberately a modest multiplier, not a special
 * effect: it is the same blood, thrown harder, and it stays inside the pool bounds, so
 * the payoff never costs more frames than an ordinary hit.
 */
export const BLOOD_KILL_SCALE = 1.6;

/** What one hit throws, per zone. Head and body differ in count, size and colour. */
export interface BloodZoneProfile {
  /** Droplet quads thrown by one hit. */
  drops: number;
  /** Droplet quad width at spawn, metres. */
  dropSize: number;
  /** Droplet colour. */
  dropColor: number;
  /** Initial droplet speed, metres per second. */
  dropSpeed: number;
  /** Splat quad width at spawn, metres. */
  decalSize: number;
  /** Splat colour. */
  decalColor: number;
  /** Droplet lifetime, seconds. */
  dropSeconds: number;
  /** Splat lifetime, seconds. Far longer than the droplets: the mark outlives the burst. */
  decalSeconds: number;
}

/**
 * The two zones the hit event already distinguishes.
 *
 * A head hit is not "a body hit but more": it is more droplets, each larger, in a brighter
 * red, with a bigger splat and a longer stain, so the headshot multiplier is legible from
 * the impact alone. Values are metres and seconds.
 */
export const BLOOD_ZONES: Record<HitZone, BloodZoneProfile> = {
  body: {
    drops: 5, dropSize: 0.05, dropColor: 0x8f1f1f, dropSpeed: 1.5,
    decalSize: 0.18, decalColor: 0x5c1414, dropSeconds: 0.34, decalSeconds: 1.8,
  },
  head: {
    drops: 10, dropSize: 0.075, dropColor: 0xff6a6a, dropSpeed: 2.1,
    decalSize: 0.32, decalColor: 0xa81e1e, dropSeconds: 0.44, decalSeconds: 2.6,
  },
};

interface Drop {
  mesh: Mesh;
  /** Wound point the droplet was born at. */
  x: number;
  y: number;
  z: number;
  /** Launch velocity, metres per second. */
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  spin: number;
}

interface Decal {
  mesh: Mesh;
  /** World point of the wound the splat is glued to. */
  x: number;
  y: number;
  z: number;
  life: number;
  maxLife: number;
  size: number;
  opacity: number;
}

export interface BloodEffectsDeps {
  scene: Scene;
  random: RandomSource;
  /**
   * The quality preset's particle budget, if any. Advisory only: it can raise the droplet
   * pool above its floor but it can never lower it, so a `low` preset (budget 0) still
   * draws full blood. See the class comment.
   */
  budget?: number;
}

/**
 * A soft, slightly ragged droplet speck, as RGBA bytes.
 *
 * White, with the shape in the alpha channel: the hue is the material's, so a head hit and
 * a body hit stay measurably different colours without a second texture. The wobble keeps
 * the edge from reading as a perfect disc.
 */
export function createDropTexture(size = BLOOD_TEXTURE_SIZE): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const radius = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const wobble = 0.14 * Math.sin(angle * 5) * Math.cos(radius * 8);
      const alpha = Math.max(0, Math.min(1, (1 - radius + wobble) / 0.55)) ** 1.5;
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Soft coverage of a blob centred at (cx, cy) with radius r, in normalised [-1, 1] space. */
function blob(dx: number, dy: number, cx: number, cy: number, r: number): number {
  const distance = Math.hypot(dx - cx, dy - cy);
  return Math.max(0, Math.min(1, (r - distance) / (r * 0.45)));
}

/**
 * A saturated splat with satellite droplets around it, as RGBA bytes.
 *
 * One soft disc reads as a smudge; the satellites are what make it read as blood that hit
 * and spread. Coverage is the max of every blob, so they merge into one shape instead of
 * showing seams. White again — the splat's colour is the material's.
 */
export function createSplatTexture(size = BLOOD_TEXTURE_SIZE): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  // Fixed, not random: a texture built at load time must be deterministic, or two runs
  // would paint different blood and a captured frame could never be compared. The core is
  // small (0.52) and the satellites sit out past it (≈0.6–0.75), so the shape genuinely
  // spreads rather than reading as one soft disc.
  const satellites: Array<[number, number, number]> = [
    [0.55, 0.42, 0.24], [-0.6, 0.2, 0.2], [0.22, -0.62, 0.18],
    [-0.34, -0.54, 0.16], [0.68, -0.2, 0.15], [-0.72, -0.26, 0.13],
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      let alpha = blob(dx, dy, 0, 0, 0.52);
      for (const [cx, cy, r] of satellites) alpha = Math.max(alpha, blob(dx, dy, cx, cy, r));
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class BloodEffects implements Disposable {
  private readonly scene: Scene;
  private readonly random: RandomSource;
  private readonly group = new Group();
  private readonly geometry: PlaneGeometry;
  private readonly dropTexture: DataTexture;
  private readonly splatTexture: DataTexture;

  private readonly dropCap: number;
  private readonly decalCap = BLOOD_DECAL_CAP;

  private readonly drops: Drop[] = [];
  private readonly decals: Decal[] = [];
  /** Records reused across hits, so a burst allocates nothing but the mesh it reuses. */
  private readonly dropFree: Drop[] = [];
  private readonly decalFree: Decal[] = [];
  private readonly dropPool: Mesh[] = [];
  private readonly decalPool: Mesh[] = [];
  /** Every per-mesh material ever created; bounded by the pools, disposed in one place. */
  private readonly ownedMaterials: MeshBasicMaterial[] = [];

  /** Scratch, reused every frame so billboarding allocates nothing. */
  private readonly cameraFacing = new Vector3();
  private readonly placed = new Vector3();

  private hits = 0;

  constructor(deps: BloodEffectsDeps) {
    this.scene = deps.scene;
    this.random = deps.random;
    // The floor, not the preset's number: a zero budget must not blank the feedback.
    this.dropCap = Math.max(BLOOD_DROP_CAP, Math.floor(deps.budget ?? 0));

    this.geometry = new PlaneGeometry(1, 1);
    this.dropTexture = createDropTexture();
    this.splatTexture = createSplatTexture();

    this.group.name = 'blood-effects';
    this.group.renderOrder = 6;
    this.scene.add(this.group);
  }

  /** Droplet quads currently drawn. */
  get activeDropCount(): number {
    return this.drops.length;
  }

  /** Splats currently drawn. */
  get activeDecalCount(): number {
    return this.decals.length;
  }

  /** Live blood quads of both layers. */
  get activeCount(): number {
    return this.drops.length + this.decals.length;
  }

  /** The droplet pool ceiling, after the preset's floor is applied. */
  get dropCapacity(): number {
    return this.dropCap;
  }

  /** The splat pool ceiling. */
  get decalCapacity(): number {
    return this.decalCap;
  }

  /** Hits that threw blood since the last clear, for diagnostics and tests. */
  get hitCount(): number {
    return this.hits;
  }

  /** Always true: blood is feedback the budget may cap but never switch off. */
  get enabled(): boolean {
    return true;
  }

  /**
   * One landed blow's worth of blood at `point`.
   *
   * `zone` and `killed` are exactly what `combat:hit` already carries, so a headshot is
   * never detected here — this only decides how much blood the zone throws. `killed`
   * scales the burst up (see `BLOOD_KILL_SCALE`).
   */
  spawn(pointX: number, pointY: number, pointZ: number, zone: HitZone, killed = false): void {
    this.hits += 1;
    const profile = BLOOD_ZONES[zone];
    const scale = killed ? BLOOD_KILL_SCALE : 1;

    this.spawnDecal(pointX, pointY, pointZ, profile, scale);

    const count = Math.max(1, Math.round(profile.drops * scale));
    for (let index = 0; index < count; index += 1) {
      this.spawnDrop(pointX, pointY, pointZ, profile, scale);
    }
  }

  /**
   * Moves every live effect for this frame: droplets fall, splats hold and fade.
   *
   * `cameraPosition` is the same eye position the spark system receives, and is what both
   * billboarding and the surface nudge are measured against.
   */
  update(delta: number, cameraPosition: Vector3): void {
    for (let i = this.decals.length - 1; i >= 0; i -= 1) {
      const decal = this.decals[i];
      decal.life -= delta;
      if (decal.life <= 0) {
        this.decals.splice(i, 1);
        this.releaseDecal(decal);
        continue;
      }
      const ratio = decal.life / decal.maxLife;
      this.place(decal.x, decal.y, decal.z, cameraPosition);
      decal.mesh.position.copy(this.placed);
      decal.mesh.lookAt(cameraPosition);
      decal.mesh.scale.setScalar(decal.size);
      // Hold at full strength, then fade the last third: a splat that fades from the first
      // frame never reads as something that stuck.
      (decal.mesh.material as MeshBasicMaterial).opacity = decal.opacity * Math.min(1, ratio / 0.35);
    }

    for (let i = this.drops.length - 1; i >= 0; i -= 1) {
      const drop = this.drops[i];
      drop.life -= delta;
      if (drop.life <= 0) {
        this.drops.splice(i, 1);
        this.releaseDrop(drop);
        continue;
      }
      const elapsed = drop.maxLife - drop.life;
      // Ballistic in closed form: integrating would make where a droplet lands depend on
      // the frame delta, and the closed form is exact for any step.
      this.place(
        drop.x + drop.vx * elapsed,
        drop.y + drop.vy * elapsed - 0.5 * DROP_GRAVITY * elapsed * elapsed,
        drop.z + drop.vz * elapsed,
        cameraPosition,
      );
      drop.mesh.position.copy(this.placed);
      drop.mesh.lookAt(cameraPosition);
      drop.mesh.rotateZ(drop.spin + elapsed * 2.5);
      const progress = elapsed / drop.maxLife;
      drop.mesh.scale.setScalar(drop.size * (1 + progress * 0.6));
      (drop.mesh.material as MeshBasicMaterial).opacity = DROP_OPACITY * (1 - progress);
    }
  }

  /** Drops every live effect without touching the pools, for a run restart. */
  clear(): void {
    for (const decal of this.decals) this.releaseDecal(decal);
    this.decals.length = 0;
    for (const drop of this.drops) this.releaseDrop(drop);
    this.drops.length = 0;
    this.hits = 0;
  }

  /**
   * Writes `placed` = the effect's world point pulled `BLOOD_NUDGE` towards the camera.
   *
   * The whole depth-test lesson lives here. A splat or a droplet spawned exactly on the
   * surface is centred on it, so half of it is inside the zombie and the depth test eats
   * it: the blow lands, the game reports a hit, and nothing is drawn. Every blood quad
   * goes through this before it is positioned.
   */
  private place(x: number, y: number, z: number, cameraPosition: Vector3): void {
    this.placed.set(x, y, z);
    this.cameraFacing.copy(cameraPosition).sub(this.placed);
    const distance = this.cameraFacing.length();
    if (distance > 1e-4) this.placed.addScaledVector(this.cameraFacing, BLOOD_NUDGE / distance);
  }

  private spawnDecal(
    pointX: number, pointY: number, pointZ: number, profile: BloodZoneProfile, scale: number,
  ): void {
    if (this.decals.length >= this.decalCap) {
      // Recycle the oldest rather than dropping the newest: the newest is the blow the
      // player just caused and is looking at.
      const oldest = this.decals.shift();
      if (oldest) this.releaseDecal(oldest);
    }
    const decal = this.decalFree.pop() ?? { mesh: null as unknown as Mesh, x: 0, y: 0, z: 0, life: 0, maxLife: 0, size: 0, opacity: 0 };
    const mesh = this.decalPool.pop() ?? this.createDecalMesh();
    decal.mesh = mesh;
    decal.x = pointX;
    decal.y = pointY;
    decal.z = pointZ;
    decal.size = profile.decalSize * scale * this.random.range(0.85, 1.2);
    decal.opacity = DECAL_OPACITY;
    decal.maxLife = profile.decalSeconds;
    decal.life = decal.maxLife;

    const material = mesh.material as MeshBasicMaterial;
    material.color.setHex(profile.decalColor);
    material.opacity = decal.opacity;
    mesh.visible = true;
    mesh.scale.setScalar(decal.size);
    // Left on the raw wound point: `update` is what pulls it off the surface, exactly as
    // the sparks are placed on spawn and nudged on their first update.
    mesh.position.set(pointX, pointY, pointZ);
    if (mesh.parent !== this.group) this.group.add(mesh);

    this.decals.push(decal);
  }

  private spawnDrop(
    pointX: number, pointY: number, pointZ: number, profile: BloodZoneProfile, scale: number,
  ): void {
    if (this.drops.length >= this.dropCap) {
      const oldest = this.drops.shift();
      if (oldest) this.releaseDrop(oldest);
    }
    const drop = this.dropFree.pop() ?? {
      mesh: null as unknown as Mesh, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0, size: 0, spin: 0,
    };
    const mesh = this.dropPool.pop() ?? this.createDropMesh();
    drop.mesh = mesh;
    drop.x = pointX;
    drop.y = pointY;
    drop.z = pointZ;

    // Spurt out of the wound: a burst around the point, biased upward so it does not look
    // like a flat ring, then left to gravity. There is no shot direction here to spurt
    // along — `combat:hit` carries only the zone, the point and whether it killed — so this
    // is a burst at the wound rather than a jet out the far side.
    const speed = profile.dropSpeed * scale * this.random.range(0.6, 1.25);
    const theta = this.random.range(0, Math.PI * 2);
    const up = this.random.range(-0.15, 1);
    const radial = Math.sqrt(Math.max(0, 1 - up * up));
    drop.vx = Math.cos(theta) * radial * speed;
    drop.vy = up * speed + this.random.range(0.2, 0.7);
    drop.vz = Math.sin(theta) * radial * speed;

    drop.size = profile.dropSize * scale * this.random.range(0.6, 1.3);
    drop.spin = this.random.range(0, Math.PI * 2);
    drop.maxLife = profile.dropSeconds * this.random.range(0.8, 1.2);
    drop.life = drop.maxLife;

    const material = mesh.material as MeshBasicMaterial;
    material.color.setHex(profile.dropColor);
    material.opacity = DROP_OPACITY;
    mesh.visible = true;
    mesh.scale.setScalar(drop.size);
    mesh.position.set(pointX, pointY, pointZ);
    if (mesh.parent !== this.group) this.group.add(mesh);

    this.drops.push(drop);
  }

  private createDropMesh(): Mesh {
    const material = this.own(new MeshBasicMaterial({
      map: this.dropTexture, transparent: true, depthWrite: false,
      side: DoubleSide, blending: NormalBlending, opacity: DROP_OPACITY,
    }));
    return new Mesh(this.geometry, material);
  }

  private createDecalMesh(): Mesh {
    const material = this.own(new MeshBasicMaterial({
      map: this.splatTexture, transparent: true, depthWrite: false,
      side: DoubleSide, blending: NormalBlending, opacity: DECAL_OPACITY,
    }));
    const mesh = new Mesh(this.geometry, material);
    // Splats outlive their burst and are wide; keep them out of the frustum-culling
    // lottery so a stain at the edge of the view does not pop out mid-fade.
    mesh.frustumCulled = false;
    return mesh;
  }

  private own(material: MeshBasicMaterial): MeshBasicMaterial {
    this.ownedMaterials.push(material);
    return material;
  }

  private releaseDrop(drop: Drop): void {
    const mesh = drop.mesh;
    mesh.visible = false;
    mesh.removeFromParent();
    if (this.dropPool.length < this.dropCap) this.dropPool.push(mesh);
    if (this.dropFree.length < this.dropCap) this.dropFree.push(drop);
  }

  private releaseDecal(decal: Decal): void {
    const mesh = decal.mesh;
    mesh.visible = false;
    mesh.removeFromParent();
    if (this.decalPool.length < this.decalCap) this.decalPool.push(mesh);
    if (this.decalFree.length < this.decalCap) this.decalFree.push(decal);
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    for (const mesh of this.dropPool) mesh.removeFromParent();
    this.dropPool.length = 0;
    for (const mesh of this.decalPool) mesh.removeFromParent();
    this.decalPool.length = 0;
    this.dropFree.length = 0;
    this.decalFree.length = 0;
    this.geometry.dispose();
    this.dropTexture.dispose();
    this.splatTexture.dispose();
    // One material per pooled quad, so this is a bounded set — never one per hit.
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
  }
}
