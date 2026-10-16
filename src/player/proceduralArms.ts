import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

/**
 * First-person hands, built from primitives.
 *
 * The game had no first-person arms at all: the pack ships weapon meshes without hands,
 * and the survivors' own arms stay below the frame in the pose the pack authored for
 * holding a gun, so first person showed a pistol floating in space. A sculpted pair of
 * arms was the first choice, but the CC0 packs that offer one ship FBX and .blend only,
 * which this project's glTF-only policy cannot load and no converter is available for.
 *
 * So the hands are boxes and cylinders, which suits a low-poly game and, more usefully,
 * puts the grip exactly where the weapon is instead of where an artist posed it. The
 * rig is not animated: the hands ride the same holder the weapon does, so the kick,
 * sway and reload tilt move hands and weapon together as one unit.
 *
 * Convention: everything is authored in *grip space* — the weapon's grip sits at the
 * origin, +X is to the shooter's right, +Y up and +Z toward the shooter, so the arms
 * extend back and down out of frame.
 */

export interface ArmPalette {
  /** Bare skin, for the wrist between sleeve and glove. */
  skin: number;
  /** Glove leather. */
  glove: number;
  /** Sleeve of the survivor's jacket. */
  sleeve: number;
  gloveDark: number;
}

export const ARM_PALETTE: ArmPalette = {
  skin: 0x8a6a50,
  glove: 0x3a3b42,
  sleeve: 0x4c5568,
  gloveDark: 0x282a30,
};

/**
 * How long a forearm is from elbow to glove, metres, in view-model space.
 *
 * Longer than an anatomical forearm on purpose: what reads as two arms entering the frame
 * from the bottom corner has to reach that corner, and at 0.34 m the arms ended inside the
 * frame as a stub with no length at all.
 */
export const FOREARM_LENGTH = 0.5;
export const WRIST_RADIUS = 0.055;

/**
 * The lift applied to hand materials.
 *
 * Slightly stronger than the weapon's own lift (0x2a2a30): hands are darker than the
 * gun's plastic and the dusk lighting would otherwise leave them a black shape in the
 * corner of the screen.
 */
export const HAND_EMISSIVE = 0x33333a;

function material(colour: number, roughness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: colour, roughness, metalness: 0.05, emissive: HAND_EMISSIVE, emissiveIntensity: 1,
  });
}

function add(parent: Group, geometry: BufferGeometry, mat: MeshStandardMaterial,
  position: readonly [number, number, number], rotation?: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  // View-model geometry takes no part in the shadow pass: it sits inside the camera.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  parent.add(mesh);
  return mesh;
}

/**
 * One gloved hand, curled around a grip at the group's origin.
 *
 * Fingers are short boxes rather than modelled joints: at this size, on a low-poly
 * character, they read as a hand wrapping a grip and nothing more is visible.
 */
export function createGlovedHand(palette: ArmPalette = ARM_PALETTE): Group {
  const hand = new Group();
  hand.name = 'GripHand';
  const glove = material(palette.glove, 0.8);
  const gloveDark = material(palette.gloveDark, 0.85);

  // Palm behind the grip, tilted so it wraps rather than sits flat.
  add(hand, new BoxGeometry(0.095, 0.14, 0.08), glove, [0, 0, 0.012]);
  // Four fingers curling forward over the grip. Spaced wider than a real hand: individual
  // fingers are only a pixel or two apart at this scale, so tighter spacing merges into
  // one blob of polygons.
  for (let index = 0; index < 4; index += 1) {
    const y = 0.045 - index * 0.032;
    const length = 0.085 - Math.abs(index - 1) * 0.01;
    add(hand, new BoxGeometry(0.022, 0.02, length), gloveDark,
      [-0.056, y, -length / 2 + 0.004], [0, 0.35, 0]);
  }
  // Thumb across the back of the grip.
  add(hand, new BoxGeometry(0.055, 0.022, 0.026), gloveDark, [0.02, 0.05, -0.03], [0, -0.5, 0.4]);
  return hand;
}

