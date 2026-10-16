/**
 * Melee weapons.
 *
 * A separate table from `WEAPONS` because almost nothing is shared with the firearms:
 * a gun spends ammunition through a `WeaponRuntime`, while a swing is a cone test with a
 * cooldown and no ammunition at all. Keeping the two apart is what let melee be added
 * without editing a single firearm value.
 *
 * `gameConfig.ts` re-exports this module, so callers keep importing weapon data from one
 * place (the same way `characters.ts` owns the survivor roster).
 */
import type { GripKind } from '../player/proceduralArms';

export type MeleeId = 'knife' | 'axe' | 'barbed-bat' | 'spear';

/**
 * Which of the survivor rig's four melee clips a weapon swings with.
 *
 * `Run_Slash` / `Run_Stab` are deliberately not used: the melee swing is played as a
 * one-shot over whatever locomotion cycle is running, so the running variants would
 * double up with the walk/run clip the avatar is already blending.
 */
export type MeleeClip = 'Slash' | 'Stab';

export interface MeleeViewPlacement {
  /** Local placement of the first-person view model, metres and radians. */
  position: [number, number, number];
  rotation: [number, number, number];
  /**
   * Multiplier on the normalised view model length, the same meaning it has for a
   * firearm: the mesh is normalised by its longest axis, so this is what stops a spear
   * and a knife being drawn the same size on screen.
   */
  scale: number;
}

export interface MeleeConfig {
  id: MeleeId;
  name: string;
  /**
   * Damage of one landed swing.
   *
   * There is no headshot multiplier here and there must not be one: a swing is resolved
   * against the target's body radius, not against its head and body hitboxes, so a
   * headshot bonus would be a number with nothing behind it.
   */
  damage: number;
  /** Total swing arc in radians, centred on the player's facing. */
  arc: number;
  /** Metres from the player to the target's *surface*, not to its centre. */
  reach: number;
  /** Seconds before the next swing may start, measured from the start of this one. */
  cooldownSeconds: number;
  /** Length of the swing itself, seconds. The hit lands partway through it. */
  swingSeconds: number;
  modelPath: string;
  /** Clip the survivor rig plays for this weapon (see `MeleeClip`). */
  clip: MeleeClip;
  viewModel: MeleeViewPlacement;
  /**
   * First-person hand pose.
   *
   * Reused from the firearms rather than extended: a knife handle is gripped like a
   * pistol, and a spear, bat or axe is a two-handed shaft, which is what the rifle pose
   * already is. A dedicated melee pose would be a third set of arms for no visible gain.
   */
  grip: GripKind;
}

/**
 * Balance targets, in damage per second at the weapon's own cooldown:
 * knife ~81, bat ~73, axe ~73, spear ~74.
 *
 * All of them sit below the pistol's ~143 and well below the rifle's, which is the point:
 * melee is what you fall back on when the magazine is empty, not a replacement for
 * shooting. Reach and arc are what buy the trade: the axe sweeps 92 degrees and the spear
 * reaches 3 m, but neither can touch anything at range.
 */
export const MELEE: Record<MeleeId, MeleeConfig> = {
  knife: {
    id: 'knife',
    name: 'Combat Knife',
    damage: 34,
    // 51 degrees: a stab is a narrow thrust, not a sweep.
    arc: 0.9,
    reach: 1.7,
    cooldownSeconds: 0.42,
    swingSeconds: 0.3,
    modelPath: '/assets/weapons/Knife.gltf',
    clip: 'Stab',
    viewModel: { position: [0.3, -0.3, -0.44], rotation: [0, Math.PI, 0.2], scale: 1 },
    grip: 'pistol',
  },
  axe: {
    id: 'axe',
    name: 'Fire Axe',
    damage: 62,
    // 92 degrees: the widest arc of the four, which is what makes it the crowd weapon.
    arc: 1.6,
    reach: 2,
    cooldownSeconds: 0.85,
    swingSeconds: 0.55,
    modelPath: '/assets/weapons/Axe.gltf',
    clip: 'Slash',
    viewModel: { position: [0.31, -0.32, -0.5], rotation: [0, Math.PI, 0.3], scale: 1.15 },
    grip: 'rifle',
  },
  'barbed-bat': {
    id: 'barbed-bat',
    name: 'Barbed Bat',
    damage: 44,
    // 77 degrees, between the axe and the knife: fast enough to swing twice on a runner.
    arc: 1.35,
    reach: 2,
    cooldownSeconds: 0.6,
    swingSeconds: 0.42,
    modelPath: '/assets/weapons/WoodenBat_Barbed.gltf',
    clip: 'Slash',
    viewModel: { position: [0.3, -0.31, -0.48], rotation: [0, Math.PI, 0.25], scale: 1.2 },
    grip: 'rifle',
  },
  spear: {
    id: 'spear',
    name: 'Spear',
    damage: 78,
    // 29 degrees and the longest reach: a thrust that has to be aimed, paid for with the
    // slowest cooldown of the four.
    arc: 0.5,
    reach: 3,
    cooldownSeconds: 1.05,
    swingSeconds: 0.6,
    modelPath: '/assets/weapons/Spear.gltf',
    clip: 'Stab',
    viewModel: { position: [0.32, -0.34, -0.54], rotation: [0, Math.PI, 0.15], scale: 1.6 },
    grip: 'rifle',
  },
};

/**
 * Melee weapon the player carries.
 *
 * The knife, on purpose: the weakest and fastest of the four, so the fallback weapon is
 * not the one a player would rather use than the pistol.
 */
export const DEFAULT_MELEE: MeleeId = 'knife';
