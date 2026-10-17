/**
 * The code-built optic body: the sight a weapon's own mesh does not have.
 *
 * Why the housing exists at all: a reticle drawn only as a DOM overlay is a mark floating in
 * the middle of the screen, and a player looking down the sights of a rifle with nothing on
 * top of it reads the mark as a HUD element rather than as a sight. So the weapons whose
 * meshes ship no sight get a small red dot or scope built in code and mounted on the receiver,
 * the way `proceduralWeapons.ts` builds a whole weapon and `weaponMechanism.ts` builds a
 * moving part.
 *
 * Where it goes is measured, never assumed. The mesh's own frame (`measureWeaponFrame`) gives
 * the body's long axis and the height of its own top surface at a station, so the housing sits
 * on the receiver of a rifle that runs along +Z and of the SMG that was extracted from the
 * survivor bundle turned 40 degrees inside its own space. A fixed offset would put one of them
 * in mid-air beside the weapon.
 *
 * What it must not do, and cannot by construction:
 *
 *   - **Move the muzzle.** The muzzle the flash and the tracer leave from is a fixed offset
 *     from the view-model holder (`WEAPON_FEEL.muzzleOffset`); this file adds a child to the
 *     weapon mesh and writes to nothing else. No mesh of the weapon is touched: the housing is
 *     a separate object with its own geometry, and `mountOptic` never rewrites the model's own
 *     position, scale or rotation.
 *   - **Change the weapon.** Nothing here reads or writes damage, fire rate, magazine or
 *     spread: this module cannot see a `WeaponConfig` at all.
 *   - **Break the mechanism.** Optics are mounted *after* the moving parts in
 *     `WeaponController`, and the parts are parked at rest while a weapon is put away. The
 *     mechanism measures the weapon's own geometry, so the order matters: a housing mounted
 *     first would be measured as part of the receiver and the bolt would sit on top of the
 *     sight. Mounted second, the part's rest pose is where the mechanism already put it.
 *   - **Cover the muzzle.** The housing stops well short of the barrel's tip: the station comes
 *     from the table and the extents from the mesh, and `muzzleClearance` is reported so a test
 *     can hold the pair to it rather than trusting the arithmetic.
 */

import {
  BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D,
} from 'three';
import { reticleFor, type OpticKind } from '../app/opticsConfig';
import { WEAPON_PALETTE } from './proceduralWeapons';
import { measureWeaponFrame } from './weaponMechanism';
import { clamp } from '../utils/math';

/**
 * Name every part this feature adds carries.
 *
 * Prefixed so a test (and a diagnosis) can find exactly this feature's meshes on a weapon and
 * nothing else: `weapon-mechanism:` already claims that role for the moving parts, and the two
 * must not be told apart by guessing which box is which.
 */
export const OPTIC_MESH_PREFIX = 'weapon-optic:';

/** What one mounted housing is, and the measurements that say it is where it should be. */
export interface MountedOptic {
  /** The housing, parented to the weapon's view model. */
  group: Group;
  weaponId: string;
  kind: OpticKind;
  /** Where the housing sits along the body, 0 at the rear of the mesh, 1 at the muzzle. */
  station: number;
  /** The housing's forward-most point, measured from the rear of the body, model-local units. */
  forwardReach: number;
  /** The body's own length along its axis: the barrel's tip is at its far end. */
  bodyLength: number;
  /**
   * `bodyLength - forwardReach`: how far this feature stops short of the barrel's tip.
   * Positive means the housing is behind the muzzle, which is the only acceptable sign.
   */
  muzzleClearance: number;
}

/**
 * The housing's dimensions, as fractions of the body's own length.
 *
 * Fractions of the *length* and not of the height or the width, because those two are not
 * reliable on every mesh: the SMG's extracted geometry is diagonal, and its measured height
 * and width include that diagonal spread, so a sight sized from them would be a slab. The
 * length is the axis `measureWeaponFrame` measures by construction.
 */
const HOUSING = {
  /** Rail and tube length along the body. */
  length: 0.16,
  /** Tube diameter: the sight's own thickness. */
  diameter: 0.05,
  /** Height of the rail block between the receiver's surface and the tube. */
  railHeight: 0.02,
  /** The illuminated mark's diameter, as a fraction of the tube's diameter. */
  markFraction: 0.34,
} as const;

function material(colour: number | string, roughness: number, metalness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: colour,
    roughness,
    metalness,
    // The same small lift `normalizeViewModel` gives the weapon's own materials. The housing
    // is built after that pass (it is mounted on an already-loaded view model), so without
    // this it would be the one black object on a gun in the dusk light.
    emissive: 0x2a2a30,
  });
}

/**
 * True when the mesh already carries a sight of its own.
 *
 * A guard, not the decision: the table says which weapons get a housing (`OPTICS[].housing`),
 * and this only refuses to stack a second one on a mesh that already names a scope — the AUG
 * ships `AugScopeTube`, `AugScopeObjective` and `AugScopeEyepiece` as its integrated optic.
 * It matches `scope|optic` and deliberately not `sight`: iron sights (the MP7's front and rear,
 * the 870's bead) are the thing a red dot replaces, not a sight that is already there.
 *
 * The P90's integrated optic is *not* caught here, because those meshes are unnamed — which is
 * exactly why the table carries the decision as well. This is the safety net for a scope that
 * someone named, and `null` housing is the row for one that nobody did.
 */