/**
 * A forearm ending in a gloved hand, extending back and down from a grip at the origin.
 *
 * `side` is +1 for the right arm and -1 for the left; the left arm reaches further
 * forward because it supports the weapon's fore-end rather than gripping the trigger.
 */
export function createArm(side: 1 | -1, reach: number, palette: ArmPalette = ARM_PALETTE): Group {
  const arm = new Group();
  arm.name = side === 1 ? 'RightArm' : 'LeftArm';
  const skin = material(palette.skin, 0.9);
  const sleeve = material(palette.sleeve, 0.95);

  const hand = createGlovedHand(palette);
  hand.position.set(0, 0, reach);
  arm.add(hand);

  // Forearm: a tapered cylinder running back along +Z from the wrist.
  const forearm = new CylinderGeometry(WRIST_RADIUS, WRIST_RADIUS * 1.25, FOREARM_LENGTH, 7);
  add(arm, forearm, skin, [0, -0.004, reach + FOREARM_LENGTH / 2], [Math.PI / 2, 0, 0]);
  // Jacket sleeve over the back half of the forearm, slightly fatter.
  add(arm, new CylinderGeometry(WRIST_RADIUS * 1.3, WRIST_RADIUS * 1.5, FOREARM_LENGTH * 0.62, 7),
    sleeve, [0, -0.006, reach + FOREARM_LENGTH * 0.72], [Math.PI / 2, 0, 0]);
  // Wrist band where sleeve meets glove.
  add(arm, new CylinderGeometry(WRIST_RADIUS * 1.08, WRIST_RADIUS * 1.08, 0.035, 7),
    sleeve, [0, -0.004, reach + 0.02], [Math.PI / 2, 0, 0]);
  return arm;
}

/** Which pose suits which weapon shape. */
export type GripKind = 'pistol' | 'rifle';

export interface HandsPlacement {
  /**
   * Nudge from the weapon model's own origin, in the holder's space, metres.
   *
   * Both hands and weapon are children of the holder, and the weapon model sits at that
   * origin, so this must be a nudge — a few centimetres towards the shooter and down for
   * the grip. Two earlier attempts got this wrong in opposite directions: absolute
   * view-model coordinates put the hands 42 degrees below the view axis (built, never on
   * screen), and adding the weapon's *placement* on top of the offset double-applied it
   * and pushed them out of frame again.
   */
  offset: [number, number, number];
  /** Rotation applied to the whole hands group. */
  rotation: [number, number, number];
  /** How far forward the support hand reaches along the weapon, metres. */
  supportReach: number;
}

/**
 * Where the hands sit relative to whichever weapon is mounted.
 *
 * Tuned against captured frames, not derived: the weapon models are normalised by their
 * longest axis and keep their own origin, so there is no reliable grip point to compute
 * from.
 */
export const HANDS_PLACEMENT: Record<GripKind, HandsPlacement> = {
  pistol: { offset: [0.01, -0.02, 0.07], rotation: [0.16, 0, 0], supportReach: 0.1 },
  rifle: { offset: [0.01, -0.02, 0.1], rotation: [0.12, 0, 0], supportReach: 0.34 },
};

/**
 * Both arms as one group, in grip space, ready to be placed at `HANDS_PLACEMENT`.
 *
 * The right arm is authored so its hand wraps the origin; the left starts at
 * `supportReach` because it holds the weapon further along.
 */
export function createFirstPersonHands(kind: GripKind, palette: ArmPalette = ARM_PALETTE): Group {
  const group = new Group();
  group.name = `Hands:${kind}`;
  const placement = HANDS_PLACEMENT[kind];

  // Each arm is pitched down and out so the forearm leaves the frame through the bottom
  // corner. Run straight back towards the camera instead and the arm hides behind the
  // weapon: the first attempt showed a hand and no arm at all.
  const right = createArm(1, 0, palette);
  right.position.set(0.012, -0.03, 0.01);
  right.rotation.set(0.95, 0.5, 0.12);
  group.add(right);

  const left = createArm(-1, placement.supportReach, palette);
  left.position.set(-0.03, -0.078, -placement.supportReach * 0.9);
  left.rotation.set(0.85, -0.62, -0.2);
  group.add(left);
  return group;
}
