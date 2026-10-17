import {
  BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
} from 'three';
// Imported with an explicit `.ts` extension on purpose, exactly as `remington870.ts` does:
// the colours must not drift from the rest of the code-built weapons, and
// `tools/export-weapon-models.mjs` loads these modules through Node's type stripping, which
// resolves relative imports only when the extension is written out. Without it the export
// run dies with ERR_MODULE_NOT_FOUND and no AUG.gltf is ever produced.
import { WEAPON_PALETTE } from '../proceduralWeapons.ts';

/**
 * AUG: a bullpup assault rifle, built from primitives in code.
 *
 * Why this file exists on its own rather than as another `createX` in
 * `proceduralWeapons.ts`: that module is the source of truth for the weapons the roster
 * already ships, and its export registry is walked by `tools/export-weapon-models.mjs`
 * and pinned by `tests/weapon-roster.test.ts`. The AUG is an extra the owner is wiring in
 * by hand, so it lives beside the workflow without editing it — same helpers, same
 * palette (imported, so the colours cannot drift), same units.
 *
 * What actually makes it a bullpup, and the thing the test measures rather than trusting
 * the name: the magazine sits *behind* the pistol grip, and the action sits behind the
 * trigger, so the barrel keeps its full length while the whole weapon stays short. On a
 * conventional rifle the magazine hangs in front of (or over) the grip; here it is the
 * rearmost part of the underside, at negative Z, behind the origin.
 *
 * Conventions, identical to `proceduralWeapons.ts`: the pistol grip sits at the origin,
 * **+Z runs towards the muzzle**, +X is the shooter's right and -Y is down (so the
 * magazine and grips hang below, the optic sits above). Overall length is ~0.8 m, longer
 * than the P90 bullpup because this one keeps a rifle-length barrel. Nothing here is
 * scaled by hand at load: `Game.normalizeViewModel()` normalises every model by its
 * longest axis, so the proportions and the grip-at-origin placement are what matter.
 */

function material(colour: number, roughness: number, metalness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour, roughness, metalness });
}

