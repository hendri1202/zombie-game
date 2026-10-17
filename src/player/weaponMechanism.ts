import {
  BoxGeometry, BufferAttribute, InterleavedBufferAttribute, Matrix4, Mesh,
  MeshStandardMaterial, Object3D, Vector3,
} from 'three';
import type { WeaponConfig, WeaponId } from '../app/gameConfig';
import { WEAPON_PALETTE } from './proceduralWeapons';
import { clamp } from '../utils/math';

/**
 * The moving parts of a firearm: the pistol's slide, the rifle's bolt, the shotgun's pump.
 *
 * Why these parts are built here in code and not taken from the mesh: the pack's weapons
 * (`Pistol.gltf`, `Rifle.gltf`, `Shotgun.gltf`, `SMG.gltf`) are **one mesh each** — read out
 * of the shipped files, every one of them is a single node holding a single primitive, so
 * there is no slide, bolt or pump inside them to move. Splitting a single mesh in the
 * exported glTF is not something this pipeline can do (those files are extracted from the
 * survivor bundle, and re-authoring them is a modelling job, not an export flag), so the
 * part is built from primitives the way `proceduralWeapons.ts` already builds whole
 * weapons, and parented to the weapon mesh. The code-built firearms (MP5, P90, LMG) are a
 * group of small meshes, but none of them is *the* bolt either, so they get the same
 * treatment and nothing about the mechanism differs per weapon but its spec.
 *
 * What the part is placed against: the body's own geometry, never a hand-written offset.
 * The pack's models are not all axis-aligned — measured on the shipped files, the pistol
 * and the rifle run along +Z as the convention says, while the shotgun and the SMG
 * extracted from the survivor bundle run diagonally across their own XZ plane, about 40
 * degrees off +Z. A hard-coded +Z assumption would put one weapon's pump in mid-air beside
 * it. So the frame is measured (`measureWeaponFrame`): the body's long axis, its vertical
 * extent, and the height of its own surface at the station the part sits at. The part is
 * then built and placed in the mesh's own local units, which is what lets one piece of
 * code serve a pistol and an LMG that share no units.
 *
 * What this cannot promise without a browser: that the part *looks* right on each weapon.
 * The geometry says where the body's top surface is, and the part is drawn half proud of
 * it, so it sits at the body rather than floating beside it — but whether that reads as a
 * slide racking or as a box somewhere near a pistol is a photograph's question, and this
 * host has no browser (agents.md, plus the caller's own instruction that browser harnesses
 * are forbidden here). The tests therefore assert what geometry can answer — the part
 * exists, it is separate from the body, it moves back and returns, the muzzle does not
 * move — and the report says plainly what is left to a frame.
 */

/** Which way a weapon's moving part travels. */
export type MechanismKind = 'slide' | 'bolt' | 'pump';

export interface MechanismSpec {
  kind: MechanismKind;
  /** Where the part sits at rest: 0 at the rear of the body, 1 at the muzzle end. */
  station: number;
  /** Travel as a fraction of the body's own length, so a rifle's bolt is not a pistol's. */
  travel: number;
}

/**
 * One spec per firearm. Deliberately a `Record<WeaponId, …>`: every firearm in the table
 * must answer "what moves on this?", so adding a weapon to `WEAPONS` without deciding that
 * is a type error rather than a silent omission. Melee weapons and the grenade are not
 * `WeaponId`s and have no entry at all — nothing is attached to them, which is how "no
 * error for melee/grenade" holds by construction instead of by a guard.
 *
 * `station` is the one value that describes a weapon's layout rather than its geometry: a
 * pistol's slide covers most of its top, a rifle's bolt is at the receiver, a shotgun's
 * pump runs under the barrel in front of the hand, the P90's charging handle is at the
 * front of its shell.
 */
