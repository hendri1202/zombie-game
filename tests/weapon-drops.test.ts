import { describe, expect, it } from 'vitest';
import { weaponDropFor } from '../src/systems/PickupManager';
import {
  RIFLE_UNLOCK_WAVE, SHOTGUN_UNLOCK_WAVE, SMG_UNLOCK_WAVE, WEAPONS, type WeaponId,
} from '../src/app/gameConfig';

/**
 * The weapon drop ladder.
 *
 * This exists because of a real failure: the drops were ordered newest-first and the smoke
 * test caught a shotgun being handed over on wave one, while the check — and the design —
 * expect the rifle. Ordering is the whole content of this function, so it is pinned here.
 */
describe('weapon drops', () => {
  it('hands over the rifle first, whatever the wave', () => {
    for (const wave of [RIFLE_UNLOCK_WAVE, SMG_UNLOCK_WAVE, SHOTGUN_UNLOCK_WAVE, 40]) {
      expect(weaponDropFor(wave, []), `wave ${wave}`).toBe('rifle');
    }
  });

  it('works up the ladder as each weapon is claimed', () => {
    const deep = SHOTGUN_UNLOCK_WAVE + 5;
    expect(weaponDropFor(deep, ['rifle'])).toBe('smg');
    expect(weaponDropFor(deep, ['rifle', 'smg'])).toBe('shotgun');
    expect(weaponDropFor(deep, ['rifle', 'smg', 'shotgun'])).toBeNull();
  });

  it('offers nothing before the weapon unlocks', () => {
    expect(weaponDropFor(RIFLE_UNLOCK_WAVE - 1, [])).toBeNull();
    expect(weaponDropFor(SMG_UNLOCK_WAVE - 1, ['rifle'])).toBeNull();
    expect(weaponDropFor(SHOTGUN_UNLOCK_WAVE - 1, ['rifle', 'smg'])).toBeNull();
  });

  it('holds the ladder in step with the config', () => {
    // The order in the function has to match the order in the configuration, or a weapon
    // becomes unreachable or arrives early.
    expect(RIFLE_UNLOCK_WAVE).toBeLessThan(SMG_UNLOCK_WAVE);
    expect(SMG_UNLOCK_WAVE).toBeLessThan(SHOTGUN_UNLOCK_WAVE);
    for (const id of ['rifle', 'smg', 'shotgun'] as WeaponId[]) {
      expect(WEAPONS[id], id).toBeTruthy();
    }
  });

  it('never grants a weapon the player already owns', () => {
    const owned: WeaponId[] = [];
    const granted: WeaponId[] = [];
    for (let step = 0; step < 6; step += 1) {
      const weapon = weaponDropFor(99, owned);
      if (!weapon) break;
      expect(owned).not.toContain(weapon);
      owned.push(weapon);
      granted.push(weapon);
    }
    // The player gets each weapon once, in unlock order, and then nothing more.
    expect(granted).toEqual(['rifle', 'smg', 'shotgun']);
    expect(weaponDropFor(99, owned)).toBeNull();
  });
});