function add(parent: Group, name: string, geometry: BufferGeometry, mat: MeshStandardMaterial,
  position: readonly [number, number, number], rotation?: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(geometry, mat);
  // Every part is named: the bullpup test finds the magazine, the grip and the muzzle by
  // name and measures their boxes, so a rename is a test failure rather than a silent pass.
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  // A view model sits inside the camera; `normalizeViewModel` clears these at load and the
  // export writes them so a mesh previewed in the store behaves the same way.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

/**
 * Builds the AUG mesh as a fresh `Group` per call (a Group cannot be in two scenes).
 *
 * Layout, in metres along +Z (origin at the pistol grip):
 *   -0.22 .. -0.10  butt pad and cheek rest (the bullpup stock is the rear of the shell)
 *   -0.18 .. -0.09  magazine, the rearmost part of the underside and the bullpup's tell
 *   -0.10 .. +0.18  integrated optic over the receiver: one long tube, eyepiece to rear
 *   -0.05 ..  0.00  pistol grip at the origin, trigger guard just ahead of it
 *   +0.23 .. +0.37  handguard with the vertical foregrip under it
 *   +0.27 .. +0.59  barrel and slotted flash hider, to the muzzle at ~+0.59
 */
export function createAug(): Group {
  const group = new Group();
  group.name = 'WeaponAUG';

  const polymer = material(WEAPON_PALETTE.polymer, 0.75, 0.1);
  const polymerLight = material(WEAPON_PALETTE.polymerLight, 0.7, 0.15);
  const gunmetal = material(WEAPON_PALETTE.gunmetal, 0.5, 0.75);
  const steel = material(WEAPON_PALETTE.steel, 0.35, 0.85);
  const steelDark = material(WEAPON_PALETTE.steelDark, 0.45, 0.8);

  // One-piece receiver shell: on a bullpup the action and the stock are the same moulding,
  // so the body is a single long slab rather than a receiver with something bolted behind.
  add(group, 'AugShell', new BoxGeometry(0.058, 0.082, 0.46), polymer, [0, 0.02, 0.04]);
  // Trigger housing under the shell, where the fire-control parts live.
  add(group, 'AugTriggerHousing', new BoxGeometry(0.05, 0.05, 0.16), polymer, [0, -0.025, 0.01]);

  // Barrel: full rifle length despite the short overall weapon, which is the point of the
  // bullpup layout. It protrudes forward of the handguard as a bare tube.
  add(group, 'AugBarrel', new CylinderGeometry(0.011, 0.011, 0.30, 12), gunmetal,
    [0, 0.03, 0.42], [Math.PI / 2, 0, 0]);
  // Slotted flash hider — the AUG's muzzle device is a broad open cage, not a plain cap.
  add(group, 'AugMuzzleBrake', new CylinderGeometry(0.017, 0.017, 0.05, 12), steelDark,
    [0, 0.03, 0.565], [Math.PI / 2, 0, 0]);
  // Handguard over the barrel root, the polymer the support hand wraps.
  add(group, 'AugHandguard', new BoxGeometry(0.052, 0.058, 0.14), polymerLight, [0, 0.02, 0.30]);

  // Integrated optic: the AUG's signature is a long low-power tube carried over the
  // receiver, eyepiece to the shooter's eye and objective forward, on a short rail block.
  add(group, 'AugScopeMount', new BoxGeometry(0.028, 0.03, 0.24), steelDark, [0, 0.072, 0.05]);
  add(group, 'AugScopeTube', new CylinderGeometry(0.021, 0.021, 0.26, 12), gunmetal,
    [0, 0.10, 0.05], [Math.PI / 2, 0, 0]);
  add(group, 'AugScopeObjective', new CylinderGeometry(0.026, 0.026, 0.06, 12), steel,
    [0, 0.10, 0.17], [Math.PI / 2, 0, 0]);
  add(group, 'AugScopeEyepiece', new CylinderGeometry(0.024, 0.024, 0.05, 12), gunmetal,
    [0, 0.10, -0.095], [Math.PI / 2, 0, 0]);

  // Bullpup stock: the rear of the shell itself, with a cheek rest under the sight line and
  // a butt pad to shoulder. No separate tube stock — there is no room for one.
  add(group, 'AugButtPad', new BoxGeometry(0.052, 0.1, 0.05), polymer, [0, 0.0, -0.19]);
  add(group, 'AugCheekRest', new BoxGeometry(0.05, 0.035, 0.13), polymerLight, [0, 0.05, -0.12]);

  // Magazine BEHIND the grip: the bullpup's defining feature, and what the test measures.
  // It is tipped slightly forward the way a box mag hangs, and its whole box stays at
  // negative Z, behind the origin the grip defines.
  add(group, 'AugMagazine', new BoxGeometry(0.032, 0.16, 0.07), polymerLight,
    [0, -0.10, -0.14], [0.15, 0, 0]);
  add(group, 'AugMagFloorplate', new BoxGeometry(0.036, 0.02, 0.075), polymer,
    [0, -0.185, -0.145], [0.15, 0, 0]);

  // Pistol grip at the origin and the trigger guard in front of it.
  add(group, 'AugPistolGrip', new BoxGeometry(0.034, 0.11, 0.05), polymer,
    [0, -0.085, -0.005], [-0.28, 0, 0]);
  add(group, 'AugTriggerGuard', new BoxGeometry(0.028, 0.018, 0.085), polymer, [0, -0.06, 0.045]);

  // Vertical foregrip under the handguard: the AUG's forward handle, held by the support
  // hand to control the muzzle on a weapon whose weight sits back in the stock.
  add(group, 'AugForeGrip', new BoxGeometry(0.03, 0.1, 0.038), polymer,
    [0, -0.085, 0.31], [0.12, 0, 0]);

  // The two small parts that keep the right side from reading as a blank slab: the ejection
  // port and the charging handle ahead of it, both on the shooter's right (+X).
  add(group, 'AugEjectionPort', new BoxGeometry(0.006, 0.03, 0.07), steelDark, [0.03, 0.02, -0.03]);
  add(group, 'AugChargingHandle', new BoxGeometry(0.014, 0.016, 0.05), steel, [0.03, 0.07, 0.12]);

  return group;
}

/**
 * The AUG's stats as data, in the shape of a `WeaponConfig` minus the fields the store and
 * the runtime add (`slot`, `modelPath`, `viewModel`, `headshotMultiplier`).
 *
 * Every number is chosen against the rifles already on the shelf and the reason is written
 * with it: this is meant to slot between the MP5 (16 damage, close range) and the LMG (22
 * damage, belt-fed), as a mid-cadence, long-reach bullpup.
 */
export interface AugDescriptor {
  id: 'aug';
  name: string;
  damage: number;
  fireRate: number;
  automatic: boolean;
  magazineSize: number;
  startingReserve: number;
  maxReserve: number;
  reloadSeconds: number;
  range: number;
  spread: number;
  recoil: number;
  recoilRecovery: number;
  muzzleFlashSeconds: number;
  tracerEvery: number;
  grip: 'pistol' | 'rifle' | 'shotgun';
}

export const AUG_DESCRIPTOR: AugDescriptor = {
  id: 'aug',
  name: 'AUG',
  // 21: a 5.56 round lands harder than the MP5's 16 (9mm) and the P90's 18, but stays
  // under the belt-fed LMG's 22 — the AUG is a precise rifle, not the heaviest thing here.
  damage: 21,
  // 10 rounds/s: a medium cadence. Faster than the assault rifle's 9.5 so it feels like a
  // rifle of its own, slower than the SMGs (MP5 11, P90 13.5), which is what a heavier
  // round and a bullpup's rearward balance buy you.
  fireRate: 10,
  automatic: true,
  // 30: a STANAG magazine, the 5.56 standard, matches the rifle and the SMGs.
  magazineSize: 30,
  startingReserve: 120,
  maxReserve: 240,
  // 2.2 s: a bullpup magazine lives against the shoulder, so a change is a touch more
  // awkward than the conventional rifle's 2.1 — a fair cost for the shorter weapon, and
  // well inside any sane ceiling.
  reloadSeconds: 2.2,
  // 115 m: the longest reach of the hand-held guns (rifle 110, LMG 120), because the
  // barrel is a full rifle length and the integrated optic is meant for distance.
  range: 115,
  // 0.010 rad: tighter than the assault rifle's 0.012 and much tighter than the bullpup
  // P90's 0.016 — the whole reason to carry an optic, and the counterweight to the
  // below-average fire rate.
  spread: 0.010,
  // 0.013 rad of kick: a little more than the rifle's 0.012, since the round is bigger and
  // the mass sits back over the shoulder.
  recoil: 0.013,
  // 8.5: settles a shade slower than the rifle's 9 (a heavier round takes longer to bring
  // back on target), but faster than the LMG's 7, so it stays a rifle and not a support gun.
  recoilRecovery: 8.5,
  muzzleFlashSeconds: 0.045,
  // 3: same as the rifle. At ten a second a tracer every round is a solid bar on screen.
  tracerEvery: 3,
  // Held like a rifle: it has a shoulder stock and a foregrip, so it takes the rifle pose.
  grip: 'rifle',
};
