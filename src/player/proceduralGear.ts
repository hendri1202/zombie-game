import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D,
  Quaternion, TorusGeometry, Vector3,
} from 'three';
import type { MeleeId } from '../app/meleeConfig';

/**
 * Jack's gear, built from primitives in code.
 *
 * Nothing here is downloaded: the pack ships the survivors' bodies, and this module
 * makes the parts the concept sheet adds on top (a red axe, a barbed-wire bat, a
 * scavenged backpack and a shell bandolier) out of primitives. That keeps the licence
 * position simple and the file self-contained.
 *
 * The one convention that matters is spatial. The pack parents its own hand-held
 * weapons (`Axe`, `WoodenBat_Barbed`, `Rifle`) to `Middle1.L` with a fixed transform,
 * and models them in *hand space*: the weapon runs along local **+Z**, the grip sits
 * near the origin and the biting end is at high +Z. Everything below follows that, and
 * `PACK_HAND_PLACEMENT` reuses the pack's own numbers, so a weapon built here lands in
 * the fist exactly where the pack's own axe lands instead of being eyeballed.
 */

/** Colours for Jack's kit. Original to this project, not sampled from any artwork. */
export const GEAR_PALETTE = {
  redPaint: 0xa8231f,
  redPaintWorn: 0x7d2420,
  steel: 0x9fa6ad,
  steelDark: 0x4b5158,
  wood: 0x7a5533,
  woodDark: 0x4a3620,
  canvas: 0x39434f,
  canvasDark: 0x272e36,
  strap: 0x1d2126,
  brass: 0xb08d3f,
  barb: 0x8d949b,
} as const;

/**
 * Transform the pack gives its own held weapons under `Middle1.L`.
 *
 * Copied verbatim from `Characters_*.gltf` (node `Axe`, parent `Middle1.L`) rather
 * than tuned by eye. The rig mirrors left to right by negating Y and Z, both in the
 * bone's own local rotation and in its children, which is what `mirrored: true` does
 * below — the right hand then holds a weapon the same way the left one does.
 */
export const PACK_HAND_PLACEMENT = {
  translation: [0.011570863425731659, 0.10461411718807284, -0.04577639698982239] as const,
  rotation: [0.4333183169364929, 0.5568869709968567, 0.4398091435432434, 0.5555899143218994] as const,
} as const;

/** Bones that can hold a weapon, most specific first. */
export const HAND_BONES = {
  left: ['Middle1.L', 'Middle1_L', 'Middle1L', 'Hand.L'],
  right: ['Middle1.R', 'Middle1_R', 'Middle1R', 'Hand.R'],
} as const;

/** Bones the worn gear hangs from: the chest carries the pack and bandolier. */
export const TORSO_BONES = ['Torso', 'Chest', 'Abdomen', 'Hips', 'Body'] as const;

/** Forearm bones, used to work out which way a carried weapon should hang. */
export const FOREARM_BONES = {
  left: ['LowerArm.L', 'LowerArm_L', 'LowerArmL'],
  right: ['LowerArm.R', 'LowerArm_R', 'LowerArmR'],
} as const;

/**
 /**
  * Scale per tool, bringing the built weapon to a real length.
  *
  * These are metres: the survivors' models are normalised to their own height in metres
  * and their raw units are already about a metre per unit, which makes the pack's own
  * axe 1.30 m and its bat 1.24 m long. A real fire axe is about 0.95 m and a real bat
  * about 0.85 m, and at the pack's size the bat reached the ground when it hung from a
  * relaxed hand.
  */
 export const TOOL_SCALE = { axe: 0.67, bat: 0.69 } as const;

 /** How far a carried tool tips forward off the forearm, radians.
 *
 * Nobody walks with a bat pointing straight down — it would drag on the ground — so
 * the weapon is angled forward by this much. It is applied as a blend towards the
 * character's own forward axis rather than as a spin around a local axis, because a
 * local spin's direction depends on how the grip happens to be rolled, while "forward"
 * is the same for every clip.
 */
export const CARRY_TILT = 0.52;

function material(colour: number, roughness: number, metalness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour, roughness, metalness });
}

