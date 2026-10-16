import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { MELEE, WEAPONS, type MeleeId, type WeaponId } from '../src/app/gameConfig';
import { WeaponController } from '../src/player/WeaponController';
import { GrenadeSystem } from '../src/combat/GrenadeSystem';
import { EventBus } from '../src/core/EventBus';
import { CollisionWorld } from '../src/level/CollisionWorld';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import type { PlayerController } from '../src/player/PlayerController';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';

/**
 * The slot number keys, one per category.
 *
 * §14.1 turned the two firearm slots into four categories (1 primary, 2 sidearm, 3 melee,
 * 4 ordnance) and kept the rotation rule that already existed for the crowded slot: pressing a
 * category's key again walks the weapons owned *in that category* and wraps. Before this, a
 * first-match rule made every weapon past the first in a slot unreachable from the keyboard —
 * buy a gun, switch away, come back, and the old one was in hand, which reads as the purchase
 * having failed. These tests pin the rotation for all four categories, the fact that a purchase
 * still lands in hand at once, and that a category the player owns nothing in does nothing.
 */
function harness(): { weapons: WeaponController; grenades: GrenadeSystem } {
  const events = new EventBus<GameEvents>();
  const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
  const collision = new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
  const director = { list: [], hitboxTargets: () => [] } as unknown as ZombieDirector;
  // A real grenade system, with no scene: slot 4 needs something to select, and the ordnance
  // tests proper live in slots-and-grenades.test.ts.
  const grenades = new GrenadeSystem({ scene: null, director, collision, events });
  const weapons = new WeaponController({
    camera,
    events,
    damage: {} as unknown as DamageSystem,
    player: {} as unknown as PlayerController,
    melee: {} as unknown as MeleeSystem,
    grenades,
  });
  return { weapons, grenades };
}

/** Just the controller, for the categories that do not need the pouch. */
function bareController(): WeaponController {
  return harness().weapons;
}