export function hasExistingOptic(model: Object3D): boolean {
  let found = false;
  model.traverse((child) => {
    if (found) return;
    const name = child.name;
    // This feature's own meshes carry the prefix, and it contains "optic": without this a
    // second call would see the first housing as an existing sight.
    if (!name || name.startsWith(OPTIC_MESH_PREFIX)) return;
    if (/scope|optic/i.test(name)) found = true;
  });
  return found;
}

/** Every mesh this feature added to a weapon, by the name it was given. */
export function opticParts(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh && mesh.name.startsWith(OPTIC_MESH_PREFIX)) found.push(mesh);
  });
  return found;
}

function add(parent: Group, name: string, geometry: BufferGeometry, mat: MeshStandardMaterial,
  position: readonly [number, number, number],
  rotation?: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.name = `${OPTIC_MESH_PREFIX}${name}`;
  mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  // A view model is inside the camera and is never in the shadow pass, exactly like the
  // weapon it is mounted on and its own moving parts.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

/**
 * Mounts a code-built optic on a weapon's view model, if the table says it needs one.
 *
 * Returns what was mounted, or `null` when nothing was: the weapon has no reticle, has a bead
 * (an iron sight, not an optic), or its mesh already ships a sight. Idempotent — calling it
 * twice leaves one housing, which is what lets a caller mount without tracking whether it has
 * been here before.
 *
 * The frame is measured on the model as it is handed over. In the game that is the weapon with
 * its moving part already built (see the module comment): the part sits on the receiver's own
 * surface, so the worst it can do is lift the housing by the part's half-height — a centimetre
 * on the rifles — which reads as a sight mounted a little high and not as a sight off the gun.
 */
export function mountOptic(model: Object3D, weaponId: string): MountedOptic | null {
  const spec = reticleFor(weaponId);
  if (!spec || !spec.housing) return null;
  if (hasExistingOptic(model) || opticParts(model).length > 0) return null;

  const frame = measureWeaponFrame(model);
  if (!(frame.length > 0) || !(frame.height > 0)) return null;

  const length = HOUSING.length * frame.length;
  const radius = (HOUSING.diameter * frame.length) / 2;
  const railHeight = HOUSING.railHeight * frame.length;
  // The rail is as wide as the receiver where that can be measured, and never wider than the
  // tube it carries: the SMG's reported width is its diagonal, not its body.
  const railWidth = Math.max(1e-5, Math.min(0.6 * frame.width, 2 * radius * 0.9));
  // Kept off the very ends of the weapon: a station at 0 would be the stock, at 1 the muzzle.
  const station = clamp(spec.housing.station, 0.05, 0.9);

  const group = new Group();
  group.name = `${OPTIC_MESH_PREFIX}${weaponId}`;
  // Placed on the body's own centre line at that station, then rotated so its local +Z runs
  // along the body's axis — which is what puts it on top of a mesh that lies diagonally in its
  // own space instead of across it.
  frame.pointAt(station, group.position);
  group.position.y = frame.topAt(station) + railHeight / 2;
  group.rotation.y = frame.yaw;

  const gunmetal = material(WEAPON_PALETTE.gunmetal, 0.5, 0.75);
  const steel = material(WEAPON_PALETTE.steelDark, 0.45, 0.8);
  const glass = material(0x11151a, 0.25, 0.6);
  // The illuminated mark, in the reticle's own colour: the dot the player sees through the
  // housing and the dot drawn over the middle of the screen are the same sight, so they are
  // the same value (`OpticSpec.color`). Emissive rather than lit, because it is a lamp.
  const markMaterial = new MeshStandardMaterial({
    color: spec.color,
    emissive: spec.color,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.1,
  });

  // A cylinder's axis is its local Y, so everything that has to lie along the weapon (the
  // tube, the lens, the mark) is turned a quarter turn about X to run along the group's Z.
  const ALONG_Z = [Math.PI / 2, 0, 0] as const;
  const tubeY = railHeight / 2 + radius;

  // Rail block: the mount, sitting on the receiver's top surface (its centre is half its own
  // height above the surface, which is why the group was lifted by railHeight / 2).
  add(group, 'rail', new BoxGeometry(railWidth, railHeight, length), steel, [0, 0, 0]);
  // Tube: the sight body, lying along the weapon, resting on the rail.
  add(group, 'tube', new CylinderGeometry(radius, radius, length, 12), gunmetal, [0, tubeY, 0], ALONG_Z);
  // Lens: the objective at the shooter's end of the tube, and the mark on the glass.
  const lensThickness = radius * 0.32;
  add(group, 'lens', new CylinderGeometry(radius * 0.92, radius * 0.92, lensThickness, 12), glass,
    [0, tubeY, -length / 2 + lensThickness / 2], ALONG_Z);
  const markRadius = Math.max(1e-5, radius * HOUSING.markFraction);
  add(group, 'mark', new CylinderGeometry(markRadius, markRadius, lensThickness * 0.6, 10),
    markMaterial, [0, tubeY, -length / 2 + lensThickness], ALONG_Z);

  model.add(group);

  // Measured from the body's rear along its own axis: the station puts the group's origin, and
  // the tube is the longest part in either direction, so half of it is the reach.
  const forwardReach = station * frame.length + length / 2;
  return {
    group,
    weaponId,
    kind: spec.kind,
    station,
    forwardReach,
    bodyLength: frame.length,
    muzzleClearance: frame.length - forwardReach,
  };
}

/** Takes a housing back off the weapon and releases its geometry and materials. */
export function disposeOptic(optic: MountedOptic): void {
  optic.group.removeFromParent();
  optic.group.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
  });
}
