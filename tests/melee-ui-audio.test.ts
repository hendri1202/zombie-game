import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Object3D, Vector3 } from 'three';
import { hudWeaponReadout } from '../src/ui/HUD';
import { buyButtonState } from '../src/ui/Store';
import { MELEE_SOUNDS } from '../src/systems/AudioManager';
import { attachGear, slungGearWeapon, type GearWeapon } from '../src/player/proceduralGear';
import { MELEE, MELEE_BUNDLE_MESH, type MeleeId } from '../src/app/meleeConfig';
import { WeaponController } from '../src/player/WeaponController';
import { MeleeSystem } from '../src/combat/MeleeSystem';
import { DamageSystem } from '../src/combat/DamageSystem';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import type { InputSnapshot } from '../src/input/InputManager';
import { CollisionWorld } from '../src/level/CollisionWorld';
import { PlayerController } from '../src/player/PlayerController';
import { SeededRandom } from '../src/utils/math';
import type { Zombie } from '../src/zombies/Zombie';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';
import type { ZombieKind } from '../src/app/gameConfig';

/** The survivor models, read raw so the bundle mesh names can be checked against the files. */
const SURVIVOR_FILES = import.meta.glob('/public/assets/characters/survivors/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/**
 * The four recorded melee/store gaps.
 *
 * All of it is pure or logic-only — the HUD's readout rule, the buy button's state, the
 * swing sound mapping, and which mesh/gear a drawn melee weapon shows. None of it needs a
 * renderer or a DOM, which is the point: these were holes in behaviour that no unit test
 * covered, not rendering bugs.
 */

describe('melee row in the HUD', () => {
  it('shows a firearm as a name and a magazine, exactly as before', () => {
    const readout = hudWeaponReadout({
      weaponName: 'Rifle', meleeName: 'Combat Knife', magazine: 30, reserve: 120, melee: false,
    });
    expect(readout.name).toBe('RIFLE');
    expect(readout.ammo).toBe('30');
    expect(readout.reserve).toBe('120');
    expect(readout.hideReserve).toBe(false);
  });

  it('shows the drawn melee weapon by name with no ammunition numbers', () => {
    const readout = hudWeaponReadout({
      weaponName: 'Rifle', meleeName: 'Fire Axe', magazine: 30, reserve: 120, melee: true,
    });
    expect(readout.name).toBe('FIRE AXE');
    // The last firearm's magazine must not leak into a melee readout: those rounds belong to
    // a gun that is not in hand.
    expect(readout.ammo).not.toContain('30');
    expect(readout.ammo).toBe('MELEE');
    expect(readout.reserve).toBe('');
    expect(readout.hideReserve).toBe(true);
  });

  it('leaves the firearm readout untouched however high the melee name is', () => {
    const withMelee = hudWeaponReadout({
      weaponName: 'Pistol', meleeName: 'Spear', magazine: 12, reserve: 48, melee: false,
    });
    const withoutMelee = hudWeaponReadout({
      weaponName: 'Pistol', meleeName: '', magazine: 12, reserve: 48, melee: false,
    });
    // Switching back from melee restores the gun's numbers exactly: the melee name plays no
    // part in a firearm readout.
    expect(withMelee).toEqual(withoutMelee);
  });
});

describe('melee swing sound roles', () => {
  it('gives the swing and the whiff their own, distinct voices', () => {
    expect(MELEE_SOUNDS.swing).not.toBe(MELEE_SOUNDS.miss);
    expect(MELEE_SOUNDS.swing.length).toBeGreaterThan(0);
    expect(MELEE_SOUNDS.miss.length).toBeGreaterThan(0);
  });

  it('does not stand in for the impact, which stays on the gunfire hit event', () => {
    // A landed blow is reported as 'combat:hit' and plays the existing hit voice. A melee
    // voice that collided with it would play the impact twice.
    const impactVoices = ['hit-flesh', 'hit-head', 'hit-world'];
    expect(impactVoices).not.toContain(MELEE_SOUNDS.swing);
    expect(impactVoices).not.toContain(MELEE_SOUNDS.miss);
  });

  it('synthesises melee, never a firearm sample', () => {
    // The firearm voices play a decoded recording; the swing is noise through a sweep, so it
    // must not share a name with the sampled shots.
    const firearmVoices = ['pistol', 'rifle', 'shotgun', 'heavy'];
    expect(firearmVoices).not.toContain(MELEE_SOUNDS.swing);
    expect(firearmVoices).not.toContain(MELEE_SOUNDS.miss);
  });
});

describe('melee swing events drive the sound without doubling the impact', () => {
  it('reports a swing that misses once, and never as a hit', () => {
    const h = swingHarness({ zombieDistance: 40 });
    h.weapons.equipMelee();
    expect(h.weapons.tryMelee()).toBe(true);
    for (let frame = 0; frame < 90; frame += 1) h.step(1 / 60);

    expect(h.swings()).toBe(1);
    expect(h.misses()).toBe(1);
    expect(h.hits()).toBe(0);
  });

  it('reports a swing that connects as a hit, and not as a miss', () => {
    const h = swingHarness({ zombieDistance: 1.2 });
    h.weapons.equipMelee();
    expect(h.weapons.tryMelee()).toBe(true);
    for (let frame = 0; frame < 90; frame += 1) h.step(1 / 60);

    expect(h.swings()).toBe(1);
    expect(h.hits()).toBe(1);
    // The impact is the 'combat:hit' event and nothing else, so melee cannot sound like a
    // hit and a miss at once.
    expect(h.misses()).toBe(0);
  });
});

describe('store buy button state', () => {
  it('is only clickable when the item is affordable and not owned', () => {
    const ready = buyButtonState({ owned: false, canBuy: true });
    expect(ready.state).toBe('ready');
    expect(ready.disabled).toBe(false);

    const locked = buyButtonState({ owned: false, canBuy: false });
    expect(locked.state).toBe('locked');
    expect(locked.disabled).toBe(true);
    // The class the CSS keys off, so "looks inactive" and "is inactive" cannot drift.
    expect(locked.modifierClass).toBe('is-locked');

    const owned = buyButtonState({ owned: true, canBuy: false });
    expect(owned.state).toBe('owned');
    expect(owned.disabled).toBe(true);
  });

  it('keeps a one-point shortfall locked even when the balance is otherwise healthy', () => {
    expect(buyButtonState({ owned: false, canBuy: false }).disabled).toBe(true);
    // And the state is a pure function of the two flags, so nothing else can flip it.
    expect(buyButtonState({ owned: false, canBuy: true }).modifierClass)
      .not.toBe(buyButtonState({ owned: false, canBuy: false }).modifierClass);
  });
});

/**
 * Melee weapons whose mesh is part of the survivor bundle, as opposed to the ones whose
 * mesh the project builds in code (`src/player/proceduralWeapons.ts`).
 *
 * The distinction matters to the test below: a bundled mesh has to name a node the files
 * actually contain, while a code-built one has its own exported glTF and must name no node
 * at all, so that a third-person hand shows nothing rather than the wrong tool.
 */
const BUNDLED_MELEE: readonly MeleeId[] = ['knife', 'axe', 'barbed-bat', 'spear'];

describe('melee mesh in the character hand', () => {
  it('maps each melee weapon to the bundled mesh the survivor files actually ship', () => {
    const files = Object.entries(SURVIVOR_FILES);
    expect(files.length).toBeGreaterThan(0);
    const names = Object.keys(MELEE_BUNDLE_MESH) as MeleeId[];
    // One mesh name per weapon, all lowercase because matching is case-insensitive.
    expect(new Set(Object.values(MELEE_BUNDLE_MESH)).size).toBe(names.length);
    for (const meleeId of names) {
      expect(MELEE_BUNDLE_MESH[meleeId]).toBe(MELEE_BUNDLE_MESH[meleeId].toLowerCase());
    }
    // And every melee weapon has an entry: a gap here is a weapon with no hand mesh at all,
    // and the record is what PlayerAvatar iterates.
    expect([...names].sort()).toEqual(Object.keys(MELEE).sort());

    const codeBuilt = names.filter((id) => !BUNDLED_MELEE.includes(id));
    for (const [file, text] of files) {
      const gltf = JSON.parse(text) as { nodes?: Array<{ name?: string }> };
      const nodeNames = (gltf.nodes ?? [])
        .map((node) => (node.name ?? '').toLowerCase());
      for (const meleeId of BUNDLED_MELEE) {
        // A hand mesh that names a node no file has would silently show nothing at all.
        expect(nodeNames, `${file} -> ${meleeId}`).toContain(MELEE_BUNDLE_MESH[meleeId]);
      }
      for (const meleeId of codeBuilt) {
        // The other way round: these meshes are not in the bundle, and a name that did
        // collide with a real node would put the wrong tool in the character's fist.
        expect(nodeNames, `${file} -> ${meleeId}`).not.toContain(MELEE_BUNDLE_MESH[meleeId]);
      }
    }
  });

  it('knows which slung tools a drawn melee weapon must hide', () => {
    // Jack carries an axe and a bat on his pack. Drawing the matching weapon hides the slung
    // copy, or the tool is in two places at once.
    expect(slungGearWeapon('axe')).toBe('axe');
    expect(slungGearWeapon('barbed-bat')).toBe('bat');
    // A knife and a spear are never slung, so nothing is hidden for them.
    expect(slungGearWeapon('knife')).toBeNull();
    expect(slungGearWeapon('spear')).toBeNull();
  });

  it('reports the slung tools so the avatar can toggle them', () => {
    const body = stubBody(['Middle1.L', 'Middle1.R', 'Torso']);
    const report = attachGear(body, { onPack: ['axe', 'bat'], backpack: true });
    expect(report.skipped).toEqual([]);
    expect((Object.keys(report.slung) as GearWeapon[]).sort()).toEqual(['axe', 'bat']);
    expect(report.slung.axe?.name).toBe('GearAxe');
    expect(report.slung.bat?.name).toBe('GearBat');
    // The slung groups are the same objects the torso carries, not copies: toggling
    // `visible` on one has to hide the thing on the back.
    expect(report.slung.axe?.parent?.name).toBe('Torso');

    // A character with nothing on the pack reports an empty map, not undefined.
    const empty = attachGear(stubBody(['Torso']), { backpack: true });
    expect(empty.slung).toEqual({});
  });
});

/** A stand-in body with only the bones the gear looks up. */
function stubBody(bones: readonly string[]): Object3D {
  const root = new Object3D();
  for (const name of bones) {
    const bone = new Object3D();
    bone.name = name;
    root.add(bone);
  }
  return root;
}

/** A zombie with just the surface the melee system touches. */
class FakeZombie {
  readonly id: number;
  readonly kind: ZombieKind = 'walker';
  readonly position: Vector3;
  readonly stats = { radius: 0.42, height: 1.8 };
  isAlive = true;
  health = 100;

  constructor(id: number, x: number, z: number) {
    this.id = id;
    this.position = new Vector3(x, 0, z);
  }

  applyDamage(damage: number): { applied: number; died: boolean } {
    this.health -= damage;
    const died = this.health <= 0;
    if (died) this.isAlive = false;
    return { applied: damage, died };
  }

  asZombie(): Zombie {
    return this as unknown as Zombie;
  }
}

/** A controller, player and swing counter, with no renderer and no audio context. */
function swingHarness(options: { zombieDistance: number }) {
  const events = new EventBus<GameEvents>();
  const collision = new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
  const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
  const player = new PlayerController({ camera, collision });
  // Spawn is (0, 14) facing -Z, so facingAngle is 0 and forward is +Z.
  const zombie = new FakeZombie(1, 0, player.position.z + options.zombieDistance);

  const director = {
    list: [zombie.asZombie()],
    hitboxTargets: () => [],
  } as unknown as ZombieDirector;
  const melee = new MeleeSystem({ director, collision, events });
  const damage = new DamageSystem({ director, collision, events, random: new SeededRandom(7) });
  const weapons = new WeaponController({ camera, events, damage, player, melee });

  let swingCount = 0;
  let missCount = 0;
  let hitCount = 0;
  events.on('melee:swung', () => { swingCount += 1; });
  events.on('melee:missed', () => { missCount += 1; });
  events.on('combat:hit', () => { hitCount += 1; });

  const input = (): InputSnapshot => ({
    forward: 0, right: 0, sprint: false, lookX: 0, lookY: 0, firing: false,
    firePressed: false, reloadPressed: false, meleePressed: false, weaponSlotRequested: null,
  });

  return {
    weapons,
    step: (seconds: number) => weapons.update(seconds, input(), true),
    swings: () => swingCount,
    misses: () => missCount,
    hits: () => hitCount,
  };
}
