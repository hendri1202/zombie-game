import { describe, expect, it } from 'vitest';
import { Object3D, PerspectiveCamera, PointLight } from 'three';

import { WEAPON_FEEL, WEAPONS, type WeaponId } from '../src/app/gameConfig';
import { WeaponController } from '../src/player/WeaponController';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import type { PlayerController } from '../src/player/PlayerController';

/**
 * The view-model fill light is the weapon's, not the game's.
 *
 * It hangs off the view-model holder, so as first written it was one switch for whatever was in
 * the player's hands: added for the three code-built firearms, which are flat metals with no
 * environment map and photographed as silhouettes, it lit the seven firearms whose frames were
 * already signed off too. On those frames the pistol's and the rifle's own pixels went from 9.4
 * and 12.5 mean luminance to 106 and 110, and the rifle's handguard and the pistol's slide
 * clipped to flat white with the detail burnt out of them.
 *
 * A light is not measurable from a screenshot it wrecked, so what is asserted here is the
 * switch: the light is on for exactly the weapons that declare `WeaponConfig.viewModelLight`,
 * and it follows the weapon in hand. That is the property whose absence caused the regression,
 * and it is checkable without a browser.
 */

function rig(): { weapons: WeaponController; light: PointLight; holder: Object3D } {
  const camera = new PerspectiveCamera(76, 16 / 9, 0.08, 420);
  const weapons = new WeaponController({
    camera,
    events: new EventBus<GameEvents>(),
    damage: {} as unknown as DamageSystem,
    player: {} as unknown as PlayerController,
    melee: {} as unknown as MeleeSystem,
  });
  for (const id of Object.keys(WEAPONS) as WeaponId[]) weapons.grantWeapon(id);
  // The controller parents the view-model root to the camera, so the holder and the light on it
  // are reachable from the scene graph alone — no test hook needed for a light the game draws.
  const root = camera.children.find((child) => child.name === 'weapon-view-model');
  expect(root, 'the view-model root is not on the camera').toBeTruthy();
  const holder = root?.children[0];
  expect(holder, 'the holder is not inside the view-model root').toBeTruthy();
  const light = holder?.getObjectByName('view-model-fill');
  expect(light, 'the fill light is not on the holder').toBeInstanceOf(PointLight);
  return { weapons, light: light as PointLight, holder: holder as Object3D };
}

describe('the view-model fill light is opt-in per weapon', () => {
  it('is lit for exactly the weapons that declare it, and dark for the rest', () => {
    const { weapons, light } = rig();
    const lit: WeaponId[] = [];
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      weapons.switchTo(id);
      // update() is what the game calls every frame; the switch is written there, and a
      // check that only read the config would not prove the controller ever reads it.
      weapons.update(1 / 60, null, true);
      expect(light.visible, `${id}: expected viewModelLight=${String(WEAPONS[id].viewModelLight === true)}`)
        .toBe(WEAPONS[id].viewModelLight === true);
      if (light.visible) lit.push(id);
    }
    // The five the light is for are still lit; the five whose frames it blew out are not.
    // Spelled out rather than inferred, because this list is the whole decision — and the LMG
    // is in the second list on purpose: lit, it measures 23.2 over its own pixels against 9.9
    // unlit, so the light lifts it by 13 and leaves it a silhouette (see its entry).
    expect(lit).toEqual(['mp5', 'p90', 'mp7', 'aug', 'remington-870']);
  });

  it('switches with the weapon in hand, so no weapon inherits the last one\'s light', () => {
    const { weapons, light } = rig();
    weapons.switchTo('mp7');
    expect(light.visible).toBe(true);
    weapons.switchTo('rifle');
    expect(light.visible).toBe(false);
    weapons.switchTo('remington-870');
    expect(light.visible).toBe(true);
    weapons.switchTo('pistol');
    expect(light.visible).toBe(false);
  });

  it('is out while a melee weapon or the grenade is in hand', () => {
    const { weapons, light } = rig();
    weapons.switchTo('mp7');
    expect(light.visible).toBe(true);
    weapons.equipMelee();
    expect(light.visible).toBe(false);
    weapons.holsterMelee();
    expect(light.visible).toBe(true);
    weapons.equipOrdnance();
    expect(light.visible).toBe(false);
    weapons.holsterOrdnance();
    expect(light.visible).toBe(true);
  });

  it('is the point light the feel table describes, with the weapon it lights', () => {
    const { light } = rig();
    const spec = WEAPON_FEEL.viewModelLight;
    expect(light.color.getHex()).toBe(spec.colour);
    expect(light.intensity).toBe(spec.intensity);
    expect(light.distance).toBe(spec.distance);
    expect(light.decay).toBe(2);
    expect(light.position.toArray()).toEqual([...spec.position]);
    // No shadows: it is a fill light for one mesh, and a shadow-casting point light costs six
    // faces of shadow map for a weapon inside the camera.
    expect(light.castShadow).toBe(false);
  });
});
