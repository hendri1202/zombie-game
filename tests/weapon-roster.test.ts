import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MELEE, WEAPONS, type MeleeId, type WeaponId } from '../src/app/gameConfig';
import { HANDS_PLACEMENT } from '../src/player/proceduralArms';
import { PROCEDURAL_WEAPONS, proceduralWeaponPath } from '../src/player/proceduralWeapons';
import { STORE_ITEMS, findStoreItem } from '../src/economy/storeItems';
import { weaponDropFor } from '../src/systems/PickupManager';
import { SHOT_SAMPLES, shotRoleFor, type ShotRole } from '../src/systems/audioSamples';
import { EventBus } from '../src/core/EventBus';
import { WeaponController } from '../src/player/WeaponController';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import type { PlayerController } from '../src/player/PlayerController';

/**
 * `ProgressEvent` for Node.
 *
 * `GLTFLoader` — the loader the game itself uses — reports progress with a `ProgressEvent`
 * only a browser has. A unit test has no browser and `agents.md` forbids driving one, so
 * the event is stubbed here; it is only ever read for its type and its byte counts.
 */
if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as unknown as { ProgressEvent: unknown }).ProgressEvent = class {
    readonly type: string;

    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
}

/**
 * The extra weapon roster from the work order in
 * `implementation-plan/2026-10-15-melee-store-poin-v2.md` §13 (Jalur B).
 *
 * Three firearms, five melee weapons, all of them with a mesh the project builds in code.
 * Everything the work order pins is pinned here as a number, so a later edit to a balance
 * value cannot quietly drop one of these weapons out of the roster it was specified in.
 *
 * The asset side is checked the way `weapon-assets.test.ts` checks the pack's weapons: a
 * typo in a `modelPath` is invisible at runtime (the loader logs it and carries on with no
 * view model), so the glTF files are read and their structure verified rather than trusted.
 */
const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const NEW_FIREARMS: readonly WeaponId[] = ['mp5', 'p90', 'lmg'];
const NEW_MELEE: readonly MeleeId[] = ['katana', 'machete', 'crowbar', 'sledgehammer', 'fire-axe'];

/** Every role a shot is allowed to use, so a new weapon cannot invent a fifth sample. */
const SHOT_ROLES: readonly ShotRole[] = ['pistol', 'rifle', 'shotgun', 'heavy'];

function fileFor(modelPath: string): string | null {
  const name = modelPath.split('/').pop() ?? '';
  const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
  return key ? WEAPON_FILES[key] : null;
}

function meshesOf(root: Group): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) found.push(mesh);
  });
  return found;
}

describe('Jalur B firearm roster', () => {
  it('carries the damage, magazine and tracer values the work order fixes', () => {
    // §13 Jalur B, verbatim. The LMG is the owner's "100-200 rounds" request, read as a
    // 150-round belt, with the long reload and the heavy sound role that go with it.
    expect(WEAPONS.mp5.damage).toBe(16);
    expect(WEAPONS.mp5.magazineSize).toBe(30);
    expect(WEAPONS.mp5.tracerEvery).toBe(2);

    expect(WEAPONS.p90.damage).toBe(18);
    expect(WEAPONS.p90.magazineSize).toBe(40);
    expect(WEAPONS.p90.tracerEvery).toBe(2);

    expect(WEAPONS.lmg.damage).toBe(22);
    expect(WEAPONS.lmg.magazineSize).toBe(150);
    expect(WEAPONS.lmg.tracerEvery).toBe(1);
    expect(WEAPONS.lmg.reloadSeconds).toBe(4.5);
    // Inside the range the owner asked for, not at its edge.
    expect(WEAPONS.lmg.magazineSize).toBeGreaterThanOrEqual(100);
    expect(WEAPONS.lmg.magazineSize).toBeLessThanOrEqual(200);
  });

  it('declares a runtime-valid entry for every new firearm', () => {
    for (const id of NEW_FIREARMS) {
      const weapon = WEAPONS[id];
      expect(weapon, id).toBeTruthy();
      expect(weapon.id, id).toBe(id);
      expect(weapon.magazineSize, id).toBeGreaterThan(0);
      expect(weapon.startingReserve, id).toBeGreaterThan(0);
      expect(weapon.maxReserve, id).toBeGreaterThanOrEqual(weapon.startingReserve);
      expect(weapon.tracerEvery, id).toBeGreaterThanOrEqual(1);
      expect(weapon.fireRate, id).toBeGreaterThan(0);
      expect(weapon.automatic, id).toBe(true);
      expect(weapon.muzzleFlashSeconds, id).toBeGreaterThan(0);
      // Slot 1: under §14.1 these are primaries, and the sidearm has slot 2 to itself.
      expect(weapon.slot, id).toBe(1);
      // A grip the first-person arms actually have a pose for.
      expect(HANDS_PLACEMENT[weapon.grip], id).toBeTruthy();
      expect(Number.isFinite(weapon.viewModel.position[0]), id).toBe(true);
      // Every value in the placement is a real number, not a NaN that renders at the origin.
      expect(weapon.viewModel.position.every((value) => Number.isFinite(value)), id).toBe(true);
    }
  });

  it('routes each new firearm to a sound role the game already ships', () => {
    for (const id of NEW_FIREARMS) {
      const role = shotRoleFor(id);
      // An existing role, never a new one: no sample file is added by this roster.
      expect(SHOT_ROLES, id).toContain(role);
      expect(SHOT_SAMPLES[role].length, id).toBeGreaterThan(0);
    }
    expect(shotRoleFor('lmg')).toBe('heavy');
    expect(shotRoleFor('mp5')).toBe('rifle');
    expect(shotRoleFor('p90')).toBe('rifle');
  });
});

