import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, Object3D, Vector3 } from 'three';
import {
  REMINGTON870_DESCRIPTOR, REMINGTON870_PUMP_MESH, createRemington870,
} from '../src/player/weapons/remington870';
import { createLmg } from '../src/player/proceduralWeapons';
import { HANDS_PLACEMENT } from '../src/player/proceduralArms';
import { WEAPONS } from '../src/app/gameConfig';

/**
 * The 870 is defined by its plumbing, not by its name: what makes it a pump gun rather than
 * a rifle is a magazine *tube* running under the barrel with the forend sliding on it. A
 * test that only checked "a part is named ...Forend" would pass on any gun with a part
 * renamed, so the load-bearing assertions here measure the geometry: the bounding box and its
 * longest axis, the pump's existence as a part of its own below the bore line, and — the one
 * the task singled out — the tube's centre sitting *below* the barrel's, measured from the
 * two meshes' own boxes rather than from a copied offset.
 *
 * No DOM, no renderer: `Box3.setFromObject` needs only the object graph, which is what can
 * be verified on this host (browser harnesses are out of scope here).
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
  expect(mesh, `the 870 has no mesh named "${name}"`).toBeTruthy();
  if (!mesh) throw new Error(`missing mesh ${name}`);
  return mesh;
}

/** Vertical and longitudinal extents of one named part, with the mesh itself asserted. */
function partBox(group: Group, name: string): { box: Box3; centre: Vector3; size: Vector3 } {
  const box = boxOf(named(group, name));
  return { box, centre: box.getCenter(new Vector3()), size: box.getSize(new Vector3()) };
}

describe('Remington 870 mesh', () => {
  it('builds a group of named, non-empty parts', () => {
    const group = createRemington870();
    expect(group.name).toBe('WeaponRemington870');

    const meshes = meshesOf(group);
    // Enough parts to read as a pump gun (receiver, barrel, tube, cap, band, forend, stock,
    // trigger group), but not a soup of dozens of boxes.
    expect(meshes.length).toBeGreaterThanOrEqual(8);
    expect(meshes.length).toBeLessThanOrEqual(25);

    const names = new Set<string>();
    for (const mesh of meshes) {
      // A part with no name could not be found by the layout tests below, and a part with
      // no vertices renders as nothing.
      expect(mesh.name, 'every 870 part must be named').not.toBe('');
      expect(names.has(mesh.name), `duplicate part name "${mesh.name}"`).toBe(false);
      names.add(mesh.name);

      const position = mesh.geometry.getAttribute('position');
      expect(position.count).toBeGreaterThan(0);
      for (let index = 0; index < position.count; index += 1) {
        // A single NaN vertex poisons the bounding box, which would make every measurement
        // below meaningless rather than failing loudly.
        expect(Number.isFinite(position.getX(index))).toBe(true);
        expect(Number.isFinite(position.getY(index))).toBe(true);
        expect(Number.isFinite(position.getZ(index))).toBe(true);
      }
    }
  });

  it('is a long gun on +Z with the muzzle forward and the butt behind the origin', () => {
    const group = createRemington870();
    const box = boxOf(group);
    const size = box.getSize(new Vector3());

    // Overall length sits in the long field-gun band: a 26 in 870 is ~1.15 m, well past the
    // metre mark the task asked for and inside the band the mesh has to stay in.
    expect(size.z).toBeGreaterThan(0.8);
    expect(size.z).toBeLessThan(1.3);
    // The longest axis must be Z, or the weapon would be lying across its own sights.
    expect(size.z).toBeGreaterThan(size.x);
    expect(size.z).toBeGreaterThan(size.y);

    // The convention, measured: +Z runs towards the muzzle, so the front of the box is the
    // barrel's muzzle and the rear is the stock — and the origin (the shooting hand) is
    // inside the weapon rather than hanging off one end of it.
    const muzzle = partBox(group, 'Remington870Barrel');
    expect(muzzle.box.max.z).toBeCloseTo(box.max.z, 6);
    expect(muzzle.box.max.z).toBeGreaterThan(0.5);
    expect(partBox(group, 'Remington870ButtPlate').box.min.z).toBeCloseTo(box.min.z, 6);
    expect(box.min.z).toBeLessThan(0);
    expect(box.max.y).toBeGreaterThan(0);
    expect(box.min.y).toBeLessThan(0);

    // Longest in the roster, measured against the meshes the roster already ships rather
    // than asserted in prose: the belt-fed LMG is the previous longest at 1.09 m.
    const lmgLength = boxOf(createLmg()).getSize(new Vector3()).z;
    expect(size.z).toBeGreaterThan(lmgLength);
  });

  it('puts the magazine tube under the barrel, not beside or behind it', () => {
    const group = createRemington870();
    const tube = partBox(group, 'Remington870MagazineTube');
    const barrel = partBox(group, 'Remington870Barrel');

    // The measurement the task asked for, from the two meshes' own boxes: the tube's centre
    // is lower than the barrel's. -Y is down in this project's convention.
    expect(tube.centre.y).toBeLessThan(barrel.centre.y);
    // Stronger than the centres: the whole tube clears the bore, so the two are stacked
    // rather than interpenetrating — which is what a tube magazine looks like and what a
    // coincidentally-lower part would not.
    expect(tube.box.max.y).toBeLessThan(barrel.box.min.y);
    // And it is parallel underneath for most of the barrel's length, not tucked behind it.
    expect(tube.box.max.z).toBeGreaterThan(barrel.box.min.z);
    expect(tube.box.min.z).toBeLessThan(barrel.box.max.z);
    expect(tube.size.z).toBeGreaterThan(barrel.size.z * 0.5);
    // Both run on the weapon's centre line, so the tube is under the barrel and not off to
    // one side of it.
    expect(Math.abs(tube.centre.x)).toBeLessThan(0.005);
    expect(Math.abs(barrel.centre.x)).toBeLessThan(0.005);
  });

  it('has a pump forend of its own, forward of the receiver and clear of the bore line', () => {
    const group = createRemington870();
    const pump = partBox(group, REMINGTON870_PUMP_MESH);
    const barrel = partBox(group, 'Remington870Barrel');
    const receiver = partBox(group, 'Remington870Receiver');
    const tube = partBox(group, 'Remington870MagazineTube');

    // Named and separate: the mechanism rig slides this one mesh, so it must not be merged
    // into the receiver or the barrel.
    expect(named(group, REMINGTON870_PUMP_MESH).name).toMatch(/Forend|Pump/);

    // Forward of the receiver: a pump sits in front of the trigger group, where the support
    // hand reaches — a forend at the receiver would be a handguard on a rifle.
    expect(pump.box.min.z).toBeGreaterThan(receiver.box.max.z);
    // Below the bore line and below the barrel, wrapping the tube.
    expect(pump.centre.y).toBeLessThan(barrel.centre.y);
    expect(pump.box.max.y).toBeLessThan(barrel.centre.y);
    // Clear of the muzzle end, and long enough to be grabbed rather than a token block.
    expect(pump.box.max.z).toBeLessThan(barrel.box.max.z);
    expect(pump.size.z).toBeGreaterThan(0.1);
    // It overlaps the tube along Z: the tube is what it slides on.
    expect(pump.box.min.z).toBeLessThan(tube.box.max.z);
    expect(pump.box.max.z).toBeGreaterThan(tube.box.min.z);

    // The barrel band is in front of it, which is where an 870's band clamps the tube on.
    expect(partBox(group, 'Remington870BarrelBand').box.min.z).toBeGreaterThan(pump.box.max.z);
  });
});

