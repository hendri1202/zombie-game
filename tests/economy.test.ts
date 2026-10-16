import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { POINTS, pointsForKill, pointsForWaveCleared } from '../src/economy/rewards';
import {
  PROFILE_STORAGE_KEY, PROFILE_VERSION, ProfileStore, STARTING_FIREARMS, STARTING_MELEE,
  applyPoints, canAfford, defaultProfile, ownsItem, parseProfile, purchaseItem, serializeProfile,
  type PlayerProfile, type StorageLike,
} from '../src/economy/ProfileStore';
import { STORE_ITEMS, findStoreItem, storeItemModelPath, type StoreItem } from '../src/economy/storeItems';
import { GRENADES, MELEE, WEAPONS, type MeleeId, type WeaponId, type ZombieKind } from '../src/app/gameConfig';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import { EventBus } from '../src/core/EventBus';
import type { PlayerController } from '../src/player/PlayerController';
import { WeaponController } from '../src/player/WeaponController';

/**
 * The point economy and the store.
 *
 * All of it is pure: the rules that decide what a kill pays and what a purchase costs live in
 * `src/economy/`, far from any DOM or WebGL, so the interesting cases (a corrupted save, an
 * old schema, buying twice, a one-point shortfall) are ordinary assertions here rather than
 * something a browser has to be driven to reproduce.
 *
 * The catalogue is checked against the real assets the same way `weapon-assets.test.ts` does:
 * a typo in a `modelPath` would otherwise be invisible until the preview rendered an empty
 * box. Files are read through Vite's raw glob so the test stays on `vite/client` types.
 */
const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** A store item by id, failing loudly rather than letting a renamed id test nothing. */
function item(id: string): StoreItem {
  const found = findStoreItem(id);
  if (!found) throw new Error(`store no longer sells "${id}"`);
  return found;
}

/** localStorage stand-in. `seed` plants a value as a previous version of the game would have. */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  seed(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('kill payouts', () => {
  it('pays each zombie kind a positive amount, ordered by how much trouble it is', () => {
    for (const kind of ['walker', 'runner', 'tank'] as ZombieKind[]) {
      expect(pointsForKill(kind), kind).toBe(POINTS.kill[kind]);
      expect(pointsForKill(kind), kind).toBeGreaterThan(0);
      expect(Number.isInteger(pointsForKill(kind)), kind).toBe(true);
    }
    // A runner is a bigger threat than a walker; a tank carries over four times the health.
    expect(POINTS.kill.runner).toBeGreaterThan(POINTS.kill.walker);
    expect(POINTS.kill.tank).toBeGreaterThan(POINTS.kill.runner);
  });

  it('pays a headshot kill its own value, never the body value plus a bonus', () => {
    for (const kind of ['walker', 'runner', 'tank'] as ZombieKind[]) {
      const headshot = pointsForKill(kind, true);
      expect(headshot, kind).toBe(POINTS.headshot[kind]);
      expect(headshot, kind).toBeGreaterThan(pointsForKill(kind));
      // The plan's rule, verbatim: "8, bukan 5+8". One kill, one payment.
      expect(headshot, kind).not.toBe(POINTS.kill[kind] + POINTS.headshot[kind]);
    }
  });

  it('pays no more than once for the same kill, however it is asked', () => {
    // A pure function of the inputs, so a replayed kill event cannot inflate the payout.
    expect(pointsForKill('walker')).toBe(pointsForKill('walker'));
    expect(pointsForKill('walker', true)).toBe(pointsForKill('walker', true));
    expect(pointsForKill('walker', false)).toBe(pointsForKill('walker'));
  });

  it('pays a wave bonus that grows with the wave and never goes fractional', () => {
    expect(pointsForWaveCleared(1)).toBe(POINTS.waveClearBase + POINTS.waveClearPerWave);
    expect(pointsForWaveCleared(5)).toBeGreaterThan(pointsForWaveCleared(1));
    expect(pointsForWaveCleared(7.8)).toBe(pointsForWaveCleared(7));
    // A nonsense wave number is treated as the first wave, not as a negative payout.
    for (const wave of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pointsForWaveCleared(wave), `wave ${wave}`).toBe(pointsForWaveCleared(1));
    }
    expect(Number.isInteger(pointsForWaveCleared(4))).toBe(true);
  });
});