describe('Jalur B melee roster', () => {
  it('carries the damage, arc, reach and cooldown the work order fixes', () => {
    // §13 Jalur B, verbatim.
    expect(MELEE.katana).toMatchObject({ damage: 70, arc: 1.5, reach: 2.4, cooldownSeconds: 0.75, clip: 'Slash' });
    expect(MELEE.machete).toMatchObject({ damage: 40, arc: 1.1, reach: 1.9, cooldownSeconds: 0.45, clip: 'Slash' });
    expect(MELEE.crowbar).toMatchObject({ damage: 48, arc: 1.0, reach: 2.0, cooldownSeconds: 0.55, clip: 'Slash' });
    expect(MELEE.sledgehammer).toMatchObject({ damage: 110, arc: 1.7, reach: 2.2, cooldownSeconds: 1.25, clip: 'Slash' });
    expect(MELEE['fire-axe']).toMatchObject({ damage: 66, arc: 1.3, reach: 2.1, cooldownSeconds: 0.8, clip: 'Slash' });
  });

  it('declares a runtime-valid entry for every new melee weapon', () => {
    for (const id of NEW_MELEE) {
      const weapon = MELEE[id];
      expect(weapon, id).toBeTruthy();
      expect(weapon.id, id).toBe(id);
      expect(weapon.damage, id).toBeGreaterThan(0);
      expect(weapon.arc, id).toBeGreaterThan(0);
      expect(weapon.reach, id).toBeGreaterThan(0);
      expect(weapon.cooldownSeconds, id).toBeGreaterThan(0);
      expect(weapon.swingSeconds, id).toBeGreaterThan(0);
      // A swing longer than its own cooldown would leave the weapon in the air.
      expect(weapon.swingSeconds, id).toBeLessThanOrEqual(weapon.cooldownSeconds);
      expect(['Slash', 'Stab'], id).toContain(weapon.clip);
      expect(HANDS_PLACEMENT[weapon.grip], id).toBeTruthy();
      expect(weapon.viewModel.scale, id).toBeGreaterThan(0);
      expect(weapon.viewModel.position.every((value) => Number.isFinite(value)), id).toBe(true);
    }
  });
});

describe('the two weapon tables stay apart', () => {
  it('never gives a melee weapon a firearm id or the other way round', () => {
    const firearms = new Set<string>(Object.keys(WEAPONS));
    for (const id of Object.keys(MELEE)) {
      expect(firearms.has(id), id).toBe(false);
    }
    // Within one table the ids are unique as well, which is what a Record gives but a
    // duplicated literal would silently break.
    expect(new Set(Object.keys(WEAPONS)).size).toBe(Object.keys(WEAPONS).length);
    expect(new Set(Object.keys(MELEE)).size).toBe(Object.keys(MELEE).length);
  });
});