export const WEAPON_MECHANISMS: Record<WeaponId, MechanismSpec> = {
  pistol: { kind: 'slide', station: 0.5, travel: 0.1 },
  rifle: { kind: 'bolt', station: 0.3, travel: 0.07 },
  smg: { kind: 'bolt', station: 0.25, travel: 0.08 },
  shotgun: { kind: 'pump', station: 0.62, travel: 0.11 },
  mp5: { kind: 'bolt', station: 0.22, travel: 0.08 },
  // 0.6 and not further back: measured on the mesh, stations 0.3-0.5 of the P90 are its
  // optic, which stands 5 cm above the shell — a charging handle placed there is a block
  // glued to the sight. Forward of it the surface is the shell's own top, which is where a
  // P90's handle actually is.
  p90: { kind: 'bolt', station: 0.6, travel: 0.07 },
  // The same measurement applies to the belt gun: stations 0.2-0.4 are under its carry
  // handle, 5 cm above the receiver. 0.6 puts the bolt on the receiver's own top.
  lmg: { kind: 'bolt', station: 0.6, travel: 0.06 },
  /**
   * The MP7: a bolt, and forward of the middle for the same reason the P90's is.
   *
   * Measured on the mesh (0.64 m overall, 0.655 m of it from the butt plate at z=-0.28 to the
   * muzzle at z=0.36): the receiver's own top surface runs from station 0.37 to 0.68, and the
   * MP7's charging handle sits on it at z=0.12, which is station 0.625. 0.62 is that measured
   * place — the receiver's top, where the action actually is, and clear of the optic housing
   * mounted at station 0.42 so the two do not stack.
   */
  mp7: { kind: 'bolt', station: 0.62, travel: 0.07 },
  /**
   * The AUG: a bolt, and forward of its integrated optic.
   *
   * Measured on the mesh (0.81 m from the butt pad at z=-0.215 to the muzzle brake at
   * z=0.59): behind the grip the only surface above the shell is the cheek rest, and the optic
   * — mount, tube, objective and eyepiece — owns the top from station 0.18 to 0.48. The first
   * clear stretch of the shell's own top is forward of the optic, so the bolt goes there at
   * 0.55 rather than being drawn as a block glued to the sight. Same reasoning as the P90's
   * 0.6 and the LMG's 0.6; the travel is a little longer because the AUG is the longer body.
   */
  aug: { kind: 'bolt', station: 0.55, travel: 0.08 },
  /**
   * The 870: a pump, at the measured station of its own forend.
   *
   * `REMINGTON870_PUMP_MESH`'s box is centred at z=0.335 on a body that runs from the recoil
   * pad at z=-0.41 to the muzzle at z=0.73 (1.14 m), which is station 0.65 — the value the
   * mesh's own geometry gives, not a guess. The travel of 0.07 is 0.08 m of rearward stroke on
   * a 0.185 m forend: far enough to read as a pump stroke, and short of the 0.10 m that would
   * drive the forend's rear face (z=0.243) back into the receiver (which ends at z=0.14).
   */
  'remington-870': { kind: 'pump', station: 0.65, travel: 0.07 },
};

/**
 * The shape of one cycle, as fractions of it.
 *
 * Fractions and not seconds on purpose: every duration comes from the weapon's own
 * `fireRate` and `muzzleFlashSeconds` (see `mechanismCycleSeconds`), so retuning a weapon's
 * cadence moves its mechanism with it and no second table of timings has to be kept in
 * step. `back` is how much of the cycle the part spends travelling rearward and `hold` how
 * long it stays there — which is what the shotgun's pump needs and a blowback slide does
 * not: a pump reads as back–click–forward, not as a bounce.
 */
const PROFILE: Record<MechanismKind, { back: number; hold: number }> = {
  slide: { back: 0.35, hold: 0 },
  bolt: { back: 0.45, hold: 0 },
  pump: { back: 0.3, hold: 0.18 },
};