describe('Remington 870 descriptor', () => {
  it('declares the per-weapon settings the runtime reads', () => {
    const d = REMINGTON870_DESCRIPTOR;
    expect(d.id).toBe('remington-870');
    expect(d.name.length).toBeGreaterThan(0);
    // A pump gun is never automatic — the forend has to be worked between shots.
    expect(d.automatic).toBe(false);
    // Shotgun, not a rifle: a shell carries several projectiles.
    expect(d.pellets).toBeGreaterThanOrEqual(2);
    expect(d.damage).toBeGreaterThan(0);
    expect(d.magazineSize).toBeGreaterThan(0);
    expect(d.startingReserve).toBeGreaterThan(0);
    expect(d.maxReserve).toBeGreaterThanOrEqual(d.startingReserve);
    expect(d.fireRate).toBeGreaterThan(0);
    expect(d.range).toBeGreaterThan(0);
    expect(d.spread).toBeGreaterThan(0);
    expect(d.recoil).toBeGreaterThan(0);
    expect(d.recoilRecovery).toBeGreaterThan(0);
    expect(d.muzzleFlashSeconds).toBeGreaterThan(0);
    // 0 would be a division by zero in the tracer counter, not a "never".
    expect(d.tracerEvery).toBeGreaterThanOrEqual(1);
    expect(d.reloadSeconds).toBeGreaterThan(0);
    // One shell per stroke, so a pump cadence lies between an automatic's and a
    // bolt-action's: under two seconds per shot and not faster than a semi.
    expect(1 / d.fireRate).toBeGreaterThan(0.8);
    expect(1 / d.fireRate).toBeLessThan(2);
  });

  it('declares a grip the hands actually have a pose for', () => {
    // The sliding forend needs the two-handed shotgun hold; anything else is a typo the
    // runtime only fails on at the first frame the weapon is raised.
    expect(['pistol', 'rifle', 'shotgun']).toContain(REMINGTON870_DESCRIPTOR.grip);
    expect(HANDS_PLACEMENT[REMINGTON870_DESCRIPTOR.grip]).toBeTruthy();
    expect(REMINGTON870_DESCRIPTOR.grip).toBe('shotgun');
  });

  it('is the longer-reaching pump gun, and pays for it in cadence and reload', () => {
    // Measured against the short pump shotgun already on the shelf, because that is the
    // weapon the numbers were chosen against: the intent is a trade, not a strict upgrade.
    const short = WEAPONS.shotgun;

    // Same shell, so the same pellet count and the same wide cone — a shotgun stays a
    // shotgun. The barrel buys reach, not a tighter choke than the load can use.
    expect(REMINGTON870_DESCRIPTOR.pellets).toBe(short.pellets);
    // Heavier payload and longer reach: the point of the long barrel.
    expect(REMINGTON870_DESCRIPTOR.damage).toBeGreaterThan(short.damage);
    expect(REMINGTON870_DESCRIPTOR.range).toBeGreaterThan(short.range);
    // Tighter pattern at that longer range, and one more shell in the tube.
    expect(REMINGTON870_DESCRIPTOR.spread).toBeLessThan(short.spread);
    expect(REMINGTON870_DESCRIPTOR.magazineSize).toBeGreaterThan(short.magazineSize);
    // The price: a slower stroke and more shells to hand-feed down the same tube.
    expect(REMINGTON870_DESCRIPTOR.fireRate).toBeLessThan(short.fireRate);
    expect(REMINGTON870_DESCRIPTOR.reloadSeconds).toBeGreaterThan(short.reloadSeconds);
    // Total damage on one trigger pull is what actually lands, so compare it as a whole.
    const total = (pellets: number | undefined, damage: number): number => (pellets ?? 1) * damage;
    expect(total(REMINGTON870_DESCRIPTOR.pellets, REMINGTON870_DESCRIPTOR.damage))
      .toBeGreaterThan(total(short.pellets, short.damage));
  });
});