describe('getting hold of the new weapons', () => {
  it('sells every new weapon, named after its config, at a positive price', () => {
    for (const id of [...NEW_FIREARMS, ...NEW_MELEE]) {
      const item = findStoreItem(id);
      expect(item, `${id} is not for sale`).not.toBeNull();
      if (!item) continue;
      expect(item.category).toBe(NEW_FIREARMS.includes(id as WeaponId) ? 'firearm' : 'melee');
      expect(item.price).toBeGreaterThan(0);
      expect(Number.isInteger(item.price)).toBe(true);
      expect(item.blurb.length).toBeGreaterThan(0);
      // The shelf name is the config's own name, so the row cannot lie about the weapon.
      const expected = id in WEAPONS ? WEAPONS[id as WeaponId].name : MELEE[id as MeleeId].name;
      expect(item.name).toBe(expected);
    }
  });

  it('keeps the shelf in non-decreasing price order', () => {
    // The list is read top to bottom in the store; a cheap item below an expensive one
    // reads as a mistake even though nothing breaks.
    for (let index = 1; index < STORE_ITEMS.length; index += 1) {
      expect(STORE_ITEMS[index].price, STORE_ITEMS[index].id)
        .toBeGreaterThanOrEqual(STORE_ITEMS[index - 1].price);
    }
  });

  it('leaves the drop ladder climbing the same three steps, and never drops a new gun', () => {
    // The ladder is rifle -> smg -> shotgun with a rising unlock wave. The new weapons are
    // store-only, so nothing cheap can arrive ahead of the sidearm.
    const ladder: WeaponId[] = [];
    const owned: WeaponId[] = [];
    for (let step = 0; step < 8; step += 1) {
      const weapon = weaponDropFor(99, owned);
      if (!weapon) break;
      ladder.push(weapon);
      owned.push(weapon);
    }
    expect(ladder).toEqual(['rifle', 'smg', 'shotgun']);
    for (const id of NEW_FIREARMS) {
      expect(ladder, id).not.toContain(id);
    }
    // And the ladder still starts at the bottom: nothing is handed over on wave one.
    expect(weaponDropFor(1, [])).toBeNull();
  });
});

describe('the code-built meshes behind the new weapons', () => {
  it('ships one registry entry per new weapon, and the config points at its file', () => {
    const registry = new Map(PROCEDURAL_WEAPONS.map((entry) => [entry.id, entry.file]));
    for (const id of NEW_FIREARMS) {
      const file = registry.get(id);
      expect(file, `${id} has no mesh in proceduralWeapons`).toBeTruthy();
      expect(WEAPONS[id].modelPath).toBe(proceduralWeaponPath(file ?? ''));
    }
    for (const id of NEW_MELEE) {
      const file = registry.get(id);
      expect(file, `${id} has no mesh in proceduralWeapons`).toBeTruthy();
      expect(MELEE[id].modelPath).toBe(proceduralWeaponPath(file ?? ''));
    }
    // No orphan entries either: every mesh the registry builds belongs to a real weapon.
    for (const entry of PROCEDURAL_WEAPONS) {
      const known = entry.kind === 'firearm' ? entry.id in WEAPONS : entry.id in MELEE;
      expect(known, entry.id).toBe(true);
    }
  });

  it('ships the exported glTF for every new weapon, with real geometry inside', () => {
    for (const entry of PROCEDURAL_WEAPONS) {
      const modelPath = entry.kind === 'firearm'
        ? WEAPONS[entry.id as WeaponId].modelPath
        : MELEE[entry.id as MeleeId].modelPath;
      const text = fileFor(modelPath);
      expect(text, `${entry.id} -> ${modelPath} is missing`).not.toBeNull();
      if (!text) continue;

      const gltf = JSON.parse(text) as {
        asset?: { version?: string };
        meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
        accessors?: Array<{ bufferView?: number; count?: number }>;
        bufferViews?: Array<{ byteLength?: number }>;
        buffers?: Array<{ uri?: string }>;
      };
      expect(gltf.asset?.version, entry.id).toBe('2.0');
      expect(gltf.meshes?.length ?? 0, entry.id).toBeGreaterThan(0);
      const primitive = gltf.meshes?.[0]?.primitives?.[0];
      expect(primitive?.attributes?.POSITION, entry.id).toBeTypeOf('number');
      const accessor = gltf.accessors?.[primitive?.attributes?.POSITION ?? 0];
      expect((gltf.bufferViews?.[accessor?.bufferView ?? 0]?.byteLength ?? 0) > 0, entry.id).toBe(true);
      expect(accessor?.count ?? 0, entry.id).toBeGreaterThan(0);
      // Self-contained like every other weapon file here: the buffer is embedded, so
      // nothing can 404 next to it.
      expect(gltf.buffers?.[0]?.uri ?? '', entry.id).toContain('base64,');
    }
  });

  it('builds a mesh with geometry in every one of them', () => {
    for (const entry of PROCEDURAL_WEAPONS) {
      const group = entry.build();
      expect(group.name, entry.id).toMatch(/^Weapon/);
      const meshes = meshesOf(group);
      expect(meshes.length, entry.id).toBeGreaterThan(1);
      for (const mesh of meshes) {
        const position = mesh.geometry.getAttribute('position');
        expect(position.count, entry.id).toBeGreaterThan(0);
        expect(Number.isFinite(position.getX(0)), entry.id).toBe(true);
      }
      // A weapon whose bounding box is empty or flat is one that renders as nothing on
      // screen, which no amount of type checking would catch.
      const box = new Box3().setFromObject(group);
      const size = box.getSize(new Vector3());
      expect(box.isEmpty(), entry.id).toBe(false);
      expect(Math.max(size.x, size.y, size.z), entry.id).toBeGreaterThan(0.3);
    }
  });

  it('parses through the GLTFLoader the runtime loads view models with', async () => {
    // The end of the chain that a browser check would otherwise be the only witness to:
    // the file the store and the view model both name actually loads, into a scene with
    // meshes in it. Anything less — a malformed accessor, an unresolvable buffer — would
    // show up in the game as a weapon that is simply not there.
    const loader = new GLTFLoader();
    for (const entry of PROCEDURAL_WEAPONS) {
      const modelPath = entry.kind === 'firearm'
        ? WEAPONS[entry.id as WeaponId].modelPath
        : MELEE[entry.id as MeleeId].modelPath;
      const text = fileFor(modelPath);
      expect(text, `${entry.id} -> ${modelPath} is missing`).not.toBeNull();

      const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
        loader.parse(text ?? '', '', resolve, reject);
      });
      let meshes = 0;
      gltf.scene.traverse((child) => {
        if ((child as Mesh).isMesh) meshes += 1;
      });
      expect(meshes, entry.id).toBeGreaterThan(1);
    }
  }, 30000);
});