function add(parent: Group, geometry: import('three').BufferGeometry, mat: MeshStandardMaterial,
  position: readonly [number, number, number], rotation?: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  // Gear rides on the animated skeleton, so it must cast the same shadows the body does.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * A red fire axe: wooden haft along +Z, painted head at the far end, steel edge,
 * and a spike on the butt. Length and blade reach match the pack's own axe extents
 * (z -0.263 .. 1.037, blade to x 0.255) so both read as the same tool at one scale.
 */
export function createAxe(): Group {
  const group = new Group();
  group.name = 'GearAxe';
  const wood = material(GEAR_PALETTE.wood, 0.85, 0.05);
  const woodDark = material(GEAR_PALETTE.woodDark, 0.9, 0.05);
  const red = material(GEAR_PALETTE.redPaint, 0.55, 0.25);
  const redWorn = material(GEAR_PALETTE.redPaintWorn, 0.7, 0.2);
  const steel = material(GEAR_PALETTE.steel, 0.35, 0.85);
  const steelDark = material(GEAR_PALETTE.steelDark, 0.5, 0.8);

  // Haft runs the whole length of the tool; the cylinder's default axis is +Y, so a
  // quarter turn about X lays it along +Z where the hand expects it.
  add(group, new CylinderGeometry(0.026, 0.032, 1.05, 10), wood, [0, 0, 0.262], [Math.PI / 2, 0, 0]);
  // Grip wrap at the near end, where the fist closes.
  add(group, new CylinderGeometry(0.036, 0.036, 0.22, 10), woodDark, [0, 0, -0.15], [Math.PI / 2, 0, 0]);
  // Head socket and the blade itself, with a steel edge strip on the leading side.
  add(group, new BoxGeometry(0.09, 0.12, 0.26), red, [0, 0, 0.93]);
  add(group, new BoxGeometry(0.24, 0.045, 0.28), redWorn, [0.13, 0, 0.94]);
  add(group, new BoxGeometry(0.045, 0.055, 0.3), steel, [0.26, 0, 0.94]);
  // Butt spike.
  add(group, new ConeGeometry(0.019, 0.11, 8), steelDark, [0, 0, -0.315], [Math.PI / 2, 0, 0]);
  // Coordinates above follow the pack's own axe, so the group is scaled to real size
  // here: scaling about the group's origin is scaling about the grip, which shortens
  // the tool towards the hand rather than moving it out of one.
  group.scale.setScalar(TOOL_SCALE.axe);
  return group;
}

/**
 * A baseball bat wrapped in barbed wire: tapered barrel along +Z, wire rings around
 * the fat end with barbs between them. Extents match the pack's `WoodenBat_Barbed`
 * (z -0.33 .. 0.908, radius about 0.09).
 */
export function createBarbedBat(): Group {
  const group = new Group();
  group.name = 'GearBat';
  const wood = material(GEAR_PALETTE.wood, 0.82, 0.05);
  const woodDark = material(GEAR_PALETTE.woodDark, 0.88, 0.05);
  const barb = material(GEAR_PALETTE.barb, 0.4, 0.8);

  add(group, new CylinderGeometry(0.032, 0.03, 0.36, 10), woodDark, [0, 0, -0.15], [Math.PI / 2, 0, 0]);
  // Tapered barrel: after the quarter turn the cylinder's top radius faces +Z, so the
  // fat end lands at the striking end rather than at the grip.
  add(group, new CylinderGeometry(0.088, 0.05, 0.86, 12), wood, [0, 0, 0.47], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.038, 0.038, 0.035, 10), woodDark, [0, 0, -0.34], [Math.PI / 2, 0, 0]);

  // Wire: rings whose radius follows the taper, each with two barbs pointing outward.
  const rings = [0.24, 0.4, 0.55, 0.69, 0.8];
  rings.forEach((z, index) => {
    const radius = 0.062 + index * 0.0065;
    const ring = add(group, new TorusGeometry(radius, 0.006, 5, 14), barb, [0, 0, z]);
    ring.rotation.x = 0;
    for (const angle of [0.5, 2.4, 4.3]) {
      const spike = add(group, new ConeGeometry(0.013, 0.045, 4), barb, [
        Math.cos(angle) * (radius + 0.012), Math.sin(angle) * (radius + 0.012), z,
      ]);
      spike.rotation.z = angle - Math.PI / 2;
    }
  });
  group.scale.setScalar(TOOL_SCALE.bat);
  return group;
}

/**
 * A scavenged backpack: canvas body, top flap, bedroll, side pouch and a radio.
 * Built to sit against the character's back, which the pack's models put at -Z
 * because they face +Z.
 */
export function createBackpack(): Group {
  const group = new Group();
  group.name = 'GearBackpack';
  const canvas = material(GEAR_PALETTE.canvas, 0.95, 0.05);
  const canvasDark = material(GEAR_PALETTE.canvasDark, 0.95, 0.05);
  const strap = material(GEAR_PALETTE.strap, 0.9, 0.1);
  const metal = material(GEAR_PALETTE.steelDark, 0.45, 0.8);

  add(group, new BoxGeometry(0.34, 0.42, 0.17), canvas, [0, 0, -0.15]);
  add(group, new BoxGeometry(0.36, 0.12, 0.19), canvasDark, [0, 0.21, -0.15]);
  // Bedroll lashed across the top.
  add(group, new CylinderGeometry(0.062, 0.062, 0.42, 10), canvasDark, [0, 0.28, -0.17], [0, 0, Math.PI / 2]);
  add(group, new BoxGeometry(0.11, 0.15, 0.12), canvasDark, [0.19, -0.04, -0.16]);
  // Shoulder straps reaching forward over the chest.
  for (const side of [-1, 1]) {
    add(group, new BoxGeometry(0.055, 0.34, 0.025), strap,
      [side * 0.12, -0.06, 0.02], [0.35, 0, 0]);
  }
  // Hand radio on the left strap.
  add(group, new BoxGeometry(0.075, 0.1, 0.05), strap, [-0.21, 0.02, -0.12]);
  add(group, new CylinderGeometry(0.006, 0.006, 0.14, 6), metal, [-0.21, 0.13, -0.12]);
  return group;
}

