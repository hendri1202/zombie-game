/**
 * The player profile: points, what has been bought, and a few lifetime counters.
 *
 * There is no backend, so progress lives in `localStorage` under a versioned key and is per
 * browser. Two layers:
 *
 * - `parseProfile` / `serializeProfile` / `defaultProfile` / `applyPoints` / `purchaseItem`
 *   are pure. Every rule about what a save file may contain and what a purchase may do is
 *   testable without a browser, which is where the interesting edge cases are (truncated
 *   JSON, an old schema, negative points, buying the same thing twice).
 * - `ProfileStore` is the thin side-effecting shell: read once, write on change. It takes a
 *   `StorageLike` so a test (or a private-window browser that throws on access) can pass
 *   something else, including nothing at all.
 *
 * A save whose `version` is not the current one is ignored rather than half-read: a v0 file
 * whose `points` field meant something else must not be silently reinterpreted as points. The
 * player simply starts from defaults; nothing is deleted.
 */
import { MELEE, WEAPONS, type MeleeId, type WeaponId } from '../app/gameConfig';
import type { StoreItem } from './storeItems';

export const PROFILE_STORAGE_KEY = 'dead-district:profile:v1';
export const PROFILE_VERSION = 1;

/** Weapons the player has from the first wave, whatever the save says. */
export const STARTING_FIREARMS: readonly WeaponId[] = ['pistol'];
export const STARTING_MELEE: readonly MeleeId[] = ['knife'];

export interface ProfileStats {
  /** Runs started. */
  runs: number;
  /** Zombies killed, all runs. */
  kills: number;
  /** Best wave reached, all runs. */
  bestWave: number;
}

export interface PlayerProfile {
  version: number;
  /** Spendable balance. Earned during runs, spent in the store, carried between runs. */
  points: number;
  /**
   * Lifetime points earned. Never reduced by spending, so the store report can tell "rich
   * but broke" from "nothing earned yet".
   */
  earnedTotal: number;
  ownedFirearms: WeaponId[];
  ownedMelee: MeleeId[];
  stats: ProfileStats;
}

export function defaultProfile(): PlayerProfile {
  return {
    version: PROFILE_VERSION,
    points: 0,
    earnedTotal: 0,
    ownedFirearms: [...STARTING_FIREARMS],
    ownedMelee: [...STARTING_MELEE],
    stats: { runs: 0, kills: 0, bestWave: 0 },
  };
}

/** A finite, non-negative integer, or 0. */
function sanitiseCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Filters a stored id list down to ids the weapon tables actually define. */
function sanitiseIds<T extends string>(value: unknown, allowed: ReadonlySet<string>): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry as T);
  }
  return result;
}

/** Order-stable union, keeping `base` first so the starting loadout stays at the front. */
function mergeIds<T extends string>(base: readonly T[], extra: readonly T[]): T[] {
  const result = [...base];
  for (const id of extra) if (!result.includes(id)) result.push(id);
  return result;
}

/**
 * Reads a stored save. Never throws and never returns anything but a usable profile: any
 * missing, malformed, or wrong-version input yields the defaults.
 */
export function parseProfile(raw: string | null | undefined): PlayerProfile {
  const fallback = defaultProfile();
  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;

  const record = parsed as Record<string, unknown>;
  // An unrecognised version is ignored, not partially trusted.
  if (record.version !== PROFILE_VERSION) return fallback;

  const points = sanitiseCount(record.points);
  const stats = record.stats && typeof record.stats === 'object' && !Array.isArray(record.stats)
    ? (record.stats as Record<string, unknown>)
    : {};

  return {
    version: PROFILE_VERSION,
    points,
    // Spending must never shrink the lifetime figure, so it can only be raised to `points`.
    earnedTotal: Math.max(points, sanitiseCount(record.earnedTotal)),
    ownedFirearms: mergeIds(
      STARTING_FIREARMS,
      sanitiseIds<WeaponId>(record.ownedFirearms, new Set(Object.keys(WEAPONS))),
    ),
    ownedMelee: mergeIds(
      STARTING_MELEE,
      sanitiseIds<MeleeId>(record.ownedMelee, new Set(Object.keys(MELEE))),
    ),
    stats: {
      runs: sanitiseCount(stats.runs),
      kills: sanitiseCount(stats.kills),
      bestWave: sanitiseCount(stats.bestWave),
    },
  };
}

/** Stable serialisation: fixed key order, so a save diff is readable. */
export function serializeProfile(profile: PlayerProfile): string {
  return JSON.stringify({
    version: PROFILE_VERSION,
    points: profile.points,
    earnedTotal: profile.earnedTotal,
    ownedFirearms: profile.ownedFirearms,
    ownedMelee: profile.ownedMelee,
    stats: profile.stats,
  });
}