describe('buying from the store', () => {
  it('refuses a purchase the balance cannot cover, leaving the profile untouched', () => {
    const profile = defaultProfile();
    const result = purchaseItem(profile, item('rifle'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('poor');
    expect(result.profile).toBe(profile);
    expect(result.profile.points).toBe(0);
    expect(ownsItem(result.profile, item('rifle'))).toBe(false);
  });

  it('takes the price exactly once and marks the item owned', () => {
    const rifle = item('rifle');
    const rich = applyPoints(defaultProfile(), 1000);
    const result = purchaseItem(rich, rifle);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.profile.points).toBe(1000 - rifle.price);
    expect(ownsItem(result.profile, rifle)).toBe(true);
    // Pure: the profile handed in is not mutated, so a failed caller cannot half-spend.
    expect(rich.points).toBe(1000);
    expect(ownsItem(rich, rifle)).toBe(false);
  });

  it('cannot buy the same item twice', () => {
    const smg = item('smg');
    const once = purchaseItem(applyPoints(defaultProfile(), 1000), smg);
    expect(once.ok).toBe(true);

    const twice = purchaseItem(once.profile, smg);
    expect(twice.ok).toBe(false);
    expect(twice.reason).toBe('owned');
    expect(twice.profile.points).toBe(once.profile.points);
  });

  it('never leaves a negative balance', () => {
    const bat = item('barbed-bat');
    const exactly = purchaseItem(applyPoints(defaultProfile(), bat.price), bat);
    expect(exactly.ok).toBe(true);
    expect(exactly.profile.points).toBe(0);

    // One point short is refused rather than overdrawn.
    const short = purchaseItem(applyPoints(defaultProfile(), bat.price - 1), bat);
    expect(short.ok).toBe(false);
    expect(short.profile.points).toBe(bat.price - 1);
  });

  it('keeps the lifetime total intact through spending, and canAfford agrees', () => {
    const profile = applyPoints(defaultProfile(), 300);
    expect(profile.earnedTotal).toBe(300);
    expect(canAfford(profile, item('spear'))).toBe(true);

    const bought = purchaseItem(profile, item('spear'));
    expect(bought.ok).toBe(true);
    expect(bought.profile.points).toBe(0);
    // Spending is not "un-earning".
    expect(bought.profile.earnedTotal).toBe(300);
    expect(canAfford(bought.profile, item('barbed-bat'))).toBe(false);
    // An owned item is never purchasable again, whatever the balance.
    expect(canAfford(applyPoints(bought.profile, 5000), item('spear'))).toBe(false);
  });

  it('clamps a negative award to zero without shrinking the lifetime total', () => {
    expect(applyPoints(defaultProfile(), -999).points).toBe(0);

    const rich = applyPoints(defaultProfile(), 100);
    expect(applyPoints(rich, -30).points).toBe(70);
    expect(applyPoints(rich, -30).earnedTotal).toBe(100);
    // A non-number is ignored rather than poisoning the balance with NaN.
    expect(applyPoints(rich, Number.NaN).points).toBe(100);
  });
});

describe('profile persistence', () => {
  it('starts from the sidearm and the knife with nothing spent', () => {
    const profile = defaultProfile();
    expect(profile.version).toBe(PROFILE_VERSION);
    expect(profile.points).toBe(0);
    expect(profile.earnedTotal).toBe(0);
    expect(profile.ownedFirearms).toEqual(['pistol']);
    expect(profile.ownedMelee).toEqual(['knife']);
  });

  it('round-trips a profile through save and load', () => {
    const saved: PlayerProfile = {
      ...defaultProfile(),
      points: 1200,
      earnedTotal: 1500,
      ownedFirearms: ['pistol', 'rifle'],
      ownedMelee: ['knife', 'axe'],
      stats: { runs: 3, kills: 42, bestWave: 7 },
    };
    const restored = parseProfile(serializeProfile(saved));
    expect(restored).toEqual(saved);
    // Stable: re-saving what was loaded writes the same bytes.
    expect(serializeProfile(restored)).toBe(serializeProfile(saved));
  });

  it('falls back to defaults for missing or unparseable data', () => {
    expect(parseProfile(null)).toEqual(defaultProfile());
    expect(parseProfile(undefined)).toEqual(defaultProfile());
    expect(parseProfile('')).toEqual(defaultProfile());
    expect(parseProfile('not json at all')).toEqual(defaultProfile());
    expect(parseProfile('[1,2,3]')).toEqual(defaultProfile());
    expect(parseProfile('"a string"')).toEqual(defaultProfile());
    expect(parseProfile('null')).toEqual(defaultProfile());
  });

  it('ignores a save written by an unknown schema version', () => {
    // An old file whose fields meant something else must not be reinterpreted as points.
    const oldShape = JSON.stringify({ version: 0, points: 999999, owned: ['railgun'] });
    expect(parseProfile(oldShape)).toEqual(defaultProfile());
    // A file with no version at all is the same case.
    expect(parseProfile(JSON.stringify({ points: 500 }))).toEqual(defaultProfile());
  });

  it('sanitises corrupted fields instead of trusting them', () => {
    const broken = JSON.stringify({
      version: PROFILE_VERSION,
      points: -50,
      earnedTotal: 'lots',
      ownedFirearms: ['pistol', 'railgun', 'rifle', 'rifle', 7],
      ownedMelee: 'axe',
      stats: { runs: -2, kills: 12.9, bestWave: Number.NaN },
    });
    const profile = parseProfile(broken);

    expect(profile.points).toBe(0);
    expect(profile.earnedTotal).toBe(0);
    // Unknown ids and duplicates are dropped; the starting weapon survives.
    expect(profile.ownedFirearms).toEqual(['pistol', 'rifle']);
    expect(profile.ownedMelee).toEqual(['knife']);
    expect(profile.stats).toEqual({ runs: 0, kills: 12, bestWave: 0 });
  });

  it('never reports less earned than the balance on hand', () => {
    const profile = parseProfile(JSON.stringify({ version: PROFILE_VERSION, points: 500, earnedTotal: 0 }));
    expect(profile.points).toBe(500);
    expect(profile.earnedTotal).toBe(500);
  });

  it('always grants the starting loadout even when the save omits it', () => {
    const profile = parseProfile(JSON.stringify({
      version: PROFILE_VERSION, points: 0, earnedTotal: 0, ownedFirearms: [], ownedMelee: [],
    }));
    for (const id of STARTING_FIREARMS) expect(profile.ownedFirearms, id).toContain(id);
    for (const id of STARTING_MELEE) expect(profile.ownedMelee, id).toContain(id);
    expect(ownsItem(profile, item('rifle'))).toBe(false);
  });

  it('persists a balance across a reload through storage', () => {
    const storage = new FakeStorage();
    const store = new ProfileStore(storage);
    expect(store.current.points).toBe(0);

    store.award(300);
    expect(store.current.points).toBe(300);
    expect(storage.getItem(PROFILE_STORAGE_KEY)).toBe(serializeProfile(store.current));

    // A fresh instance is what a page reload does.
    const reloaded = new ProfileStore(storage);
    expect(reloaded.current.points).toBe(300);
  });

  it('works without storage at all (in-memory session)', () => {
    const store = new ProfileStore(null);
    expect(store.buy(item('barbed-bat')).ok).toBe(false);

    store.award(400);
    expect(store.buy(item('barbed-bat')).ok).toBe(true);
    expect(store.current.points).toBe(150);
  });

  it('ignores a corrupted stored entry rather than throwing', () => {
    const storage = new FakeStorage();
    storage.seed(PROFILE_STORAGE_KEY, '{ truncated');
    expect(new ProfileStore(storage).current).toEqual(defaultProfile());
  });

  it('records run statistics and persists them', () => {
    const storage = new FakeStorage();
    const store = new ProfileStore(storage);
    store.recordRun(12, 4);
    store.recordRun(5, 2);
    expect(store.current.stats).toEqual({ runs: 2, kills: 17, bestWave: 4 });
    expect(new ProfileStore(storage).current.stats).toEqual({ runs: 2, kills: 17, bestWave: 4 });
  });
});

describe('store catalogue integrity', () => {
  it('sells only weapons the game actually has, with the configs own names', () => {
    for (const entry of STORE_ITEMS) {
      if (entry.category === 'firearm') {
        expect(WEAPONS[entry.id], entry.id).toBeTruthy();
        expect(WEAPONS[entry.id].id, entry.id).toBe(entry.id);
        expect(entry.name, entry.id).toBe(WEAPONS[entry.id].name);
      } else if (entry.category === 'melee') {
        expect(MELEE[entry.id], entry.id).toBeTruthy();
        expect(MELEE[entry.id].id, entry.id).toBe(entry.id);
        expect(entry.name, entry.id).toBe(MELEE[entry.id].name);
      } else {
        // Ordnance (the grenade): a third table since §14.1, with a quantity per purchase
        // because a grenade has no "owned" state to buy.
        expect(GRENADES[entry.id], entry.id).toBeTruthy();
        expect(GRENADES[entry.id].id, entry.id).toBe(entry.id);
        expect(entry.name, entry.id).toBe(GRENADES[entry.id].name);
        expect(entry.quantity, entry.id).toBeGreaterThan(0);
      }
      expect(Number.isInteger(entry.price), entry.id).toBe(true);
      expect(entry.price, entry.id).toBeGreaterThan(0);
      expect(entry.blurb.length, entry.id).toBeGreaterThan(0);
    }
    expect(STORE_ITEMS.some((entry) => entry.category === 'firearm')).toBe(true);
    expect(STORE_ITEMS.some((entry) => entry.category === 'melee')).toBe(true);
    expect(STORE_ITEMS.some((entry) => entry.category === 'ordnance')).toBe(true);
  });

  it('ships a real glTF for every item it sells', () => {
    for (const entry of STORE_ITEMS) {
      const modelPath = storeItemModelPath(entry);
      expect(modelPath, entry.id).toMatch(/^\/assets\/weapons\/[A-Za-z0-9_-]+\.gltf$/);

      const name = modelPath.split('/').pop() ?? '';
      const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
      expect(key, `${entry.id} -> ${modelPath} is missing`).toBeTruthy();
      if (!key) continue;

      const gltf = JSON.parse(WEAPON_FILES[key]) as {
        asset?: { version?: string };
        meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
      };
      expect(gltf.asset?.version, entry.id).toBe('2.0');
      expect(gltf.meshes?.length ?? 0, entry.id).toBeGreaterThan(0);
      expect(gltf.meshes?.[0]?.primitives?.[0]?.attributes?.POSITION, entry.id).toBeTypeOf('number');
    }
  });

  it('lists each weapon once and leaves the starting loadout off the shelf', () => {
    const ids = STORE_ITEMS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of STARTING_FIREARMS) expect(ids, id).not.toContain(id);
    for (const id of STARTING_MELEE) expect(ids, id).not.toContain(id);
  });

  it('leaves no weapon unreachable: every id is either starting gear or for sale', () => {
    const sellable = new Set<string>(STORE_ITEMS.map((entry) => entry.id));
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      expect(sellable.has(id) || STARTING_FIREARMS.includes(id), `${id} is neither sellable nor starting gear`).toBe(true);
    }
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      expect(sellable.has(id) || STARTING_MELEE.includes(id), `${id} is neither sellable nor starting gear`).toBe(true);
    }
  });

  it('resolves ids to items and unknown ids to nothing', () => {
    expect(findStoreItem('rifle')?.id).toBe('rifle');
    expect(findStoreItem('axe')?.category).toBe('melee');
    expect(findStoreItem('railgun')).toBeNull();
    expect(findStoreItem('')).toBeNull();
  });
});