/** A bandolier of brass shells across the chest, over the jacket's shoulder line. */
export function createBandolier(): Group {
  const group = new Group();
  group.name = 'GearBandolier';
  const strap = material(GEAR_PALETTE.strap, 0.9, 0.1);
  const brass = material(GEAR_PALETTE.brass, 0.35, 0.85);

  add(group, new BoxGeometry(0.46, 0.075, 0.03), strap, [0, 0, 0.115], [0, 0, 0.62]);
  for (let index = 0; index < 6; index += 1) {
    const t = (index - 2.5) / 2.5;
    add(group, new CylinderGeometry(0.014, 0.014, 0.055, 8), brass,
      [t * 0.19, t * 0.135, 0.135], [0, 0, 0.62]);
  }
  return group;
}

export type GearWeapon = 'axe' | 'bat';

/**
 * The slung tool a melee weapon corresponds to, or null when it has no twin.
 *
 * Jack carries an axe and a barbed bat strapped to his pack (see `GearSpec.onPack`). When
 * the player draws the matching melee weapon, that weapon would be the same tool twice —
 * one in the hand and one on the back — so a drawn melee weapon hides its slung copy and
 * restores it when holstered. A knife or a spear is never slung, hence null.
 */
export function slungGearWeapon(meleeId: MeleeId): GearWeapon | null {
  if (meleeId === 'axe') return 'axe';
  if (meleeId === 'barbed-bat') return 'bat';
  return null;
}

/** What a character wears and holds. Weapons are per hand so an axe and a bat coexist. */
export interface GearSpec {
  leftHand?: GearWeapon | null;
  rightHand?: GearWeapon | null;
  backpack?: boolean;
  bandolier?: boolean;
  /**
   * Weapons strapped to the pack rather than held.
   *
   * For a character who carries melee weapons but is currently holding a firearm: with a
   * gun in hand, an axe and a bat gripped in both fists is simply wrong, and the mesh does
   * not care that the game has no melee system yet.
   */
  onPack?: readonly GearWeapon[];
}

function buildWeapon(weapon: GearWeapon): Group {
  return weapon === 'axe' ? createAxe() : createBarbedBat();
}

/** The topmost ancestor of an object, i.e. the loaded body itself. */
function outermost(object: Object3D): Object3D {
  let node = object;
  while (node.parent) node = node.parent;
  return node;
}

function findBone(root: Object3D, candidates: readonly string[]): Object3D | null {
  for (const name of candidates) {
    const found = root.getObjectByName(name);
    if (found) return found;
  }
  return null;
}

/**
 * Places one weapon in one hand using the pack's own hand transform.
 *
 * `mirrored` flips the rig's left/right convention: the bones themselves differ by
 * negated Y and Z, so their children do too. Without it a weapon built for the left
 * hand lands behind the right one, upside down.
 */
export function placeInHand(hand: Object3D, weapon: Group, mirrored: boolean): void {
  const sign = mirrored ? -1 : 1;
  weapon.position.set(
    sign * PACK_HAND_PLACEMENT.translation[0],
    PACK_HAND_PLACEMENT.translation[1],
    sign * PACK_HAND_PLACEMENT.translation[2],
  );
  weapon.quaternion.set(
    PACK_HAND_PLACEMENT.rotation[0],
    sign * PACK_HAND_PLACEMENT.rotation[1],
    sign * PACK_HAND_PLACEMENT.rotation[2],
    PACK_HAND_PLACEMENT.rotation[3],
  );
  hand.add(weapon);
}

/**
 * Turns a freshly placed weapon so it hangs along the forearm.
 *
 * The pack authors its grip transform for the gun-holding clips, where the arms are
 * raised and the weapon points forward. Reused as-is with the plain cycles (arms down)
 * the weapon ends up aimed up and back, past the character's face — visible in a
 * captured frame as a bat whose fat end sits by his ear.
 *
 * The fix is to aim the weapon down the forearm *once*, while the skeleton is still in
 * its bind pose: the correction is a fixed local rotation, so the forearm carries the
 * weapon correctly through every clip afterwards (down with the arms down, forward in
 * the gun pose). Aligning to the forearm rather than to a world direction keeps this
 * independent of which way the character happens to be facing.
 *
 * Returns false when there is no forearm bone to align with, in which case the pack's
 * own grip rotation stands.
 */
