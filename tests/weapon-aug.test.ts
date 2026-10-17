import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, Object3D, Vector3 } from 'three';
import { AUG_DESCRIPTOR, createAug } from '../src/player/weapons/aug';
import { HANDS_PLACEMENT } from '../src/player/proceduralArms';
import { WEAPONS } from '../src/app/gameConfig';

/**
 * The AUG is defined by its layout, not by its name: a bullpup puts the magazine *behind*
 * the pistol grip so the barrel can stay long while the weapon stays short. A test that
 * only checked "a magazine mesh exists" would pass on a conventional rifle with the part
 * simply renamed, so these tests measure the geometry: part counts, the bounding box, the
 * longest axis, and — the load-bearing one — the position of the magazine box relative to
 * the grip and to the muzzle.
 *
 * No DOM, no renderer: `Box3.setFromObject` needs only the object graph, which is exactly
 * what can be verified here without a browser (browser harnesses are out of scope on this
 * host).
 */

function meshesOf(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((child) => {
    if ((child as Mesh).isMesh) found.push(child as Mesh);
  });
  return found;
}

function boxOf(object: Object3D): Box3 {
  object.updateMatrixWorld(true);
  return new Box3().setFromObject(object);
}

function named(group: Group, name: string): Mesh {
  const mesh = meshesOf(group).find((candidate) => candidate.name === name);
  expect(mesh, `the AUG has no mesh named "${name}"`).toBeTruthy();
  if (!mesh) throw new Error(`missing mesh ${name}`);
  return mesh;
}

describe('AUG mesh', () => {
  it('builds a group of named, non-empty parts', () => {
    const group = createAug();
    expect(group.name).toBe('WeaponAUG');

    const meshes = meshesOf(group);
    // Enough parts to read as a rifle (body, barrel, optic, grips, stock, magazine), but
    // not a soup of dozens of boxes.
    expect(meshes.length).toBeGreaterThanOrEqual(6);
    expect(meshes.length).toBeLessThanOrEqual(20);

    for (const mesh of meshes) {
      // A part with no name could not be found by the layout tests below, and a part with
      // no vertices renders as nothing.
      expect(mesh.name, 'every AUG part must be named').not.toBe('');
      expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(0);
    }
  });

  it('is rifle-length with its longest axis running towards the muzzle (+Z)', () => {
    const size = boxOf(createAug()).getSize(new Vector3());
    // Total length sits in the "short carbine" band: a rifle, but the bullpup keeps it
    // under a metre.
    expect(size.z).toBeGreaterThanOrEqual(0.6);
    expect(size.z).toBeLessThanOrEqual(1.0);
    // The longest axis must be Z, or the weapon would be lying across its own sights.
    expect(size.z).toBeGreaterThan(size.x);
    expect(size.z).toBeGreaterThan(size.y);
  });

  it('places the magazine behind the grip and near the origin, not out at the muzzle', () => {
    const group = createAug();
    const magazine = boxOf(named(group, 'AugMagazine'));
    const grip = boxOf(named(group, 'AugPistolGrip'));
    const muzzle = boxOf(named(group, 'AugMuzzleBrake'));

    const magazineCentre = magazine.getCenter(new Vector3());
    const gripCentre = grip.getCenter(new Vector3());

    // The grip defines the origin: if it drifted, every measurement below would be off.
    expect(Math.abs(gripCentre.z)).toBeLessThan(0.06);

    // The bullpup tell, measured rather than assumed: the entire magazine box sits at
    // negative Z, behind the origin the grip owns.
    expect(magazine.max.z).toBeLessThan(0);
    // Stronger still: it is behind the grip's own rear face, not merely behind its centre.
    expect(magazine.max.z).toBeLessThan(grip.min.z);

    // And it is far closer to the origin than the muzzle is — the round is fed behind the
    // trigger, which is what frees the length in front of it for the barrel.
    const muzzleTip = muzzle.max.z;
    expect(muzzleTip).toBeGreaterThan(0.5);
    expect(Math.abs(magazineCentre.z)).toBeLessThan(muzzleTip * 0.5);
  });
});

describe('AUG descriptor', () => {
  it('declares the per-weapon settings the runtime reads', () => {
    const d = AUG_DESCRIPTOR;
    expect(d.id).toBe('aug');
    expect(d.name.length).toBeGreaterThan(0);
    expect(d.automatic).toBe(true);
    expect(d.magazineSize).toBeGreaterThan(0);
    expect(d.startingReserve).toBeGreaterThan(0);
    expect(d.maxReserve).toBeGreaterThanOrEqual(d.startingReserve);
    expect(d.damage).toBeGreaterThan(0);
    expect(d.fireRate).toBeGreaterThan(0);
    expect(d.range).toBeGreaterThan(0);
    expect(d.spread).toBeGreaterThan(0);
    expect(d.recoil).toBeGreaterThan(0);
    expect(d.recoilRecovery).toBeGreaterThan(0);
    expect(d.muzzleFlashSeconds).toBeGreaterThan(0);
    expect(d.tracerEvery).toBeGreaterThanOrEqual(1);
    // A bullpup reload is not instant, but it is a rifle, not a belt-fed gun.
    expect(d.reloadSeconds).toBeGreaterThan(0);
    expect(d.reloadSeconds).toBeLessThan(5);
  });

  it('declares a grip the hands actually have a pose for', () => {
    // 'rifle' is the shoulder-stocked pose; anything else would be a typo the runtime
    // only fails on at the first frame the weapon is raised.
    expect(['pistol', 'rifle', 'shotgun']).toContain(AUG_DESCRIPTOR.grip);
    expect(HANDS_PLACEMENT[AUG_DESCRIPTOR.grip]).toBeTruthy();
  });

  it('hits harder and reaches further than the submachine gun it sits above', () => {
    // The stated intent of the stat line: a 5.56 rifle out-damages the MP5 and out-ranges
    // it, which is the trade for the slower cadence.
    expect(AUG_DESCRIPTOR.damage).toBeGreaterThan(WEAPONS.mp5.damage);
    expect(AUG_DESCRIPTOR.range).toBeGreaterThan(WEAPONS.mp5.range);
    expect(AUG_DESCRIPTOR.fireRate).toBeLessThan(WEAPONS.mp5.fireRate);
  });
});
