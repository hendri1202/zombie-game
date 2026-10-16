import { describe, expect, it } from 'vitest';
import { Box3, Group, Object3D, Quaternion, Vector3 } from 'three';
import {
  PACK_HAND_PLACEMENT, alignToForearm, attachGear, createAxe, createBackpack, createBandolier,
  createBarbedBat, placeInHand,
} from '../src/player/proceduralGear';
import { CHARACTERS, findCharacter } from '../src/app/characters';

function meshesOf(root: Object3D): import('three').Mesh[] {
  const found: import('three').Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as import('three').Mesh;
    if (mesh.isMesh) found.push(mesh);
  });
  return found;
}

function bounds(root: Object3D): Box3 {
  const box = new Box3();
  root.updateMatrixWorld(true);
  box.setFromObject(root);
  return box;
}

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

describe('procedural gear', () => {
  it('builds every part with finite geometry and no NaN vertices', () => {
    for (const build of [createAxe, createBarbedBat, createBackpack, createBandolier]) {
      const group = build();
      const meshes = meshesOf(group);
      expect(meshes.length).toBeGreaterThan(0);
      for (const mesh of meshes) {
        const position = mesh.geometry.getAttribute('position');
        expect(position.count).toBeGreaterThan(0);
        for (let index = 0; index < position.count; index += 1) {
          expect(Number.isFinite(position.getX(index))).toBe(true);
          expect(Number.isFinite(position.getY(index))).toBe(true);
          expect(Number.isFinite(position.getZ(index))).toBe(true);
        }
      }
      const box = bounds(group);
      expect(box.isEmpty()).toBe(false);
    }
  });

  it('makes the axe long on +Z, lightly built, and painted red', () => {
    const box = bounds(createAxe());
    const size = box.getSize(new Vector3());
    // Model units are metres, so an axe should come out at a real fire axe's length:
    // long enough to be a tool, short enough not to drag. A symmetrical build would
    // not read as an axe in the fist at all.
    expect(size.z).toBeGreaterThan(0.85);
    expect(size.z).toBeLessThan(1.05);
    expect(size.z).toBeGreaterThan(size.x);
    expect(size.z).toBeGreaterThan(size.y);

    const reds = meshesOf(createAxe()).filter((mesh) => {
      const material = mesh.material as import('three').MeshStandardMaterial;
      const colour = material.color;
      // Material colours land in linear space, so a saturated sRGB red arrives near
      // 0.40 rather than 0.66: assert dominance over the other channels, not a raw value.
      return colour.r > 0.15 && colour.r > colour.g * 5 && colour.r > colour.b * 5;
    });
    expect(reds.length).toBeGreaterThanOrEqual(2);
  });

  it('wraps the bat in wire rings along a tapered barrel', () => {
    const meshes = meshesOf(createBarbedBat());
    const rings = meshes.filter((mesh) => mesh.geometry.type === 'TorusGeometry');
    const barbs = meshes.filter((mesh) => mesh.geometry.type === 'ConeGeometry');
    expect(rings.length).toBeGreaterThanOrEqual(5);
    expect(barbs.length).toBeGreaterThanOrEqual(rings.length);
    const size = bounds(createBarbedBat()).getSize(new Vector3());
    expect(size.z).toBeGreaterThan(size.x);
    // A real bat is about 0.85 m; the raw build is 1.24 m, which reached the ground
    // when it hung from a relaxed hand.
    expect(size.z).toBeGreaterThan(0.8);
    expect(size.z).toBeLessThan(0.95);
  });

  it('hangs the pack on the back and the shells across the chest', () => {
    const back = bounds(createBackpack());
    const front = bounds(createBandolier());
    // The pack's bodies face +Z, so a pack hangs at negative Z (its shoulder straps
    // legitimately reach forward, but it must reach further back than forward) and the
    // bandolier crosses the chest at positive Z. Swapping them buries one in the torso.
    expect(back.min.z).toBeLessThan(-0.2);
    expect(Math.abs(back.min.z)).toBeGreaterThan(back.max.z);
    expect(front.min.z).toBeGreaterThan(0);
  });

  it('mirrors the pack hand placement for the right hand', () => {
    const left = new Object3D();
    const right = new Object3D();
    placeInHand(left, new Group(), false);
    placeInHand(right, new Group(), true);
    const leftWeapon = left.children[0];
    const rightWeapon = right.children[0];

    expect(leftWeapon.position.x).toBeCloseTo(PACK_HAND_PLACEMENT.translation[0], 6);
    expect(rightWeapon.position.x).toBeCloseTo(-PACK_HAND_PLACEMENT.translation[0], 6);
    // Y and Z of the quaternion are what the rig mirrors; a weapon that skipped this
    // lands upside down behind the hand.
    expect(rightWeapon.quaternion.y).toBeCloseTo(-PACK_HAND_PLACEMENT.rotation[1], 6);
    expect(rightWeapon.quaternion.z).toBeCloseTo(-PACK_HAND_PLACEMENT.rotation[2], 6);
    expect(rightWeapon.quaternion.w).toBeCloseTo(PACK_HAND_PLACEMENT.rotation[3], 6);
  });

  it('turns a carried weapon to hang down the forearm', () => {
    const forearm = new Object3D();
    forearm.position.set(0, 1.2, 0);
    const hand = new Object3D();
    // The hand sits *below* the elbow in the forearm's own space, which is the
    // direction a carried tool hangs. Putting it above flips the expectation, not
    // the behaviour.
    hand.position.set(0, -0.3, 0);
    forearm.add(hand);
    const weapon = new Group();
    hand.add(weapon);
    // Start from the pack's own grip rotation, i.e. the state that aims up and back
    // once the arms drop, which is what the alignment has to correct.
    weapon.quaternion.set(
      PACK_HAND_PLACEMENT.rotation[0], PACK_HAND_PLACEMENT.rotation[1],
      PACK_HAND_PLACEMENT.rotation[2], PACK_HAND_PLACEMENT.rotation[3],
    );

    expect(alignToForearm(hand, weapon, forearm, 0)).toBe(true);
    const forward = new Vector3(0, 0, 1)
      .applyQuaternion(weapon.getWorldQuaternion(new Quaternion()))
      .normalize();
    expect(forward.y).toBeCloseTo(-1, 5);
    expect(Math.abs(forward.x)).toBeLessThan(1e-5);

    // The tilt tips the far end towards the character's forward axis (+Z here, since
    // the stub's root has no rotation) instead of spinning around a local axis.
    const tilted = new Group();
    hand.add(tilted);
    expect(alignToForearm(hand, tilted, forearm, 0.6)).toBe(true);
    const tipped = new Vector3(0, 0, 1)
      .applyQuaternion(tilted.getWorldQuaternion(new Quaternion()))
      .normalize();
    expect(tipped.y).toBeGreaterThan(forward.y);
    expect(tipped.z).toBeGreaterThan(0.3);

    // No forearm bone on another pack's rig: the pack's own grip rotation stands.
    expect(alignToForearm(hand, new Group(), null)).toBe(false);
  });

  it('attaches everything when the body has the bones, and reports when it does not', () => {
    const body = stubBody(['Middle1.L', 'Middle1.R', 'Torso']);
    const report = attachGear(body, { rightHand: 'axe', leftHand: 'bat', backpack: true, bandolier: true });
    expect(report.skipped).toEqual([]);
    expect(report.attached).toHaveLength(4);
    expect(body.getObjectByName('Torso')?.children.map((child) => child.name).sort())
      .toEqual(['GearBackpack', 'GearBandolier']);

    const bare = stubBody([]);
    const missing = attachGear(bare, { rightHand: 'axe', backpack: true });
    expect(missing.attached).toEqual([]);
    expect(missing.skipped).toHaveLength(2);
    expect(missing.skipped.join(' ')).toMatch(/bone not found/);
  });
});

describe('Jack', () => {
  it('is on the roster carrying code-built gear instead of a bundled weapon', () => {
    const jack = findCharacter('jack');
    expect(jack.id).toBe('jack');
    expect(jack.weaponMesh).toBeNull();
    expect(jack.gear).toEqual({ rightHand: 'axe', leftHand: 'bat', backpack: true, bandolier: true });
  });

  it('uses the plain locomotion clips, not the gun-holding ones', () => {
    const jack = findCharacter('jack');
    for (const candidates of [jack.clips.idle, jack.clips.walk, jack.clips.run]) {
      expect(candidates.every((clip) => !clip.includes('Gun'))).toBe(true);
    }
    // The gun clips pin both hands into a rifle grip; with an axe in one hand and a
    // bat in the other that stacks the two weapons on top of each other.
    const others = CHARACTERS.filter((character) => character.id !== 'jack');
    expect(others.every((character) => character.clips.walk.some((clip) => clip.includes('Gun')))).toBe(true);
  });
});
