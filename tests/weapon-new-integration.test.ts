import { describe, expect, it } from 'vitest';
import { Group, Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { WEAPONS, type WeaponId } from '../src/app/gameConfig';
import { HANDS_PLACEMENT } from '../src/player/proceduralArms';
import { PROCEDURAL_WEAPONS, proceduralWeaponPath } from '../src/player/proceduralWeapons';
import { WEAPON_MECHANISMS } from '../src/player/weaponMechanism';
import { STORE_ITEMS, findStoreItem } from '../src/economy/storeItems';
import { shotRoleFor, SHOT_SAMPLES, type ShotRole } from '../src/systems/audioSamples';
import { weaponDropFor } from '../src/systems/PickupManager';
import { MP7_DESCRIPTOR } from '../src/player/weapons/mp7';
import { AUG_DESCRIPTOR } from '../src/player/weapons/aug';
import { REMINGTON870_DESCRIPTOR } from '../src/player/weapons/remington870';

/**
 * The three firearms built in their own modules — MP7, AUG and Remington 870 — wired into the
 * game.
 *
 * `weapon-mp7.test.ts`, `weapon-aug.test.ts` and `weapon-remington870.test.ts` each prove their
 * own mesh and their own descriptor. What none of them can prove is that the weapon *reaches
 * the game*: a descriptor sitting in a module is not a weapon until it is in `WEAPONS`, its mesh
 * is in the registry and exported, its grip has a hand pose, its shot has a sound role, its
 * action has a mechanism and its price is on the shelf. A `modelPath` typo is invisible at
 * runtime — the loader logs it and carries on with an empty fist — so the exported files are
 * read and parsed here rather than trusted.
 *
 * The stat line is compared field by field against the descriptor the weapon's own module
 * publishes, which is the one thing this integration must not be allowed to do: change a
 * balance number on the way in. If a value here and a value there ever disagree, the descriptor
 * and the config have drifted, and that is a failure rather than a judgement call.
 */

/** `ProgressEvent` for Node: `GLTFLoader` reports progress with one and Node has no browser. */
if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as unknown as { ProgressEvent: unknown }).ProgressEvent = class {
    readonly type: string;

    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
}

const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const NEW_FIREARMS: readonly WeaponId[] = ['mp7', 'aug', 'remington-870'];

/** The three weapons with their own module's descriptor, so the two cannot drift apart. */
const DESCRIPTORS = {
  mp7: MP7_DESCRIPTOR,
  aug: AUG_DESCRIPTOR,
  'remington-870': REMINGTON870_DESCRIPTOR,
} as const;

/** Every role a shot is allowed to use, so none of the three invents a fifth sample. */
const SHOT_ROLES: readonly ShotRole[] = ['pistol', 'rifle', 'shotgun', 'heavy'];

function fileFor(modelPath: string): string | null {
  const name = modelPath.split('/').pop() ?? '';
  const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
  return key ? WEAPON_FILES[key] : null;
}

describe('the three new firearms in the weapon table', () => {
  it('is in WEAPONS, filed as a slot-1 primary', () => {
    for (const id of NEW_FIREARMS) {
      const weapon = WEAPONS[id];
      expect(weapon, `${id} is not in WEAPONS`).toBeTruthy();
      expect(weapon.id, id).toBe(id);
      // §14.1: a shoulder-fired gun is a primary, and the sidearm has slot 2 to itself.
      expect(weapon.slot, id).toBe(1);
    }
  });

  it('carries the descriptor numbers verbatim, with nothing retuned on the way in', () => {
    for (const id of NEW_FIREARMS) {
      const weapon = WEAPONS[id];
      const descriptor = DESCRIPTORS[id as keyof typeof DESCRIPTORS];
      expect(descriptor.id, id).toBe(id);

      // The descriptor is the balance source of truth for a weapon whose mesh lives in its own
      // module; the config may add the four fields a descriptor cannot know (slot,
      // headshotMultiplier, modelPath, viewModel) and must not change any of these.
      expect(weapon.name, id).toBe(descriptor.name);
      expect(weapon.damage, id).toBe(descriptor.damage);
      expect(weapon.fireRate, id).toBe(descriptor.fireRate);
      expect(weapon.automatic, id).toBe(descriptor.automatic);
      expect(weapon.magazineSize, id).toBe(descriptor.magazineSize);
      expect(weapon.startingReserve, id).toBe(descriptor.startingReserve);
      expect(weapon.maxReserve, id).toBe(descriptor.maxReserve);
      expect(weapon.reloadSeconds, id).toBe(descriptor.reloadSeconds);
      expect(weapon.range, id).toBe(descriptor.range);
      expect(weapon.spread, id).toBe(descriptor.spread);
      expect(weapon.recoil, id).toBe(descriptor.recoil);
      expect(weapon.recoilRecovery, id).toBe(descriptor.recoilRecovery);
      expect(weapon.muzzleFlashSeconds, id).toBe(descriptor.muzzleFlashSeconds);
      expect(weapon.tracerEvery, id).toBe(descriptor.tracerEvery);
      expect(weapon.grip, id).toBe(descriptor.grip);
      // `pellets` is the one optional field: the pump gun has it, the automatics must not, or
      // every automatic would fire the shotgun's eight-ray pattern.
      if ('pellets' in descriptor) expect(weapon.pellets, id).toBe(descriptor.pellets);
      else expect(weapon.pellets, id).toBeUndefined();

      // The runtime invariants every other firearm satisfies, asserted for these three too.
      expect(weapon.maxReserve, id).toBeGreaterThanOrEqual(weapon.startingReserve);
      expect(weapon.tracerEvery, id).toBeGreaterThanOrEqual(1);
      expect(weapon.headshotMultiplier, id).toBeGreaterThan(0);
    }
  });
});

