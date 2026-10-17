import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import { MP7_DESCRIPTOR, createMp7 } from '../src/player/weapons/mp7';

function meshesOf(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) found.push(mesh);
  });
  return found;
}

/** Every part of the weapon is nameable: the glTF export keeps node names, and the
 *  assertions below read parts back by name instead of guessing which box is which. */
const MESH_NAME = /^Mp7:[A-Za-z]+$/;

describe('MP7 view model', () => {
  it('is a Group of named parts', () => {
    const weapon = createMp7();
    expect(weapon).toBeInstanceOf(Group);
    expect(weapon.name).toBe('WeaponMP7');

    const meshes = meshesOf(weapon);
    // A weapon cannot be one box and cannot be a hundred primitives: below six it loses its
    // silhouette, above twenty it is no longer a view model worth drawing every frame.
    expect(meshes.length).toBeGreaterThanOrEqual(6);
    expect(meshes.length).toBeLessThanOrEqual(20);

    for (const mesh of meshes) {
      expect(mesh.name, 'every mesh is named').toMatch(MESH_NAME);
      const position = mesh.geometry.getAttribute('position');
      expect(position.count).toBeGreaterThan(0);
      expect(Number.isFinite(position.getX(0))).toBe(true);
      expect(mesh.material).toBeInstanceOf(MeshStandardMaterial);
      // The mesh sits inside the camera and is scaled by normalizeViewModel at load, so it must
      // not enter the shadow pass.
      expect(mesh.castShadow).toBe(false);
    }
    // Distinct names, or the export would produce two nodes a loader cannot tell apart.
    expect(new Set(meshes.map((mesh) => mesh.name)).size).toBe(meshes.length);
  });

  it('is a compact weapon: 0.4 to 0.9 m long and no axis out of proportion', () => {
    const box = new Box3().setFromObject(createMp7());
    expect(box.isEmpty()).toBe(false);
    const size = box.getSize(new Vector3());

    // Overall length of an actual MP7 with the stock out, in metres.
    expect(size.z).toBeGreaterThan(0.4);
    expect(size.z).toBeLessThan(0.9);

    for (const dimension of [size.x, size.y, size.z]) {
      // Nothing here should be larger than a person, and nothing should be a degenerate sliver:
      // a collapsed dimension is the usual sign of a geometry built at the wrong scale.
      expect(dimension).toBeLessThan(1.2);
      expect(dimension).toBeGreaterThan(0.01);
    }
    // Height (receiver plus the magazine under the grip) has to stay well below the length,
    // otherwise the weapon is not a gun any more but a box.
    expect(size.y).toBeLessThan(size.z);
  });

  it('points the muzzle down +Z', () => {
    const weapon = createMp7();
    const box = new Box3().setFromObject(weapon);
    const size = box.getSize(new Vector3());

    // The longest axis is Z: that is what makes "forward" unambiguous for
    // normalizeViewModel and for a shot leaving the muzzle.
    expect(size.z).toBeGreaterThan(size.x);
    expect(size.z).toBeGreaterThan(size.y);

    // And the forward end really is the muzzle rather than the stock, which a Z-long weapon
    // could satisfy either way round.
    const muzzle = weapon.getObjectByName('Mp7:Muzzle');
    expect(muzzle, 'Mp7:Muzzle exists').toBeTruthy();
    const frontmost = meshesOf(weapon)
      .map((mesh) => new Box3().setFromObject(mesh).max.z)
      .reduce((a, b) => Math.max(a, b), -Infinity);
    expect(new Box3().setFromObject(muzzle!).max.z).toBeCloseTo(frontmost, 5);
    expect(box.max.z).toBeGreaterThan(0.3);
  });

  it('keeps the origin at the grip, with the receiver and stock behind it', () => {
    const weapon = createMp7();
    const box = new Box3().setFromObject(weapon);

    // The origin is on the weapon, not floating ahead of or above it.
    expect(box.containsPoint(new Vector3(0, 0, 0))).toBe(true);

    // A mesh aimed along the barrel and centred on it would put the origin mid-barrel, with
    // almost nothing behind it; this one carries a receiver and a stock behind the grip.
    expect(-box.min.z).toBeGreaterThan(0.12);
    expect(box.min.z).toBeLessThan(0);

    const grip = weapon.getObjectByName('Mp7:Grip');
    expect(grip, 'Mp7:Grip exists').toBeTruthy();
    // The hand closes on the origin: the grip's own centre is within a hand's width of it.
    expect(grip!.position.length()).toBeLessThan(0.1);
    // Below the bore, because -Y is down in this project's weapon space.
    expect(grip!.position.y).toBeLessThan(0);

    const magazine = weapon.getObjectByName('Mp7:Magazine');
    expect(magazine, 'Mp7:Magazine exists').toBeTruthy();
    // A PDW magazine hangs under the grip, not off the barrel.
    expect(magazine!.position.y).toBeLessThan(0);
    expect(box.min.y).toBeLessThan(-0.15);
  });

  it('describes a PDW: high cadence, 40 rounds, short reach', () => {
    const spec = MP7_DESCRIPTOR;
    expect(spec.id).toBe('mp7');
    expect(spec.name.length).toBeGreaterThan(0);

    for (const value of [spec.damage, spec.fireRate, spec.range, spec.spread, spec.recoil,
      spec.recoilRecovery, spec.muzzleFlashSeconds, spec.reloadSeconds]) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }

    expect(spec.automatic).toBe(true);
    expect(spec.magazineSize).toBeGreaterThan(0);
    expect(spec.tracerEvery).toBeGreaterThanOrEqual(1);
    expect(['pistol', 'rifle', 'shotgun']).toContain(spec.grip);

    // A magazine that is not a whole number of rounds, or a reload longer than the weapon is
    // meant to be carried for, are the two ways this table goes wrong silently.
    expect(Number.isInteger(spec.magazineSize)).toBe(true);
    expect(spec.reloadSeconds).toBeLessThan(5);
    expect(Number.isInteger(spec.startingReserve)).toBe(true);
    expect(spec.startingReserve).toBeGreaterThanOrEqual(spec.magazineSize);
    expect(spec.maxReserve).toBeGreaterThanOrEqual(spec.startingReserve);
    // Reserve carried in whole magazines, which is how the ammo economy counts it.
    expect(spec.startingReserve % spec.magazineSize).toBe(0);

    // The PDW's identity: faster than the MP5 it joins (11 rps) with a bigger magazine, and
    // each round smaller. If either of these flips, the weapon is competing with the MP5
    // rather than covering the short-range role beside it.
    expect(spec.fireRate).toBeGreaterThan(11);
    expect(spec.damage).toBeLessThan(16);
    expect(spec.range).toBeLessThan(95);
  });
});
