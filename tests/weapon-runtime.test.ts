import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../src/app/gameConfig';
import { WeaponRuntime } from '../src/combat/WeaponRuntime';

const pistol = WEAPONS.pistol;

describe('WeaponRuntime', () => {
  it('starts with a full magazine and the configured reserve', () => {
    const weapon = new WeaponRuntime(pistol);
    expect(weapon.roundsInMagazine).toBe(pistol.magazineSize);
    expect(weapon.roundsInReserve).toBe(pistol.startingReserve);
  });

  it('enforces the fire rate instead of firing every frame', () => {
    const weapon = new WeaponRuntime(pistol);
    const interval = 1 / pistol.fireRate;
    expect(weapon.tryFire()).toBe('fired');
    expect(weapon.tryFire()).toBe('cooling-down');
    weapon.update(interval * 0.9);
    expect(weapon.tryFire()).toBe('cooling-down');
    weapon.update(interval * 0.2);
    expect(weapon.tryFire()).toBe('fired');
  });

  it('reports empty and refuses to fire with an empty magazine', () => {
    const weapon = new WeaponRuntime(pistol);
    for (let i = 0; i < pistol.magazineSize; i += 1) {
      expect(weapon.tryFire()).toBe('fired');
      weapon.update(1 / pistol.fireRate);
    }
    expect(weapon.isMagazineEmpty).toBe(true);
    expect(weapon.tryFire()).toBe('empty');
  });

  it('reloads only after the reload duration and moves rounds from the reserve', () => {
    const weapon = new WeaponRuntime(pistol);
    expect(weapon.tryFire()).toBe('fired');
    expect(weapon.startReload()).toBe(true);
    expect(weapon.isReloading).toBe(true);
    expect(weapon.tryFire()).toBe('reloading');

    weapon.update(pistol.reloadSeconds * 0.5);
    expect(weapon.isReloading).toBe(true);
    expect(weapon.roundsInMagazine).toBe(pistol.magazineSize - 1);

    weapon.update(pistol.reloadSeconds * 0.6);
    expect(weapon.isReloading).toBe(false);
    expect(weapon.roundsInMagazine).toBe(pistol.magazineSize);
    expect(weapon.roundsInReserve).toBe(pistol.startingReserve - 1);
  });

  it('refuses to reload a full magazine or with an empty reserve', () => {
    const weapon = new WeaponRuntime(pistol);
    expect(weapon.startReload()).toBe(false);

    const drained = new WeaponRuntime({ ...pistol, startingReserve: 0 });
    for (let i = 0; i < pistol.magazineSize; i += 1) {
      drained.tryFire();
      drained.update(1 / pistol.fireRate);
    }
    expect(drained.startReload()).toBe(false);
  });

  it('never exceeds the reserve cap when picking ammo up', () => {
    const weapon = new WeaponRuntime(pistol);
    weapon.addReserve(1);
    expect(weapon.roundsInReserve).toBe(pistol.startingReserve + 1);
    weapon.addReserve(9999);
    expect(weapon.roundsInReserve).toBe(pistol.maxReserve);
  });

  it('cannot fire while unowned', () => {
    const weapon = new WeaponRuntime(pistol);
    weapon.setOwned(false);
    expect(weapon.tryFire()).toBe('not-owned');
  });
});