describe('the exported files behind the three new firearms', () => {
  it('registers each mesh once, and the config points at the file the registry writes', () => {
    const registry = new Map(PROCEDURAL_WEAPONS.map((entry) => [entry.id, entry.file]));
    for (const id of NEW_FIREARMS) {
      const file = registry.get(id);
      expect(file, `${id} has no mesh in the procedural registry`).toBeTruthy();
      expect(WEAPONS[id].modelPath, id).toBe(proceduralWeaponPath(file ?? ''));
      // A firearm model path the asset test accepts: no hyphen, glTF only.
      expect(WEAPONS[id].modelPath, id).toMatch(/^\/assets\/weapons\/[A-Za-z0-9_]+\.gltf$/);
    }
  });

  it('ships the exported glTF, with real geometry inside and no sidecar buffer', () => {
    for (const id of NEW_FIREARMS) {
      const text = fileFor(WEAPONS[id].modelPath);
      expect(text, `${id} -> ${WEAPONS[id].modelPath} was never exported`).not.toBeNull();
      if (!text) continue;

      const gltf = JSON.parse(text) as {
        asset?: { version?: string };
        meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
        accessors?: Array<{ bufferView?: number; count?: number }>;
        bufferViews?: Array<{ byteLength?: number }>;
        buffers?: Array<{ uri?: string }>;
      };
      expect(gltf.asset?.version, id).toBe('2.0');
      expect(gltf.meshes?.length ?? 0, id).toBeGreaterThan(1);
      const primitive = gltf.meshes?.[0]?.primitives?.[0];
      expect(primitive?.attributes?.POSITION, id).toBeTypeOf('number');
      const accessor = gltf.accessors?.[primitive?.attributes?.POSITION ?? 0];
      expect((gltf.bufferViews?.[accessor?.bufferView ?? 0]?.byteLength ?? 0) > 0, id).toBe(true);
      expect(accessor?.count ?? 0, id).toBeGreaterThan(0);
      // Self-contained, like every other weapon file: a missing `.bin` is an empty view model.
      expect(gltf.buffers?.[0]?.uri ?? '', id).toContain('base64,');
    }
  });

  it('parses through the GLTFLoader the runtime loads view models with', async () => {
    const loader = new GLTFLoader();
    for (const id of NEW_FIREARMS) {
      const text = fileFor(WEAPONS[id].modelPath) ?? '';
      const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
        loader.parse(text, '', resolve, reject);
      });
      let meshes = 0;
      gltf.scene.traverse((child) => {
        if ((child as Mesh).isMesh) meshes += 1;
      });
      expect(meshes, id).toBeGreaterThan(1);
    }
  }, 30000);
});