export function alignToForearm(
  hand: Object3D, weapon: Object3D, forearm: Object3D | null, tilt = CARRY_TILT,
): boolean {
  if (!forearm) return false;
  hand.updateWorldMatrix(true, false);
  const handQuaternion = hand.getWorldQuaternion(new Quaternion());
  // The weapon's world rotation as placed, before any correction is applied.
  const placed = handQuaternion.clone().multiply(weapon.quaternion);
  const down = hand.getWorldPosition(new Vector3())
    .sub(forearm.getWorldPosition(new Vector3()))
    .normalize();
  if (down.lengthSq() < 0.5) return false;

  // Tip the hang forward, towards the direction the character faces. The model's own
  // forward is the +Z of the outermost object above the hand, which is the same axis
  // the pack's models face and therefore independent of the grip's roll.
  const root = outermost(hand);
  const forward = new Vector3(0, 0, 1).applyQuaternion(root.getWorldQuaternion(new Quaternion()));
  const target = down.addScaledVector(forward, Math.tan(tilt)).normalize();

  // Where the weapon's own +Z has to point, expressed in the weapon's local space.
  const local = target.applyQuaternion(placed.clone().invert()).normalize();
  const correction = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), local);
  weapon.quaternion.multiply(correction);
  return true;
}

export interface GearAttachmentReport {
  /** Names of the gear groups that were added. */
  attached: string[];
  /** Gear asked for but not attached, with the reason. */
  skipped: string[];
  /**
   * Slung tools keyed by kind, so the avatar can hide the one a drawn melee weapon
   * duplicates and show it again when the weapon is holstered. Empty when the character
   * carries nothing on the pack.
   */
  slung: Partial<Record<GearWeapon, Object3D>>;
}

/**
 * Adds a character's gear to a loaded body.
 *
 * Missing bones are reported rather than thrown: a body from another pack simply
 * comes out with less gear on it, which is a diagnostic worth seeing instead of a
 * crash at character-select time.
 */
export function attachGear(body: Object3D, spec: GearSpec): GearAttachmentReport {
  const attached: string[] = [];
  const skipped: string[] = [];
  const slung: Partial<Record<GearWeapon, Object3D>> = {};
  // Weapons are aligned from bone world positions, so the bind pose has to be resolved
  // before anything is placed.
  body.updateMatrixWorld(true);

  const hands = {
    left: findBone(body, HAND_BONES.left),
    right: findBone(body, HAND_BONES.right),
  };
  const torso = findBone(body, TORSO_BONES);

  const forearms = {
    left: findBone(body, FOREARM_BONES.left),
    right: findBone(body, FOREARM_BONES.right),
  };

  const place = (weapon: GearWeapon, side: 'left' | 'right'): void => {
    const hand = hands[side];
    if (!hand) {
      skipped.push(`${weapon}:${side} hand bone not found`);
      return;
    }
    const group = buildWeapon(weapon);
    placeInHand(hand, group, side === 'right');
    // A rig without the forearm bone still gets the weapon, held with the pack's own
    // grip rotation: degraded, not skipped.
    alignToForearm(hand, group, forearms[side]);
    attached.push(group.name);
  };

  if (spec.rightHand) place(spec.rightHand, 'right');
  if (spec.leftHand) place(spec.leftHand, 'left');

  if (spec.backpack) {
    if (!torso) skipped.push('backpack: torso bone not found');
    else {
      const group = createBackpack();
      torso.add(group);
      attached.push(group.name);
    }
  }
  if (spec.bandolier) {
    if (!torso) skipped.push('bandolier: torso bone not found');
    else {
      const group = createBandolier();
      torso.add(group);
      attached.push(group.name);
    }
  }

  if (spec.onPack && spec.onPack.length > 0) {
    if (!torso) skipped.push('pack gear: torso bone not found');
    else {
      spec.onPack.forEach((weapon, index) => {
        const group = buildWeapon(weapon);
        // Slung on the pack, one down each side of it, tilted back and out so the tool
        // rises past the shoulder the way it is actually carried.
        //
        // The z is behind the pack, not on it: the first placement sat at -0.17, which is
        // *inside* the pack's own volume (z -0.235 clamps to -0.065), so both tools were
        // built, attached, counted in the gear report, and completely invisible.
        const side = index % 2 === 0 ? 1 : -1;
        group.position.set(side * 0.13, -0.12, -0.3 - index * 0.02);
        group.rotation.set(-1.25, 0, side * 0.3);
        torso.add(group);
        attached.push(group.name);
        slung[weapon] = group;
      });
    }
  }
  return { attached, skipped, slung };
}