/**
 * How long one full cycle of the mechanism takes, seconds.
 *
 * Both inputs are the weapon's own rather than new numbers: the cycle follows the shot
 * interval (`1 / fireRate`), because the part that moved is the part that has to be home
 * before the next round is chambered. The flash is the floor — a cycle shorter than the
 * flash hiding it would be a mechanism nobody can see, and at the LMG's twelve rounds a
 * second the interval alone is 83 ms against a 60 ms flash. That is why the belt-fed gun's
 * bolt cycles a little slower than its trigger: it is the heaviest one, and that is the
 * honest reading of the numbers rather than a special case for the LMG.
 */
export function mechanismCycleSeconds(config: WeaponConfig): number {
  return Math.max(1 / config.fireRate, config.muzzleFlashSeconds * 2);
}

/** How long the part spends going back within one cycle, seconds. */
export function mechanismRetractSeconds(config: WeaponConfig): number {
  return mechanismCycleSeconds(config) * PROFILE[WEAPON_MECHANISMS[config.id].kind].back;
}

/**
 * How far the part is from its rest position, 0..1, at `progress` through the cycle.
 *
 * Pure, and exported: the shape of the movement is the part of this feature that can be
 * asserted without a renderer, and it is where the behaviours differ — a slide or bolt
 * slams back and returns within the shot's own interval, a pump goes back, waits, and is
 * driven forward.
 */
export function mechanismTravel(progress: number, kind: MechanismKind): number {
  const p = clamp(progress, 0, 1);
  const { back, hold } = PROFILE[kind];
  if (p <= back) {
    // Rearward: fast at first and decelerating, which is what a bolt being struck looks
    // like. A linear ramp reads as a slider.
    return 1 - (1 - p / back) ** 2;
  }
  const forwardStart = back + hold;
  if (p <= forwardStart) return 1;
  // Home again, accelerating into the closed position: the spring, not a return animation.
  const x = (p - forwardStart) / (1 - forwardStart);
  return 1 - x ** 2;
}

/** Part shape and how it sits on the body, as fractions of the body's own dimensions. */
const PART_PROFILE: Record<MechanismKind, {
  /** Along the body's length. */
  length: number;
  /** Across the body's height. */
  height: number;
  /** Across the body's width. */
  width: number;
  /**
   * How much of the part stands proud of the body's own surface at its station, 0..1.
   * Half in and half out is the point: a part buried inside the mesh would be a mechanism
   * that works in the tests and cannot be seen in the game.
   */
  protrude: number;
}> = {
  slide: { length: 0.42, height: 0.16, width: 0.85, protrude: 0.5 },
  bolt: { length: 0.2, height: 0.13, width: 0.38, protrude: 0.5 },
  // The pump wraps the barrel instead of sitting on top of it: centred on the body's own
  // centre line at its station, and the widest of the three so it reads as a handguard.
  pump: { length: 0.24, height: 0.3, width: 0.95, protrude: 0 },
};

/**
 * The body's own frame, measured from its geometry.
 *
 * `axis` is the long axis in the horizontal plane and `length` is the body's extent along
 * it, so a station is a fraction of the weapon rather than of a bounding box a diagonal
 * mesh would skew. `topAt` is the body's own surface height at a station: placing a part
 * against the mesh's overall top instead would call the pistol's rear sight the top of its
 * slide.
 */
export interface WeaponFrame {
  axis: Vector3;
  /** Rotation about Y that lines a part's local +Z up with `axis`. */
  yaw: number;
  /** Length along `axis`, in model-local units. */
  length: number;
  /** Vertical extent of the body, model-local units. */
  height: number;
  /** Horizontal extent across `axis`, model-local units. */
  width: number;
  /** Highest local y of the body's surface near a station, 0..1 along the body. */
  topAt(station: number): number;
  /** Mean local y of the body near a station: the barrel's centre line, for the pump. */
  centreAt(station: number): number;
  /** A point on the body's own centre line at a station, model-local units. */
  pointAt(station: number, out: Vector3): Vector3;
}

/** How many slices along the body the surface height is measured in. */
const SLICES = 16;
/** Vertex samples per model: enough for a shape, bounded so loading stays cheap. */
const MAX_SAMPLES = 3000;

