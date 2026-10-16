/**
 * Ordnance: the grenades, which are slot 4 in the category scheme from
 * `implementation-plan/2026-10-15-melee-store-poin-v2.md` §14.1.
 *
 * A third table, beside `WEAPONS` and `MELEE`, because a grenade shares almost nothing with
 * either: it is neither a magazine of hitscan rounds nor a swing arc. It is thrown, it flies
 * under gravity, it burns a fuse and it damages everything in a radius. Keeping the numbers
 * here means the physics, the HUD, the store and the tests all read one authority, the same
 * arrangement the melee table already has (`meleeConfig.ts`).
 *
 * `gameConfig.ts` re-exports this module, so callers keep importing weapon data from one place.
 */
import type { GripKind } from '../player/proceduralArms';

export type GrenadeId = 'frag';

/** Downward acceleration on a thrown grenade, m/s². Real gravity: the arc is the tell. */
export const GRENADE_GRAVITY = 9.81;

export interface GrenadeConfig {
  id: GrenadeId;
  name: string;
  /**
   * Slot 4, the ordnance category. Like melee's slot 3 this is a constant: every ordnance
   * item rides the one key and the key rotates within the category.
   */
  slot: 4;
  /** Seconds from the throw to the detonation. Long enough to run from, short enough to matter. */
  fuseSeconds: number;
  /** Blast radius in metres. Nothing beyond it is touched by the falloff — see grenadeDamageAt. */
  radius: number;
  /** Damage at the very centre of the blast. Falls to zero at the rim. */
  maxDamage: number;
  /** Speed the grenade leaves the hand at, m/s, along the aim direction. */
  throwSpeed: number;
  /**
   * Upward velocity added to the throw, m/s. Without it a level throw would skim the ground
   * and detonate at the player's feet instead of arcing out to where they aimed.
   */
  throwLift: number;
  /** Grenades the player starts a run with, before any purchase or pickup. */
  startingCount: number;
  /** Grenades delivered by one store purchase. */
  storeQuantity: number;
  /** Grenades delivered by one pickup. */
  pickupQuantity: number;
  /** Ceiling on live grenades, so a held trigger cannot fill the scene with projectiles. */
  maxLive: number;
  modelPath: string;
  viewModel: {
    position: [number, number, number];
    rotation: [number, number, number];
    /** Multiplier on the normalised view-model length, same meaning as for a firearm or melee. */
    scale: number;
  };
  /** First-person hand pose: a grenade is held one-handed like a sidearm. */
  grip: GripKind;
}

export const GRENADES: Record<GrenadeId, GrenadeConfig> = {
  frag: {
    id: 'frag',
    name: 'Frag Grenade',
    slot: 4,
    // 2.75 s: inside the "2.5-3 s" the owner asked for, and long enough that a grenade thrown
    // at a horde is a decision rather than a panic button.
    fuseSeconds: 2.75,
    radius: 6,
    // 160 at the centre: a walker (100) dies from close range, a brute takes a bite, and the
    // falloff means the rim of the blast only staggers. The crowd answer melee cannot give.
    maxDamage: 160,
    throwSpeed: 14,
    throwLift: 4.5,
    startingCount: 2,
    storeQuantity: 2,
    pickupQuantity: 1,
    maxLive: 6,
    modelPath: '/assets/weapons/Grenade.gltf',
    viewModel: { position: [0.3, -0.28, -0.46], rotation: [0, Math.PI, 0], scale: 1.1 },
    grip: 'pistol',
  },
};

/** The grenade a fresh run carries and the id slot 4 selects. */
export const DEFAULT_GRENADE: GrenadeId = 'frag';