/** Awards (or, with a negative delta, removes) points. The balance never goes below zero. */
export function applyPoints(profile: PlayerProfile, delta: number): PlayerProfile {
  if (!Number.isFinite(delta) || delta === 0) return profile;
  const earned = Math.max(0, Math.floor(delta));
  return {
    ...profile,
    points: Math.max(0, profile.points + Math.floor(delta)),
    earnedTotal: profile.earnedTotal + earned,
  };
}

export function ownsItem(profile: PlayerProfile, item: StoreItem): boolean {
  return item.category === 'firearm'
    ? profile.ownedFirearms.includes(item.id)
    : profile.ownedMelee.includes(item.id);
}

/** True when the item is not already owned and the balance covers its price. */
export function canAfford(profile: PlayerProfile, item: StoreItem): boolean {
  return !ownsItem(profile, item) && profile.points >= item.price;
}

export type PurchaseReason = 'ok' | 'owned' | 'poor';

export interface PurchaseOutcome {
  ok: boolean;
  reason: PurchaseReason;
  price: number;
  /** The new profile on success, the original on failure. */
  profile: PlayerProfile;
}

/**
 * Buys one item: pure, so a purchase can be checked without a store on screen.
 *
 * Refusals are explicit and never partial: an item already owned or one the balance cannot
 * cover leaves the profile untouched, so the points can never go negative and the same item
 * can never be charged for twice.
 */
export function purchaseItem(profile: PlayerProfile, item: StoreItem): PurchaseOutcome {
  if (ownsItem(profile, item)) return { ok: false, reason: 'owned', price: item.price, profile };
  if (profile.points < item.price) return { ok: false, reason: 'poor', price: item.price, profile };

  const next: PlayerProfile = {
    ...profile,
    points: profile.points - item.price,
    ownedFirearms: item.category === 'firearm'
      ? mergeIds(profile.ownedFirearms, [item.id])
      : [...profile.ownedFirearms],
    ownedMelee: item.category === 'melee'
      ? mergeIds(profile.ownedMelee, [item.id])
      : [...profile.ownedMelee],
  };
  return { ok: true, reason: 'ok', price: item.price, profile: next };
}

/** The subset of the Storage API this module needs, so tests need no DOM. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `window.localStorage`, or null when there is none (node, or a browser that throws on
 * access in a private window). Null storage means an in-memory session, not a crash.
 */
export function resolveStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads and writes the profile. One read at construction, one write per change: the store
 * asks it for the current values, mutating through `applyPoints`/`purchaseItem` so no caller
 * has to remember to save.
 */
export class ProfileStore {
  private readonly storage: StorageLike | null;
  private profile: PlayerProfile = defaultProfile();

  constructor(storage: StorageLike | null = resolveStorage()) {
    this.storage = storage;
    this.profile = this.read();
  }

  get current(): PlayerProfile {
    return this.profile;
  }

  /** Re-reads from storage. Returns the profile now in effect. */
  load(): PlayerProfile {
    this.profile = this.read();
    return this.profile;
  }

  save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(PROFILE_STORAGE_KEY, serializeProfile(this.profile));
    } catch (error) {
      // A full or blocked storage must not take the run down with it.
      console.warn('[profile] could not persist progress', error);
    }
  }

  setProfile(profile: PlayerProfile): void {
    this.profile = profile;
  }

  /** Adds points and persists. Returns the new balance. */
  award(delta: number): number {
    this.profile = applyPoints(this.profile, delta);
    this.save();
    return this.profile.points;
  }

  /** Buys an item and persists on success. Returns the raw outcome for the caller's toast. */
  buy(item: StoreItem): PurchaseOutcome {
    const outcome = purchaseItem(this.profile, item);
    if (outcome.ok) {
      this.profile = outcome.profile;
      this.save();
    }
    return outcome;
  }

  /** Records the end of a run. */
  recordRun(kills: number, wave: number): void {
    this.profile = {
      ...this.profile,
      stats: {
        runs: this.profile.stats.runs + 1,
        kills: this.profile.stats.kills + Math.max(0, Math.floor(kills)),
        bestWave: Math.max(this.profile.stats.bestWave, Math.max(0, Math.floor(wave))),
      },
    };
    this.save();
  }

  private read(): PlayerProfile {
    if (!this.storage) return defaultProfile();
    try {
      return parseProfile(this.storage.getItem(PROFILE_STORAGE_KEY));
    } catch (error) {
      console.warn('[profile] could not read stored progress, using defaults', error);
      return defaultProfile();
    }
  }
}