describe('the three new firearms in the hands, the ears and the action', () => {
  it('gives each one a grip the first-person arms have a pose for', () => {
    for (const id of NEW_FIREARMS) {
      const grip = WEAPONS[id].grip;
      expect(['pistol', 'rifle', 'shotgun'], id).toContain(grip);
      expect(HANDS_PLACEMENT[grip], `${id}: no hand pose for grip "${grip}"`).toBeTruthy();
    }
    // The two shoulder-stocked automatics take the rifle pose; the sliding forend takes the
    // shotgun hold, which is a different hand position rather than a relabelled one.
    expect(WEAPONS.mp7.grip).toBe('rifle');
    expect(WEAPONS.aug.grip).toBe('rifle');
    expect(WEAPONS['remington-870'].grip).toBe('shotgun');
  });

  it('routes each one to a sound role the game already ships', () => {
    for (const id of NEW_FIREARMS) {
      const role = shotRoleFor(id);
      expect(SHOT_ROLES, id).toContain(role);
      expect(SHOT_SAMPLES[role].length, id).toBeGreaterThan(0);
    }
    // The automatics fire a rifle recording; the pump gun fires the shotgun one.
    expect(shotRoleFor('mp7')).toBe('rifle');
    expect(shotRoleFor('aug')).toBe('rifle');
    expect(shotRoleFor('remington-870')).toBe('shotgun');
  });

  it('decides what moves on each one, with the action it actually has', () => {
    // A `Record<WeaponId, …>` cannot be missing an entry and still type-check, but a wrong
    // entry is silent — so the kinds are pinned: two bolts and a pump.
    expect(WEAPON_MECHANISMS.mp7.kind).toBe('bolt');
    expect(WEAPON_MECHANISMS.aug.kind).toBe('bolt');
    expect(WEAPON_MECHANISMS['remington-870'].kind).toBe('pump');

    for (const id of NEW_FIREARMS) {
      const spec = WEAPON_MECHANISMS[id];
      expect(spec, `${id} has no mechanism`).toBeTruthy();
      expect(['slide', 'bolt', 'pump'], id).toContain(spec.kind);
      expect(spec.station, id).toBeGreaterThan(0);
      expect(spec.station, id).toBeLessThan(1);
      expect(spec.travel, id).toBeGreaterThan(0);
      // Travel is a fraction of the weapon's own length: anything near 0.3 is a part that
      // leaves the weapon entirely.
      expect(spec.travel, id).toBeLessThan(0.3);
    }
    // The 870's pump sits at the measured station of its own forend, not at the rifle's bolt.
    expect(WEAPON_MECHANISMS['remington-870'].station).toBe(0.65);
  });

  it('gives each one its own view-model placement, ordered by real bulk', () => {
    const placements = new Set<string>();
    // Across the whole table, not only the new three: two weapons sharing a placement render
    // inside each other when they are swapped.
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const position = WEAPONS[id].viewModel.position;
      expect(position.every((value) => Number.isFinite(value)), id).toBe(true);
      expect(placements.has(position.join(',')), `${id} shares a placement`).toBe(false);
      placements.add(position.join(','));
    }

    for (const id of NEW_FIREARMS) {
      expect(WEAPONS[id].viewModel.scale, id).toBeGreaterThan(0);
    }
    // The three values against the roster's own: the compact PDW sits between the P90 bullpup
    // and the MP5, the bullpup rifle between the MP5 and the belt gun, and the 870 — the
    // longest weapon on the shelf — above the belt gun.
    expect(WEAPONS.mp7.viewModel.scale).toBeGreaterThan(WEAPONS.p90.viewModel.scale);
    expect(WEAPONS.mp7.viewModel.scale).toBeLessThan(WEAPONS.mp5.viewModel.scale);
    expect(WEAPONS.aug.viewModel.scale).toBeGreaterThan(WEAPONS.mp5.viewModel.scale);
    expect(WEAPONS.aug.viewModel.scale).toBeLessThan(WEAPONS.lmg.viewModel.scale);
    expect(WEAPONS['remington-870'].viewModel.scale).toBeGreaterThan(WEAPONS.lmg.viewModel.scale);
  });
});

describe('buying the three new firearms', () => {
  it('sells all three, named after the config, at a positive integer price', () => {
    for (const id of NEW_FIREARMS) {
      const item = findStoreItem(id);
      expect(item, `${id} is not for sale`).not.toBeNull();
      if (!item) continue;
      expect(item.category).toBe('firearm');
      expect(item.price).toBeGreaterThan(0);
      expect(Number.isInteger(item.price)).toBe(true);
      expect(item.blurb.length).toBeGreaterThan(0);
      // The shelf name is the config's own name, so the row cannot lie about the weapon.
      expect(item.name).toBe(WEAPONS[id].name);
    }
  });

  it('keeps the prices rising with the weapons they buy', () => {
    const price = (id: string): number => findStoreItem(id)?.price ?? Number.NaN;
    // The order the store list is read in, cheapest first.
    for (let index = 1; index < STORE_ITEMS.length; index += 1) {
      expect(STORE_ITEMS[index].price, STORE_ITEMS[index].id)
        .toBeGreaterThanOrEqual(STORE_ITEMS[index - 1].price);
    }
    // The PDW's own identity in the economy: more than the short shotgun it out-ranges, less
    // than the P90 that fires the harder round; the rifle more than the P90, less than the belt
    // gun; the pump gun between the assault rifle and the short shotgun it is the long version
    // of.
    expect(price('mp7')).toBeGreaterThan(price('shotgun'));
    expect(price('mp7')).toBeLessThan(price('p90'));
    expect(price('aug')).toBeGreaterThan(price('p90'));
    expect(price('aug')).toBeLessThan(price('lmg'));
    expect(price('remington-870')).toBeGreaterThan(price('rifle'));
    expect(price('remington-870')).toBeLessThan(price('shotgun'));
  });

  it('stays store-only: the drop ladder still hands over nothing new', () => {
    // The ladder is rifle -> smg -> shotgun; a new gun on it would arrive free within a run
    // and hollow out its own price.
    const owned: WeaponId[] = [];
    const ladder: WeaponId[] = [];
    for (let step = 0; step < 8; step += 1) {
      const weapon = weaponDropFor(99, owned);
      if (!weapon) break;
      ladder.push(weapon);
      owned.push(weapon);
    }
    for (const id of NEW_FIREARMS) expect(ladder, id).not.toContain(id);
  });
});