/**
 * The hand-off the store depends on: what a bought profile turns into in the weapon
 * controller. The purchase itself is covered above; this is the arming step, which is the
 * part that decides whether "bought" actually means "usable".
 */
describe('handing a bought loadout to the weapon controller', () => {
  function controller(): { weapons: WeaponController; announcements: () => number } {
    const events = new EventBus<GameEvents>();
    const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
    // Only the camera and the bus are touched at construction; the systems behind these
    // casts are reached when something fires, which this test never does.
    const weapons = new WeaponController({
      camera,
      events,
      damage: {} as unknown as DamageSystem,
      player: {} as unknown as PlayerController,
      melee: {} as unknown as MeleeSystem,
    });
    let announcements = 0;
    events.on('weapon:unlocked', () => { announcements += 1; });
    return { weapons, announcements: () => announcements };
  }

  it('re-grants an owned firearm quietly, without drawing it or announcing it', () => {
    const { weapons, announcements } = controller();
    const bought = purchaseItem(applyPoints(defaultProfile(), 1000), item('rifle'));
    expect(bought.ok).toBe(true);

    for (const id of bought.profile.ownedFirearms) {
      if (id === 'pistol') continue;
      expect(weapons.grantWeapon(id)).toBe(true);
      // Idempotent: re-applying a loadout must not duplicate a slot.
      expect(weapons.grantWeapon(id)).toBe(false);
    }

    expect(weapons.ownedWeapons).toEqual(['pistol', 'rifle']);
    // The run still starts with the sidearm in hand.
    expect(weapons.snapshot.weaponId).toBe('pistol');
    // And nothing claims it is a new weapon: it was bought several runs ago.
    expect(announcements()).toBe(0);
  });

  it('sets the carried melee weapon without drawing it', () => {
    const { weapons } = controller();
    weapons.setCarriedMelee('axe');

    expect(weapons.activeMelee.id).toBe('axe');
    expect(weapons.isMeleeDrawn).toBe(false);
    expect(weapons.meleeReport.equipped).toBeNull();
  });
});