describe('slot key cycling across categories', () => {
  it('rotates through two slot-1 primaries and wraps back to the first', () => {
    const weapons = bareController();
    weapons.grantWeapon('rifle');
    weapons.grantWeapon('smg');

    // The run starts with the sidearm in hand; the first press of 1 picks the first primary.
    expect(weapons.snapshot.weaponId).toBe('pistol');
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('rifle');
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('smg');
    // Wrapping: the second press after the last weapon returns to the first.
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('rifle');
  });

  it('rotates through three primaries in acquisition order and wraps', () => {
    const weapons = bareController();
    for (const id of ['rifle', 'smg', 'shotgun'] as WeaponId[]) weapons.grantWeapon(id);

    const seen: WeaponId[] = [];
    for (let press = 0; press < 4; press += 1) {
      weapons.switchSlot(1);
      seen.push(weapons.snapshot.weaponId);
    }
    // The rotation walks `order`, which is the order the weapons were acquired.
    expect(seen).toEqual(['rifle', 'smg', 'shotgun', 'rifle']);
  });

  it('never selects a primary the player does not own', () => {
    const weapons = bareController();
    // Nothing in slot 1 yet: the key does nothing rather than reaching for the rifle.
    expect(weapons.switchSlot(1)).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');

    weapons.grantWeapon('p90');
    for (let press = 0; press < 5; press += 1) {
      weapons.switchSlot(1);
      expect(weapons.snapshot.weaponId).toBe('p90');
    }
    expect(weapons.ownedWeapons).toEqual(['pistol', 'p90']);

    // A second owned primary joins the rotation; the unowned four still never appear.
    weapons.grantWeapon('lmg');
    const seen = new Set<WeaponId>();
    for (let press = 0; press < 6; press += 1) {
      weapons.switchSlot(1);
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

    // Pressing 1 from there rotates to the next owned primary, not back to a stale one.
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('rifle');

    // The whole ladder stays reachable, which is what the old first-match rule broke.
    weapons.unlock('mp5');
    expect(weapons.snapshot.weaponId).toBe('mp5');
    const seen = new Set<WeaponId>([weapons.snapshot.weaponId]);
    for (let press = 0; press < 3; press += 1) {
      weapons.switchSlot(1);
      seen.add(weapons.snapshot.weaponId);
    }
    expect([...seen].sort()).toEqual(['mp5', 'rifle', 'smg']);
  });

  it('leaves the single-weapon sidearm category behaving exactly as before', () => {
    const weapons = bareController();
    // Slot 2 owns the sidearm alone: pressing 2 while it is already in hand does nothing.
    expect(weapons.switchSlot(2)).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');
    // And a number the game has no category for is refused rather than guessed at.
    expect(weapons.switchSlot(5)).toBe(false);
    expect(weapons.switchSlot(0)).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');
  });

  it('holsters a drawn melee weapon or grenade with the key that owns the gun underneath', () => {
    const { weapons } = harness();
    weapons.grantWeapon('rifle');
    weapons.grantWeapon('smg');
    weapons.switchTo('rifle');
    expect(weapons.equipMelee()).toBe(true);
    expect(weapons.isMeleeDrawn).toBe(true);

    // The firearm underneath is still rifle; 1 puts it back rather than advancing to the smg.
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.isMeleeDrawn).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('rifle');

    // Same for the grenade: 2 draws nothing new because the pistol is already the pick, it
    // puts the ordnance away and hands the sidearm back.
    weapons.switchTo('pistol');
    expect(weapons.equipOrdnance()).toBe(true);
    expect(weapons.isOrdnanceSelected).toBe(true);
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.isOrdnanceSelected).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');

    // A category the player owns nothing in does nothing, even with the melee weapon out:
    // there is no primary to put back, so 1 must not skip to some other weapon.
    const empty = bareController();
    expect(empty.equipMelee()).toBe(true);
    expect(empty.switchSlot(1)).toBe(false);
    expect(empty.isMeleeDrawn).toBe(true);
  });

  it('draws and rotates the melee category on key 3', () => {
    const weapons = bareController();
    // One melee weapon owned (the knife): the first press draws it, the second does nothing.
    expect(weapons.switchSlot(3)).toBe(true);
    expect(weapons.isMeleeDrawn).toBe(true);
    expect(weapons.activeMelee.id).toBe('knife');
    expect(weapons.switchSlot(3)).toBe(false);

    // A second owned melee weapon joins the rotation and it cycles between the two.
    weapons.grantMelee('axe');
    expect(weapons.ownedMelee).toEqual(['knife', 'axe']);
    expect(weapons.switchSlot(3)).toBe(true);
    expect(weapons.activeMelee.id).toBe('axe');
    expect(weapons.switchSlot(3)).toBe(true);
    expect(weapons.activeMelee.id).toBe('knife');
    // The firearm underneath never moved: melee is a draw state, not a loadout slot.
    expect(weapons.snapshot.weaponId).toBe('pistol');
  });

  it('selects the ordnance on key 4 and cycles nothing on a second press', () => {
    const { weapons, grenades } = harness();
    expect(grenades.available).toBeGreaterThan(0);
    expect(weapons.switchSlot(4)).toBe(true);
    expect(weapons.isOrdnanceSelected).toBe(true);
    // One ordnance item: the second press is a no-op the way a single-weapon slot is.
    expect(weapons.switchSlot(4)).toBe(false);

    // A firearm key takes the grenade out of the hand.
    weapons.grantWeapon('rifle');
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.isOrdnanceSelected).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('rifle');
  });

  it('covers every slot-1 primary in the roster from the keyboard', () => {
    // Six primaries in slot 1, and the reason this change exists: every one of them has to be
    // reachable by pressing 1. The lane the work order calls out, checked end to end.
    const slot1 = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => WEAPONS[id].slot === 1);
    expect(slot1.length).toBeGreaterThan(1);

    const weapons = bareController();
    for (const id of slot1) weapons.grantWeapon(id);
    const seen = new Set<WeaponId>();
    for (let press = 0; press < slot1.length; press += 1) {
      expect(weapons.switchSlot(1), `press ${press}`).toBe(true);
      seen.add(weapons.snapshot.weaponId);
    }
    expect([...seen].sort()).toEqual([...slot1].sort());
  });

  it('covers every melee weapon in the roster from key 3', () => {
    const meleeIds = Object.keys(MELEE) as MeleeId[];
    const weapons = bareController();
    for (const id of meleeIds) weapons.grantMelee(id);
    const seen = new Set<MeleeId>();
    for (let press = 0; press < meleeIds.length; press += 1) {
      expect(weapons.switchSlot(3), `press ${press}`).toBe(true);
      seen.add(weapons.activeMelee.id);
    }
    expect([...seen].sort()).toEqual([...meleeIds].sort());
  });
});