/**
 * The hand-off, the same one `economy.test.ts` exercises for a bought weapon: a weapon that
 * is owned but cannot be put in the player's hands is not obtainable in any useful sense.
 */
describe('new weapons reaching the player', () => {
  function bareController(): WeaponController {
    const events = new EventBus<GameEvents>();
    const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
    // Only the camera and the bus are touched here; these casts stand in for systems that
    // would only be reached by firing, which these tests never do.
    return new WeaponController({
      camera,
      events,
      damage: {} as unknown as DamageSystem,
      player: {} as unknown as PlayerController,
      melee: {} as unknown as MeleeSystem,
    });
  }

  it('grants and draws each new firearm, with its own magazine', () => {
    for (const id of NEW_FIREARMS) {
      const weapons = bareController();
      expect(weapons.grantWeapon(id), id).toBe(true);
      // Idempotent: re-applying a saved loadout must not duplicate a slot.
      expect(weapons.grantWeapon(id), id).toBe(false);
      expect(weapons.ownedWeapons, id).toContain(id);
      expect(weapons.switchTo(id), id).toBe(true);
      expect(weapons.snapshot.weaponId, id).toBe(id);
      // The runtime the constructor builds for every weapon in the table is carrying this
      // one's magazine: 150 for the belt, not a fallback zero.
      expect(weapons.snapshot.magazine, id).toBe(WEAPONS[id].magazineSize);
      expect(weapons.snapshot.reserve, id).toBe(WEAPONS[id].startingReserve);
    }
  });

  it('carries and draws each new melee weapon', () => {
    for (const id of NEW_MELEE) {
      const weapons = bareController();
      weapons.setCarriedMelee(id);
      expect(weapons.activeMelee.id, id).toBe(id);
      expect(weapons.activeMelee.damage, id).toBe(MELEE[id].damage);
      expect(weapons.equipMelee(), id).toBe(true);
      expect(weapons.meleeReport.equipped, id).toBe(id);
      expect(weapons.isMeleeDrawn, id).toBe(true);
    }
  });
});
