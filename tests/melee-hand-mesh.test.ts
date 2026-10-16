import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { findCharacter } from '../src/app/characters';
import { CODE_BUILT_MELEE, MELEE, MELEE_BUNDLE_MESH, type MeleeId } from '../src/app/meleeConfig';
import { slungGearWeapon, type GearWeapon } from '../src/player/proceduralGear';
import { PROCEDURAL_WEAPONS } from '../src/player/proceduralWeapons';
import { PlayerAvatar } from '../src/player/PlayerAvatar';

/**
 * The third-person melee mesh, driven without a renderer.
 *
 * `PlayerAvatar` is pure three.js — clone, skeleton lookup, transform — so a stub body with
 * the bones and the bundled weapon meshes a survivor file ships is enough to exercise the
 * whole attachment path. What a browser would add is the picture; what it cannot add is a
 * second opinion on which mesh is switched on for which weapon, which is the gap this closes.
 *
 * The meshes are the project's own exported glTF: one test parses the real Katana.gltf through
 * the same loader the runtime uses, the rest build them from the same source they are
 * exported from, so the suite does not pay for five more file parses.
 */

/** `ProgressEvent` for Node, which GLTFLoader reports progress with and a test has none of. */
if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as unknown as { ProgressEvent: unknown }).ProgressEvent = class {
    readonly type: string;

    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
}

const MELEE_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** The four melee weapons the survivor files carry in hand space. */
const BUNDLED_MELEE: readonly MeleeId[] = ['knife', 'axe', 'barbed-bat', 'spear'];

/**
 * A body with the bones the icon pack uses and the weapon meshes its files bundle in.
 *
 * Mirrors what a real `Characters_*.gltf` contains: the whole inventory parented to
 * `Middle1.L` at the pack's own grip, plus the rifle the character holds.
 */
function stubSurvivorBody(): Group {
  const body = new Group();
  body.name = 'Body';
  const bones = new Map<string, Object3D>();
  for (const name of ['Torso', 'Middle1.L', 'Middle1.R', 'LowerArm.L', 'LowerArm.R']) {
    const bone = new Object3D();
    bone.name = name;
    body.add(bone);
    bones.set(name, bone);
  }
  // A bind pose with the elbow above the hand, which is the direction a carried tool hangs.
  bones.get('LowerArm.L')!.position.set(0.2, 1.3, 0);
  bones.get('Middle1.L')!.position.set(0, -0.3, 0);
  bones.get('LowerArm.R')!.position.set(-0.2, 1.3, 0);
  bones.get('Middle1.R')!.position.set(0, -0.3, 0);

  const hand = bones.get('Middle1.L')!;
  const rifle = new Mesh(new BoxGeometry(0.08, 0.12, 0.9));
  rifle.name = 'Rifle';
  hand.add(rifle);
  for (const id of BUNDLED_MELEE) {
    const mesh = new Mesh(new BoxGeometry(0.05, 0.05, 0.8));
    mesh.name = MELEE_BUNDLE_MESH[id];
    hand.add(mesh);
  }
  return body;
}

/** The code-built melee meshes keyed by id, from the same source the glTF is exported from. */
function codeBuiltMeshes(): Partial<Record<MeleeId, Object3D>> {
  const meshes: Partial<Record<MeleeId, Object3D>> = {};
  for (const entry of PROCEDURAL_WEAPONS) {
    if (entry.kind !== 'melee') continue;
    meshes[entry.id as MeleeId] = entry.build();
  }
  return meshes;
}

function avatarWith(
  body: Object3D,
  meshes: Partial<Record<MeleeId, Object3D>>,
): PlayerAvatar {
  return new PlayerAvatar({
    model: { scene: body, animations: [] },
    spec: findCharacter('jack'),
    anisotropy: 1,
    meleeHandMeshes: meshes,
  });
}

describe('the code-built melee ids', () => {
  it('names exactly the melee weapons the survivor bundle does not ship', () => {
    const bundled = new Set<string>(BUNDLED_MELEE);
    const expected = (Object.keys(MELEE) as MeleeId[]).filter((id) => !bundled.has(id)).sort();
    expect([...CODE_BUILT_MELEE].sort()).toEqual(expected);
    // And it is the same five the code builds: an id here with no mesh behind it would put
    // nothing in the hand, which is exactly the bug this list exists to prevent.
    const registry = PROCEDURAL_WEAPONS
      .filter((entry) => entry.kind === 'melee')
      .map((entry) => entry.id)
      .sort();
    expect([...CODE_BUILT_MELEE].sort()).toEqual(registry);
    // An id in both sets would put the same weapon in the fist twice.
    for (const id of CODE_BUILT_MELEE) expect(bundled.has(id), id).toBe(false);
  });
});