/**
 * Reads a weapon mesh's own frame out of its geometry.
 *
 * The axis comes from the covariance of the vertices in the horizontal plane, whose
 * principal direction has a closed form in two dimensions — no eigen solver, and no
 * assumption about which way the artist left the gun. Its sign is fixed by the project's
 * weapon convention (`proceduralWeapons.ts`): the grip is at the origin and **+Z runs
 * towards the muzzle**, so the axis is flipped to point that way.
 *
 * The surface height per station is read off the **triangles**, not off the vertices that
 * happen to lie in a slice. That distinction is the whole difference between a part sitting
 * on a receiver and one floating inside it: a box mesh — and the code-built LMG is fifteen
 * boxes — has vertices only at its eight corners, so a slice through the middle of a long
 * receiver sees no vertices at all and reports the surface of whatever small part happens
 * to be there. Walking the triangles and sampling each edge where it crosses a slice
 * boundary gives the real top of the mesh at every station, whether the mesh is a dense
 * scan (the pack's pistol) or a handful of boxes.
 */
export function measureWeaponFrame(model: Object3D): WeaponFrame {
  model.updateMatrixWorld(true);
  const toLocal = new Matrix4().copy(model.matrixWorld).invert();
  const matrix = new Matrix4();
  const scratch = new Vector3();

  const meshes: Array<{
    geometry: Mesh['geometry'];
    attribute: BufferAttribute | InterleavedBufferAttribute;
    matrix: Matrix4;
  }> = [];
  let total = 0;
  model.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const attribute = mesh.geometry.getAttribute('position');
    if (!attribute) return;
    total += attribute.count;
    matrix.multiplyMatrices(toLocal, mesh.matrixWorld);
    meshes.push({ geometry: mesh.geometry, attribute, matrix: matrix.clone() });
  });
  if (total === 0 || meshes.length === 0) return flatFrame();

  // The centroid only needs a shape, so this pass samples with a stride: a weapon of thirty
  // thousand vertices costs the same as one of three thousand.
  const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
  const xs: number[] = [];
  const zs: number[] = [];
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const mesh of meshes) {
    for (let vertex = 0; vertex < mesh.attribute.count; vertex += stride) {
      scratch.set(
        mesh.attribute.getX(vertex), mesh.attribute.getY(vertex), mesh.attribute.getZ(vertex),
      ).applyMatrix4(mesh.matrix);
      xs.push(scratch.x);
      zs.push(scratch.z);
      minY = Math.min(minY, scratch.y);
      maxY = Math.max(maxY, scratch.y);
    }
  }

  // Centroid of the body in the horizontal plane, and its principal direction.
  let cx = 0;
  let cz = 0;
  for (let index = 0; index < xs.length; index += 1) {
    cx += xs[index];
    cz += zs[index];
  }
  cx /= xs.length;
  cz /= zs.length;

  let cxx = 0;
  let czz = 0;
  let cxz = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index] - cx;
    const dz = zs[index] - cz;
    cxx += dx * dx;
    czz += dz * dz;
    cxz += dx * dz;
  }
  const angle = 0.5 * Math.atan2(2 * cxz, cxx - czz);
  const axis = new Vector3(Math.cos(angle), 0, Math.sin(angle));
  if (axis.z < 0) axis.negate();
  const across = new Vector3(axis.z, 0, -axis.x);

  // Extents along and across the axis, over every vertex rather than the sample: this is
  // the body's own length, and it decides both the station scale and the part's travel.
  let minAlong = Number.POSITIVE_INFINITY;
  let maxAlong = Number.NEGATIVE_INFINITY;
  let minAcross = Number.POSITIVE_INFINITY;
  let maxAcross = Number.NEGATIVE_INFINITY;
  for (const mesh of meshes) {
    for (let vertex = 0; vertex < mesh.attribute.count; vertex += 1) {
      scratch.set(
        mesh.attribute.getX(vertex), mesh.attribute.getY(vertex), mesh.attribute.getZ(vertex),
      ).applyMatrix4(mesh.matrix);
      const dx = scratch.x - cx;
      const dz = scratch.z - cz;
      const along = dx * axis.x + dz * axis.z;
      const sideways = dx * across.x + dz * across.z;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      minAcross = Math.min(minAcross, sideways);
      maxAcross = Math.max(maxAcross, sideways);
    }
  }
  const length = Math.max(1e-4, maxAlong - minAlong);

  // Surface height per slice, from the triangles. Each vertex lands in its own slice, and
  // each edge is additionally sampled where it crosses a slice boundary — which is what
  // carries a long box's top surface across the slices it spans.
  const sliceTop = new Array<number>(SLICES).fill(Number.NEGATIVE_INFINITY);
  const sliceBottom = new Array<number>(SLICES).fill(Number.POSITIVE_INFINITY);
  const alongOf = (x: number, z: number): number => {
    const dx = x - cx;
    const dz = z - cz;
    return dx * axis.x + dz * axis.z;
  };
  const record = (along: number, y: number): void => {
    const slice = clamp(Math.floor(((along - minAlong) / length) * SLICES), 0, SLICES - 1);
    sliceTop[slice] = Math.max(sliceTop[slice], y);
    sliceBottom[slice] = Math.min(sliceBottom[slice], y);
  };
  const vertices = [new Vector3(), new Vector3(), new Vector3()];
  for (const mesh of meshes) {
    const index = mesh.geometry.index;
    const count = index ? index.count : mesh.attribute.count;
    for (let triangle = 0; triangle + 2 < count; triangle += 3) {
      for (let corner = 0; corner < 3; corner += 1) {
        const at = index ? index.getX(triangle + corner) : triangle + corner;
        vertices[corner].set(
          mesh.attribute.getX(at), mesh.attribute.getY(at), mesh.attribute.getZ(at),
        ).applyMatrix4(mesh.matrix);
      }
      for (const vertex of vertices) record(alongOf(vertex.x, vertex.z), vertex.y);
      // Edge crossings: the step from one slice to the next along an edge, at the y the
      // edge has there. Without this a receiver's own top edge would be invisible to every
      // slice between its two ends.
      for (let corner = 0; corner < 3; corner += 1) {
        const from = vertices[corner];
        const to = vertices[(corner + 1) % 3];
        const fromAlong = alongOf(from.x, from.z);
        const toAlong = alongOf(to.x, to.z);
        const span = toAlong - fromAlong;
        if (Math.abs(span) < 1e-9) continue;
        const fromSlice = ((fromAlong - minAlong) / length) * SLICES;
        const toSlice = ((toAlong - minAlong) / length) * SLICES;
        const first = Math.ceil(Math.min(fromSlice, toSlice));
        const last = Math.floor(Math.max(fromSlice, toSlice));
        for (let boundary = first; boundary <= last; boundary += 1) {
          const t = (boundary - fromSlice) / (toSlice - fromSlice);
          record(fromAlong + span * t, from.y + (to.y - from.y) * t);
        }
      }
    }
  }

  const sliceIndex = (station: number): number =>
    clamp(Math.round(clamp(station, 0, 1) * (SLICES - 1)), 0, SLICES - 1);
  /** The nearest slice to `slice`, starting with itself, that `wanted` accepts. */
  const nearest = (slice: number, wanted: (candidate: number) => boolean): number | null => {
    for (let offset = 0; offset < SLICES; offset += 1) {
      for (const candidate of [slice - offset, slice + offset]) {
        if (candidate < 0 || candidate >= SLICES) continue;
        if (wanted(candidate)) return candidate;
      }
    }
    return null;
  };

  return {
    axis,
    yaw: Math.atan2(axis.x, axis.z),
    length,
    height: Math.max(1e-4, maxY - minY),
    width: Math.max(1e-4, maxAcross - minAcross),
    topAt(station: number): number {
      const found = nearest(sliceIndex(station), (candidate) => sliceTop[candidate] !== Number.NEGATIVE_INFINITY);
      return found === null ? maxY : sliceTop[found];
    },
    centreAt(station: number): number {
      const found = nearest(
        sliceIndex(station),
        (candidate) => sliceTop[candidate] !== Number.NEGATIVE_INFINITY,
      );
      if (found === null) return (minY + maxY) / 2;
      // The middle of the body's own cross-section there: the barrel's station on a weapon
      // whose barrel is the top of that section, and never a point off the mesh entirely.
      return (sliceTop[found] + sliceBottom[found]) / 2;
    },
    pointAt(station: number, out: Vector3): Vector3 {
      const along = minAlong + clamp(station, 0, 1) * length;
      return out.set(cx + axis.x * along, 0, cz + axis.z * along);
    },
  };
}

