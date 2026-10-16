import type { MeleeClip, MeleeId, WeaponId, ZombieKind } from './gameConfig';

export type Vec3Tuple = [number, number, number];

export type HitZone = 'head' | 'body';

/**
 * Every cross-subsystem message. Keeping them in one interface is what lets the
 * HUD, audio and stats listen without importing the systems that emit them.
 */
export interface GameEvents {
  'weapon:fired': { weaponId: WeaponId; origin: Vec3Tuple; direction: Vec3Tuple; ammo: number };
  'weapon:empty': { weaponId: WeaponId };
  'weapon:reload-started': { weaponId: WeaponId; seconds: number };
  'weapon:reload-finished': { weaponId: WeaponId; magazine: number };
  'weapon:switched': { weaponId: WeaponId };
  'weapon:unlocked': { weaponId: WeaponId };
  'combat:hit': { zone: HitZone; killed: boolean; kind: ZombieKind; point: Vec3Tuple };
  /** One melee swing started. The hit itself arrives later, as 'combat:hit'. */
  'melee:swung': { meleeId: MeleeId; clip: MeleeClip; swingSeconds: number };
  /**
   * A swing in flight ended on nothing. Its own event, separate from 'melee:swung', so the
   * swing sound and the whiff are two cues and a miss never sounds like a hit.
   */
  'melee:missed': { meleeId: MeleeId };
  /** A melee weapon was drawn and is now the thing clicking will swing. */
  'melee:equipped': { meleeId: MeleeId };
  /** A grenade left the hand. `count` is what is left in the pouch, for the HUD. */
  'grenade:thrown': { count: number };
  /** A thrown grenade detonated. Emitted after the blast, so `damage` and `killed` are final. */
  'grenade:exploded': { point: Vec3Tuple; radius: number; damage: number; killed: number };
  'combat:world-hit': { tag: string; point: Vec3Tuple };
  'combat:miss': Record<string, never>;
  'zombie:killed': { kind: ZombieKind; kills: number };
  'zombie:spawned': { kind: ZombieKind; active: number };
  'zombie:despawned': { active: number };
  'zombie:attacked': { kind: ZombieKind };
  /** Points just added to the balance. `total` is the new balance, not the run's earnings. */
  'points:awarded': { amount: number; total: number; reason: 'kill' | 'headshot' | 'wave' };
  'store:purchased': { itemId: string; price: number; points: number };
  'player:damaged': { amount: number; health: number; maxHealth: number };
  'player:healed': { amount: number; health: number };
  'player:died': { cause: string; kills: number; wave: number; survivedSeconds: number };
  'wave:started': { wave: number; total: number; composition: { walker: number; runner: number; tank: number } };
  'wave:cleared': { wave: number };
  'wave:remaining': { remaining: number; total: number };
  'wave:stragglers-recalled': { wave: number; moved: number };
  'pickup:collected': { type: 'medkit' | 'ammo' | 'weapon' | 'grenade'; label: string };
  'pickup:spawned': { type: 'medkit' | 'ammo' | 'weapon' | 'grenade' };
  'game:started': Record<string, never>;
  'game:restarted': Record<string, never>;
  'game:paused': Record<string, never>;
  'game:resumed': Record<string, never>;
  'toast': { text: string; tone?: 'info' | 'warn' | 'danger' };
}
