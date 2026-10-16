/**
 * Playable survivors.
 *
 * All four come from the same CC0 pack as the zombies (see `ASSET_CREDITS.md`)
 * and share its single texture atlas, so choosing one costs no extra texture
 * memory — only its own model file is fetched, and only when it is picked.
 *
 * Stats are multipliers on the base `PLAYER` configuration, kept here rather than
 * scattered through the controllers so the balance lives in one file.
 */
import type { GearSpec } from '../player/proceduralGear';

export type CharacterId = 'lis' | 'matt' | 'sam' | 'shaun' | 'jack';

export interface CharacterStats {
  /** Player health ceiling. */
  maxHealth: number;
  /** Metres per second on foot. */
  walkSpeed: number;
  /** Metres per second while sprinting. */
  sprintSpeed: number;
  /** Multiplier on reload duration: below 1 is faster. */
  reloadMultiplier: number;
  /** Multiplier on weapon damage. */
  damageMultiplier: number;
}

export interface CharacterSpec {
  id: CharacterId;
  /** Display name. Original to this project. */
  name: string;
  /** One-line role, shown on the selection card. */
  tagline: string;
  /** Model file under `public/assets/characters/survivors/`. */
  file: string;
  /** Height in metres. The model is normalised to this, so all share one scale. */
  height: number;
  /** Accent colour for the selection UI and the debug overlay. */
  tint: number;
  stats: CharacterStats;
  /**
   * Clip candidates per locomotion state, most specific first. These characters
   * ship gun-holding variants ("Idle_Gun", "Walk_Gun", "Run_Gun") plus the plain
   * ones, so both are listed and the resolver picks what the file actually has.
   */
  clips: { idle: readonly string[]; walk: readonly string[]; run: readonly string[] };
  /**
   * Bundled mesh kept visible as the weapon in hand, matched case-insensitively.
   *
   * The character files ship the pack's whole inventory parented to the hand bone,
   * so one is chosen here and the rest are switched off. `null` keeps none.
   */
  weaponMesh: string | null;
  /**
   * Worn and hand-held gear built in code by `proceduralGear` (see that module for
   * the hand-space convention). Characters with gear hide every bundled weapon mesh
   * and carry these instead.
   */
  gear?: GearSpec;
}

const GUN_CLIPS = {
  idle: ['Idle_Gun', 'Idle'],
  walk: ['Walk_Gun', 'Walk'],
  run: ['Run_Gun', 'Run'],
} as const;

/**
 * Jack: the melee survivor from the concept sheet.
 *
 * He reuses Matt's body from the pack — a new sculpt is not something code can produce —
 * and gets the concept's identity from what is added to it: a red axe, a barbed-wire bat,
 * a scavenged backpack and a shell bandolier.
 *
 * He holds the pack's rifle and carries the axe and bat **on the pack**, because the game
 * has no melee system yet: with a rifle in his hands, an axe and a bat gripped in both
 * fists was just wrong. When melee lands, the two swap places with the equipped slot.
 */
export const JACK: CharacterSpec = {
  id: 'jack',
  name: 'Jack',
  tagline: 'Jarak dekat — kapak merah, bat berduri, dan ransel hasil jarahan',
  file: 'Characters_Matt.gltf',
  height: 1.86,
  tint: 0x4a6fa5,
  weaponMesh: 'Rifle',
  gear: { onPack: ['axe', 'bat'], backpack: true, bandolier: true },
  stats: { maxHealth: 130, walkSpeed: 4.1, sprintSpeed: 6.6, reloadMultiplier: 1.05, damageMultiplier: 1.15 },
  clips: GUN_CLIPS,
};

export const CHARACTERS: readonly CharacterSpec[] = [
  {
    id: 'lis',
    name: 'Lis',
    tagline: 'Seimbang — pengawal jalan yang bisa diandalkan',
    file: 'Characters_Lis.gltf',
    height: 1.72,
    tint: 0x7fb2e5,
    weaponMesh: 'Rifle',
    stats: { maxHealth: 110, walkSpeed: 4.4, sprintSpeed: 7.2, reloadMultiplier: 0.92, damageMultiplier: 1 },
    clips: GUN_CLIPS,
  },
  {
    id: 'matt',
    name: 'Matt',
    tagline: 'Tahan pukul — banyak darah, langkah berat',
    file: 'Characters_Matt.gltf',
    height: 1.84,
    tint: 0xe5a55c,
    weaponMesh: 'Rifle',
    stats: { maxHealth: 150, walkSpeed: 3.9, sprintSpeed: 6.2, reloadMultiplier: 1.15, damageMultiplier: 1.1 },
    clips: GUN_CLIPS,
  },
  {
    id: 'sam',
    name: 'Sam',
    tagline: 'Cepat — lari kencang, badan ringkih',
    file: 'Characters_Sam.gltf',
    height: 1.66,
    tint: 0x8fd6a8,
    weaponMesh: 'Rifle',
    stats: { maxHealth: 85, walkSpeed: 4.9, sprintSpeed: 8.4, reloadMultiplier: 0.95, damageMultiplier: 0.95 },
    clips: GUN_CLIPS,
  },
  {
    id: 'shaun',
    name: 'Shaun',
    tagline: 'Penembak jitu — reload cepat, damage lebih besar',
    file: 'Characters_Shaun.gltf',
    height: 1.78,
    tint: 0xd98fb5,
    weaponMesh: 'Rifle',
    stats: { maxHealth: 100, walkSpeed: 4.3, sprintSpeed: 6.9, reloadMultiplier: 0.78, damageMultiplier: 1.25 },
    clips: GUN_CLIPS,
  },
  JACK,
];

export const DEFAULT_CHARACTER_ID: CharacterId = 'lis';

export function findCharacter(id: string | null | undefined): CharacterSpec {
  return CHARACTERS.find((character) => character.id === id)
    ?? CHARACTERS.find((character) => character.id === DEFAULT_CHARACTER_ID)
    ?? CHARACTERS[0];
}

export interface CharacterRatings {
  /** 0-1, higher is faster on foot. */
  speed: number;
  /** 0-1, higher is more health. */
  toughness: number;
  /** 0-1, higher means faster reloads and more damage. */
  handling: number;
}

const RANGE = {
  // Sized against sprint speed, not walk speed: at the original 5.2 ceiling the
  // fastest survivor saturated the bar and tied with the runner-up.
  speed: [5.6, 8.6],
  toughness: [80, 155],
  reload: [0.75, 1.2],
  damage: [0.9, 1.3],
} as const;

function normalise(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Turns raw stats into the 0-1 bars the selection screen draws.
 *
 * Derived rather than stored, so a card can never advertise something the stats
 * do not actually say.
 */
export function characterRatings(spec: CharacterSpec): CharacterRatings {
  const reload = normalise(spec.stats.reloadMultiplier, RANGE.reload[0], RANGE.reload[1]);
  const damage = normalise(spec.stats.damageMultiplier, RANGE.damage[0], RANGE.damage[1]);
  return {
    speed: normalise(spec.stats.sprintSpeed, RANGE.speed[0], RANGE.speed[1]),
    toughness: normalise(spec.stats.maxHealth, RANGE.toughness[0], RANGE.toughness[1]),
    // Lower reload multiplier is better, so it is inverted.
    handling: Math.min(1, Math.max(0, damage * 0.5 + (1 - reload) * 0.5)),
  };
}