/** The frame of a model with no vertices: everything at the origin, nothing to place. */
function flatFrame(): WeaponFrame {
  return {
    axis: new Vector3(0, 0, 1),
    yaw: 0,
    length: 1e-4,
    height: 1e-4,
    width: 1e-4,
    topAt: () => 0,
    centreAt: () => 0,
    pointAt: (_station: number, out: Vector3) => out.set(0, 0, 0),
  };
}

/**
 * One weapon's mechanism: the moving part, its rest pose, and where it is in its cycle.
 *
 * Owned per weapon by `WeaponController`. It writes to exactly one object — the part it
 * built and parented to the weapon mesh — which is what makes the two hard requirements
 * true rather than merely intended: the muzzle cannot move (the holder the muzzle is
 * measured from is never touched) and the weapon's own meshes cannot move (nothing else is
 * written to).
 */
export class WeaponMechanism {
  private readonly spec: MechanismSpec;
  private readonly part: Mesh;
  private readonly frame: WeaponFrame;
  /** Rest position of the part, in the model's local space. */
  private readonly rest = new Vector3();
  /** Travel distance in model-local units. */
  private readonly distance: number;
  private elapsed = 0;
  private cycleSeconds = 0;
  private cycling = false;
  private enabled: boolean;

  constructor(model: Object3D, spec: MechanismSpec, enabled = true) {
    this.spec = spec;
    this.enabled = enabled;
    this.frame = measureWeaponFrame(model);

    const profile = PART_PROFILE[spec.kind];
    const length = Math.max(1e-4, profile.length * this.frame.length);
    const height = Math.max(1e-4, profile.height * this.frame.height);
    // Capped against the part's own length: a mesh whose point cloud is spread out across
    // its diagonal — the SMG's is, because its extracted mesh is turned inside its own
    // space — reports a width far larger than the weapon's body, and an uncapped part would
    // be a slab lying across the gun.
    const width = Math.max(1e-4, Math.min(profile.width * this.frame.width, 0.45 * length));
    this.distance = spec.travel * this.frame.length;

    this.part = new Mesh(
      new BoxGeometry(width, height, length),
      new MeshStandardMaterial({
        // The code-built weapons' palette, because the part is built in code: the pack's
        // meshes carry one shared texture atlas with no room in it for a part that does not
        // exist in them, and a box mapped into that atlas would come out mottled.
        color: spec.kind === 'pump' ? WEAPON_PALETTE.polymer : WEAPON_PALETTE.steelDark,
        roughness: spec.kind === 'pump' ? 0.7 : 0.45,
        metalness: spec.kind === 'pump' ? 0.2 : 0.8,
        // The same small lift `normalizeViewModel` gives the weapon's own materials, so a
        // part added after that pass is not the one dark thing on the gun.
        emissive: 0x2a2a30,
      }),
    );
    this.part.name = `weapon-mechanism:${spec.kind}`;
    this.part.castShadow = false;
    this.part.receiveShadow = false;
    // Aligned to the body's own axis: the shotgun and the SMG are both turned in their own
    // space, so a part lined up with the bounding box would lie across the weapon.
    this.part.rotation.y = this.frame.yaw;

    const surface = spec.kind === 'pump'
      // The pump is centred on the body's centre line at its station: it wraps the barrel.
      ? this.frame.centreAt(spec.station)
      : this.frame.topAt(spec.station) - height * (0.5 - profile.protrude);
    this.frame.pointAt(spec.station, this.rest);
    this.rest.y = surface;
    this.part.position.copy(this.rest);
    model.add(this.part);
  }

