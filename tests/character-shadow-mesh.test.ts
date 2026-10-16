import { describe, expect, it } from 'vitest';
import { Group, Mesh, Object3D } from 'three';
import { isDrawn, setSubtreeShadows } from '../src/utils/characterGeometry';

/**
 * The two rules the avatar audit and the held-weapon shadow fix rest on.
 *
 * Neither needs a renderer: one is a walk up the parent chain, the other a walk down a subtree.
 * Both were the missing half of a reported defect — the audit counted mesh flags (so 37 hidden
 * weapon meshes read as drawn), and the shadow fix wrote a flag onto glTF groups (so a drawn
 * katana cast nothing).
 */

/** A fake avatar: the root, an optional switched-off group under it, and meshes inside. */
function tree(groupVisible: boolean): { root: Object3D; group: Group; meshes: Mesh[] } {
  const root = new Object3D();
  root.name = 'Avatar';
  const group = new Group();
  group.name = 'WeaponKatana';
  group.visible = groupVisible;
  root.add(group);
  const meshes: Mesh[] = [];
  for (let i = 0; i < 3; i += 1) {
    const mesh = new Mesh();
    mesh.name = `part${i}`;
    group.add(mesh);
    meshes.push(mesh);
  }
  const nested = new Group();
  nested.name = 'Beam';
  group.add(nested);
  const deep = new Mesh();
  deep.name = 'core';
  nested.add(deep);
  meshes.push(deep);
  return { root, group, meshes };
}

describe('isDrawn reads visibility the way the renderer does', () => {
  it('counts a mesh inside a switched-off group as not drawn, whatever its own flag says', () => {
    const { root, meshes } = tree(false);
    for (const mesh of meshes) {
      // The flag alone is what the audit used to read: it says the opposite of the truth here.
      expect(mesh.visible).toBe(true);
      expect(isDrawn(mesh, root)).toBe(false);
    }
  });

  it('counts the same meshes as drawn once the group is switched on', () => {
    const { root, group, meshes } = tree(false);
    group.visible = true;
    for (const mesh of meshes) expect(isDrawn(mesh, root)).toBe(true);
  });

  it('stops at the frame of reference, so hiding the whole avatar changes nothing', () => {
    // Hiding the avatar is a first-person frame, not a change to what the character is made of.
    const { root, meshes } = tree(true);
    root.visible = false;
    for (const mesh of meshes) expect(isDrawn(mesh, root)).toBe(true);
  });

  it('reports a mesh that is not part of the avatar at all as not drawn', () => {
    const { root } = tree(true);
    const stray = new Mesh();
    expect(isDrawn(stray, root)).toBe(false);
  });
});

describe('setSubtreeShadows reaches every mesh, not just the root', () => {
  it('sets the flags on all five meshes of a group, nested ones included', () => {
    const { group, meshes } = tree(true);
    setSubtreeShadows(group, true);
    for (const mesh of meshes) {
      expect(mesh.castShadow, mesh.name).toBe(true);
      expect(mesh.receiveShadow, mesh.name).toBe(true);
    }
  });

  it('clears them again, so a holstered weapon casts nothing', () => {
    const { group, meshes } = tree(true);
    setSubtreeShadows(group, true);
    setSubtreeShadows(group, false);
    for (const mesh of meshes) {
      expect(mesh.castShadow, mesh.name).toBe(false);
      expect(mesh.receiveShadow, mesh.name).toBe(false);
    }
  });
});
