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
 * Each firearm's own on-screen size.
 *
 * `normalizeViewModel` gives every weapon the same on-screen length, so before this the
 * belt-fed LMG was drawn exactly as long as the sidearm. The fix is one multiplier per
 * weapon (`WeaponConfig.viewModel.scale`), and these tests pin the two things that matter:
 * the four original firearms are untouched, and the new ones are ordered the way their real
 * bulk is. The last test reads the scale off a live controller, so it proves the multiplier
 * reaches the draw, not only the config table.
 */
const ORIGINAL_FIREARMS: readonly WeaponId[] = ['pistol', 'rifle', 'smg', 'shotgun'];

/** A controller with nothing behind the systems a swap never touches. */
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

/** Every weapon owned, so any of them can be drawn. */
function controllerWithAllWeapons(): WeaponController {
  const weapons = bareController();
  for (const id of Object.keys(WEAPONS) as WeaponId[]) weapons.grantWeapon(id);
  return weapons;
}

describe('the firearm view-model scale table', () => {
  it('gives every firearm a real, positive scale', () => {
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const scale = WEAPONS[id].viewModel.scale;
      expect(typeof scale, id).toBe('number');
      expect(Number.isFinite(scale), id).toBe(true);
      expect(scale, id).toBeGreaterThan(0);
    }
  });

  it('leaves the four original firearms at the reference size', () => {
    // 1 is the size they were tuned to on captured frames. Any other value here is a
    // regression in how the game already looked, not a fix.
    for (const id of ORIGINAL_FIREARMS) {
      expect(WEAPONS[id].viewModel.scale, id).toBe(1);
    }
  });

  it('orders the new firearms by their real bulk: P90 < MP5 < LMG', () => {
    const { p90, mp5, lmg } = WEAPONS;
    // The bullpup is the shortest weapon in the roster, and shorter than the reference.
    expect(p90.viewModel.scale).toBeLessThan(1);
    // The MP5 sits between the bullpup and the belt-fed gun.
    expect(mp5.viewModel.scale).toBeGreaterThan(p90.viewModel.scale);
    expect(mp5.viewModel.scale).toBeLessThan(lmg.viewModel.scale);
    // And the belt-fed gun is unmistakably the longest: about twice the bullpup, and the
    // only weapon drawn clearly larger than the sidearm.
    expect(lmg.viewModel.scale).toBeGreaterThan(1);
    expect(lmg.viewModel.scale / p90.viewModel.scale).toBeGreaterThan(1.5);
  });
});

describe('the scale reaching the drawn weapon', () => {
  it('draws the four original firearms at one identical size', () => {
    const weapons = controllerWithAllWeapons();
    weapons.switchTo('pistol');
    const reference = weapons.mountedViewModelScale;
    expect(reference).toBeGreaterThan(0);

    for (const id of ORIGINAL_FIREARMS) {
      weapons.switchTo(id);
      expect(weapons.mountedViewModelScale, id).toBeCloseTo(reference, 6);
    }
  });

  it('draws each weapon at the base size times its own multiplier', () => {
    const weapons = controllerWithAllWeapons();
    weapons.switchTo('pistol');
    const base = weapons.mountedViewModelScale;

    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      weapons.switchTo(id);
      expect(weapons.mountedViewModelScale, id)
        .toBeCloseTo(base * WEAPONS[id].viewModel.scale, 6);
    }
  });

  it('actually draws the belt-fed LMG longer than the bullpup', () => {
    const weapons = controllerWithAllWeapons();
    weapons.switchTo('p90');
    const p90 = weapons.mountedViewModelScale;
    weapons.switchTo('mp5');
    const mp5 = weapons.mountedViewModelScale;
    weapons.switchTo('lmg');
    const lmg = weapons.mountedViewModelScale;

    // The visual gap the owner asked for: not configured that way, drawn that way.
    expect(lmg).toBeGreaterThan(mp5);
    expect(mp5).toBeGreaterThan(p90);
    expect(lmg).toBeGreaterThan(p90 * 1.5);
  });
});