  /** The moving meshes. One today; a part count a test can hold to. */
  get parts(): readonly Mesh[] {
    return [this.part];
  }

  get kind(): MechanismKind {
    return this.spec.kind;
  }

  /** True while a cycle is in flight. */
  get active(): boolean {
    return this.cycling;
  }

  /** How far the part is from rest right now, 0..1. */
  get travel(): number {
    if (!this.cycling) return 0;
    return mechanismTravel(this.elapsed / this.cycleSeconds, this.spec.kind);
  }

  /**
   * How far the part has moved, in model-local units. Positive is rearward, the direction a
   * slide, a bolt and a pump all travel first.
   */
  get offset(): number {
    return this.travel * this.distance;
  }

  /** Distance from rest to fully back, model-local units. */
  get travelDistance(): number {
    return this.distance;
  }

  /**
   * The body axis this part was placed against, in degrees.
   *
   * Reported rather than only used: it is the one number that says whether a weapon lies
   * along the convention's +Z (near 0) or is turned inside its own space, and therefore
   * whether a fixed offset could have placed this part at all. A harness frame is the only
   * thing that can say whether the result looks right; this says what it was measured from.
   */
  get measuredYawDegrees(): number {
    return Number(((this.frame.yaw * 180) / Math.PI).toFixed(2));
  }

