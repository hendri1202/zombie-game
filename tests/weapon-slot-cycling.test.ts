import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { WEAPONS, type WeaponId } from '../src/app/gameConfig';
import { WeaponController } from '../src/player/WeaponController';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import type { PlayerController } from '../src/player/PlayerController';

/**
 * The slot number key, with more than one weapon per slot.
 *
 * Slot 2 holds six firearms, and the old rule — "the first owned weapon of that slot" — made
 * every one past the first unreachable from the keyboard: buy a gun, switch away, come back,
 * and the old one was in hand, which reads as the purchase having failed. These tests pin the
 * rotation that replaces it, the fact that a purchase still lands in hand at once, and that
 * the one-weapon-per-slot case is unchanged.
 */
function bareController(): WeaponController {
  const events = new EventBus<GameEvents>();
  const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
  return new WeaponController({
    camera,
    events,
    damage: {} as unknown as DamageSystem,
    player: {} as unknown as PlayerController,
    melee: {} as unknown as MeleeSystem,
  });
}

describe('slot key cycling', () => {
  it('rotates through two slot-2 weapons and wraps back to the first', () => {
    const weapons = bareController();
    weapons.grantWeapon('rifle');
    weapons.grantWeapon('smg');

    expect(weapons.snapshot.weaponId).toBe('pistol');
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('rifle');
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('smg');
    // Wrapping: the second press after the last weapon returns to the first.
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('rifle');
  });

  it('rotates through three slot-2 weapons in acquisition order and wraps', () => {
    const weapons = bareController();
    for (const id of ['rifle', 'smg', 'shotgun'] as WeaponId[]) weapons.grantWeapon(id);

    const seen: WeaponId[] = [];
    for (let press = 0; press < 4; press += 1) {
      weapons.switchSlot(2);
      seen.push(weapons.snapshot.weaponId);
    }
    // The rotation walks `order`, which is the order the weapons were acquired.
    expect(seen).toEqual(['rifle', 'smg', 'shotgun', 'rifle']);
  });

  it('never selects a slot-2 weapon the player does not own', () => {
    const weapons = bareController();
    // Nothing in slot 2 yet: the key does nothing rather than reaching for the rifle.
    expect(weapons.switchSlot(2)).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');

    weapons.grantWeapon('p90');
    for (let press = 0; press < 5; press += 1) {
      weapons.switchSlot(2);
      expect(weapons.snapshot.weaponId).toBe('p90');
    }
    expect(weapons.ownedWeapons).toEqual(['pistol', 'p90']);

    // A second owned slot-2 weapon joins the rotation; the unowned four still never appear.
    weapons.grantWeapon('lmg');
    const seen = new Set<WeaponId>();
    for (let press = 0; press < 6; press += 1) {
      weapons.switchSlot(2);
      seen.add(weapons.snapshot.weaponId);
    }
    expect([...seen].sort()).toEqual(['lmg', 'p90']);
  });

  it('draws a bought weapon at once, then rotates from it', () => {
    const weapons = bareController();
    weapons.grantWeapon('rifle');
    weapons.switchTo('rifle');

    // `unlock` is the purchase hand-off and switches directly, so the new gun is in hand
    // the instant it is bought — the rotation must not have taken that over.
    expect(weapons.unlock('smg')).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('smg');

    // Pressing 2 from there rotates to the next owned slot-2 weapon, not back to a stale one.
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('rifle');

    // The whole ladder stays reachable, which is what the old first-match rule broke.
    weapons.unlock('mp5');
    expect(weapons.snapshot.weaponId).toBe('mp5');
    const seen = new Set<WeaponId>([weapons.snapshot.weaponId]);
    for (let press = 0; press < 3; press += 1) {
      weapons.switchSlot(2);
      seen.add(weapons.snapshot.weaponId);
    }
    expect([...seen].sort()).toEqual(['mp5', 'rifle', 'smg']);
  });

  it('holsters a drawn melee weapon instead of skipping past the current gun', () => {
    const weapons = bareController();
    weapons.grantWeapon('rifle');
    weapons.grantWeapon('smg');
    weapons.switchTo('rifle');
    expect(weapons.equipMelee()).toBe(true);
    expect(weapons.isMeleeDrawn).toBe(true);

    // The firearm underneath is still rifle; 2 puts it back rather than advancing to the smg.
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.isMeleeDrawn).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('rifle');

    // With the melee out over a slot-1 gun, 2 draws the first owned slot-2 weapon instead:
    // there is nothing for that slot to put back into the hand.
    weapons.switchSlot(1);
    weapons.equipMelee();
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.isMeleeDrawn).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('rifle');
  });

  it('leaves the single-weapon slot behaving exactly as before', () => {
    const weapons = bareController();
    // Slot 1 owns the sidearm alone: pressing 1 while it is already in hand does nothing.
    expect(weapons.switchSlot(1)).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');
    // And a slot number the game does not have is refused rather than guessed at.
    expect(weapons.switchSlot(3)).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');
  });

  it('covers every slot-2 firearm in the roster from the keyboard', () => {
    // Six weapons in slot 2, and the reason this change exists: every one of them has to be
    // reachable by pressing 2. The lane the work order calls out, checked end to end.
    const slot2 = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => WEAPONS[id].slot === 2);
    expect(slot2.length).toBeGreaterThan(1);

    const weapons = bareController();
    for (const id of slot2) weapons.grantWeapon(id);
    const seen = new Set<WeaponId>();
    for (let press = 0; press < slot2.length; press += 1) {
      expect(weapons.switchSlot(2), `press ${press}`).toBe(true);
      seen.add(weapons.snapshot.weaponId);
    }
    expect([...seen].sort()).toEqual([...slot2].sort());
  });
});