describe('melee mesh attached to the hand in third person', () => {
  it('pastes every code-built mesh onto the bone the file hangs its own weapons from', () => {
    const meshes = codeBuiltMeshes();
    const avatar = avatarWith(stubSurvivorBody(), meshes);
    const report = avatar.meleeWeaponReport;

    expect(report.handBone).toBe('Middle1.L');
    expect(report.handMeshSkipped).toEqual([]);
    expect([...report.handMeshes].sort()).toEqual([...CODE_BUILT_MELEE].sort());
    // The rig still has the four meshes it ships: attaching the new ones cost it nothing.
    expect([...report.bundleMeshes].sort()).toEqual([...BUNDLED_MELEE].sort());

    // And the meshes really hang off that bone, at the pack's grip — not merely recorded.
    const hand = avatar.root.getObjectByName('Middle1.L');
    expect(hand).toBeTruthy();
    for (const id of CODE_BUILT_MELEE) {
      expect(meshes[id]?.parent, id).toBe(hand);
      expect(meshes[id]?.visible, id).toBe(false);
    }
  });

  it('shows exactly one mesh for every melee weapon, old or new', () => {
    const meshes = codeBuiltMeshes();
    const avatar = avatarWith(stubSurvivorBody(), meshes);
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      avatar.setMeleeWeapon(id);
      const bundled = avatar.root.getObjectByName(MELEE_BUNDLE_MESH[id]);
      const shown = [bundled?.visible ?? false, meshes[id]?.visible ?? false];
      // One weapon in hand, never zero (the empty fist this closes) and never two.
      expect(shown.filter(Boolean).length, id).toBe(1);
    }
  });

  it('leaves the four bundled melee weapons exactly as they were', () => {
    const meshes = codeBuiltMeshes();
    const avatar = avatarWith(stubSurvivorBody(), meshes);
    for (const id of BUNDLED_MELEE) {
      avatar.setMeleeWeapon(id);
      expect(avatar.root.getObjectByName(MELEE_BUNDLE_MESH[id])?.visible, id).toBe(true);
      // No code-built mesh may stand in for a bundled weapon.
      expect(meshes[id], id).toBeUndefined();
    }
  });

  it('puts the firearm back and hides every melee mesh when the weapon is holstered', () => {
    const meshes = codeBuiltMeshes();
    const avatar = avatarWith(stubSurvivorBody(), meshes);
    avatar.setMeleeWeapon('katana');
    avatar.setMeleeWeapon(null);

    expect(avatar.root.getObjectByName('Rifle')?.visible).toBe(true);
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      expect(avatar.root.getObjectByName(MELEE_BUNDLE_MESH[id])?.visible ?? false, id).toBe(false);
    }
    for (const id of CODE_BUILT_MELEE) expect(meshes[id]?.visible, id).toBe(false);
  });

  it('never leaves the same tool on the back and in the hand at once', () => {
    const meshes = codeBuiltMeshes();
    const avatar = avatarWith(stubSurvivorBody(), meshes);
    const slung = (kind: GearWeapon): Object3D | undefined =>
      avatar.root.getObjectByName(kind === 'axe' ? 'GearAxe' : 'GearBat');

    // Jack carries an axe and a bat on his pack; nothing else is ever slung.
    expect(slung('axe')).toBeTruthy();
    expect(slung('bat')).toBeTruthy();

    for (const id of CODE_BUILT_MELEE) {
      avatar.setMeleeWeapon(id);
      expect(meshes[id]?.visible, id).toBe(true);
      // The slung twin of the drawn weapon is hidden; every other slung tool stays put.
      const twin = slungGearWeapon(id);
      for (const kind of ['axe', 'bat'] as GearWeapon[]) {
        expect(slung(kind)!.visible, `${id} / ${kind}`).toBe(kind !== twin);
      }
    }

    // The firefighter's axe is a different tool from Jack's slung fire axe: drawing it must
    // not take his axe off the pack.
    expect(slungGearWeapon('fire-axe')).toBeNull();
    avatar.setMeleeWeapon('fire-axe');
    expect(slung('axe')!.visible).toBe(true);
    expect(slung('bat')!.visible).toBe(true);
  });

  it('reports the gap instead of throwing on a rig with no hand bone', () => {
    const bare = new Group();
    const torso = new Mesh(new BoxGeometry(0.4, 1.2, 0.3));
    torso.name = 'NotABone';
    bare.add(torso);
    const avatar = avatarWith(bare, codeBuiltMeshes());

    const report = avatar.meleeWeaponReport;
    expect(report.handBone).toBeNull();
    expect(report.handMeshes).toEqual([]);
    expect(report.handMeshSkipped).toHaveLength(CODE_BUILT_MELEE.length);
    expect(report.handMeshSkipped.join(' ')).toMatch(/hand bone not found/);
  });

  it('attaches the mesh from the real exported glTF, through the runtime loader', async () => {
    // The one end of the chain a unit test would otherwise trust the config for: the file
    // the game loads for a code-built melee weapon is the file that ends up on the hand.
    const key = Object.keys(MELEE_FILES).find((candidate) => candidate.endsWith('/Katana.gltf'));
    expect(key, 'Katana.gltf is missing').toBeTruthy();
    const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
      new GLTFLoader().parse(MELEE_FILES[key ?? ''] ?? '', '', resolve, reject);
    });

    // Metre-scale, as a weapon in the character's hand has to be. `Game.normalizeViewModel`
    // scales every mesh to a 0.42 m on-screen length for first person, which is exactly why
    // the hand mesh is a separate, unnormalised copy: at 0.42 m a katana would be a letter
    // opener in the fist, and this measurement is what a regression would break.
    const size = new Box3().setFromObject(gltf.scene).getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    expect(longest).toBeGreaterThan(1);
    expect(longest).toBeLessThan(1.4);

    const avatar = avatarWith(stubSurvivorBody(), { katana: gltf.scene });
    expect(avatar.meleeWeaponReport.handBone).toBe('Middle1.L');
    expect(avatar.meleeWeaponReport.handMeshSkipped).toEqual([]);

    avatar.setMeleeWeapon('katana');
    expect(gltf.scene.parent).toBe(avatar.root.getObjectByName('Middle1.L'));
    expect(gltf.scene.visible).toBe(true);
    expect(avatar.root.getObjectByName(MELEE_BUNDLE_MESH.knife)?.visible).toBe(false);
  }, 30000);
});