  /** The body's own length along that axis, model-local units. */
  get bodyLength(): number {
    return Number(this.frame.length.toFixed(4));
  }

  /** The part's rest position, model-local units, for a caller that wants the baseline. */
  get restPosition(): Vector3 {
    return this.rest.clone();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Starts one cycle from its first frame, at the weapon's own cadence.
   *
   * Re-triggering restarts it, which is what a burst of automatic fire does to a real bolt:
   * it is on its way back when the next round fires, and the cycle it is on is the one
   * belonging to the shot that just happened.
   */
  trigger(config: WeaponConfig): void {
    if (!this.enabled) return;
    this.cycleSeconds = mechanismCycleSeconds(config);
    this.elapsed = 0;
    this.cycling = true;
    this.applyPosition();
  }

  /** Advances the cycle. Delta 0 (a paused game) freezes the part where it is. */
  update(delta: number): void {
    if (!this.cycling) return;
    this.elapsed += delta;
    if (this.elapsed >= this.cycleSeconds) {
      this.cycling = false;
      this.elapsed = 0;
    }
    this.applyPosition();
  }

  /** Puts the part back where it belongs, with no cycle in flight. */
  reset(): void {
    this.cycling = false;
    this.elapsed = 0;
    this.applyPosition();
  }

  /**
   * Turns the mechanism off, from a quality preset that decided the draw call is not worth
   * it. The part stays in the scene at rest rather than being removed: hiding it would
   * change the weapon's silhouette between tiers, and one mesh is not a reason for a weapon
   * to look different on a slower machine.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  /** Writes the travel into the part's transform. The only place anything moves. */
  private applyPosition(): void {
    this.part.position.copy(this.rest).addScaledVector(this.frame.axis, -this.offset);
  }

  /**
   * Takes the part off the weapon and releases its geometry and material.
   *
   * The part is built per weapon rather than borrowed from a pool, so nothing else
   * references it: leaving it on the mesh after teardown would keep a geometry and a
   * material alive for a weapon nobody is holding.
   */
  dispose(): void {
    this.part.removeFromParent();
    this.part.geometry.dispose();
    const material = this.part.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
  }
}
