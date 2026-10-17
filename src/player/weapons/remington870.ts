import {
  BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
} from 'three';
// Imported with an explicit `.ts` extension on purpose: the colours must not drift from the
// rest of the code-built weapons, and `tools/export-weapon-models.mjs` loads these modules
// through Node's type stripping, which resolves relative imports only when the extension is
// written out — the same reason `proceduralWeapons.ts` keeps its own `add`/`material` local.
import { WEAPON_PALETTE } from '../proceduralWeapons.ts';

/**
 * Remington 870: a pump-action shotgun played as the classic field gun — a long barrel, a
 * magazine tube under it, a wooden pump forend and a long wooden stock.
 *
 * Why this file exists on its own rather than as another `createX` in
 * `proceduralWeapons.ts`: that module is the source of truth for the meshes the roster
 * already ships, and its export registry is walked by `tools/export-weapon-models.mjs` and
 * pinned by `tests/weapon-roster.test.ts`. The 870 is an extra the owner wires in by hand,
 * so it lives beside that workflow without editing it — same helpers, same palette, same
 * units.
 *
 * Why a *second* pump gun when the roster already has one: the short `Shotgun` is a
 * close-quarters weapon — a 0.06 rad cone and a 40 m reach. The 870 is the same action
 * carried on a full-length barrel, so the pump *reads* on the model (a long magazine tube,
 * a forend well forward of the receiver) instead of being implied by the name. That is the
 * whole point of building it: a longer tube, a tighter pattern and one more shell, paid for
 * with a slower stroke and a slower reload.
 *
 * Conventions, identical to `proceduralWeapons.ts`: the grip sits at the origin, **+Z runs
 * towards the muzzle**, +X is the shooter's right and -Y is down (so the magazine tube and
 * the trigger group hang below the barrel, and the sight line sits on top). Nothing here is
 * scaled by hand at load: `Game.normalizeViewModel()` normalises every model by its longest
 * axis, so the proportions and the grip-at-origin placement are what matter.
 *
 * Overall length is ~1.15 m, the longest weapon on the shelf: a real 870 with a 26 in field
 * barrel measures about 1.15 m, and measured against the code-built meshes the next longest
 * is the belt-fed LMG at 1.09 m — so the pump gun that is meant to be the longest actually
 * is, rather than only in the comment.
 */

function material(colour: number, roughness: number, metalness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour, roughness, metalness });
}

function add(parent: Group, name: string, geometry: BufferGeometry, mat: MeshStandardMaterial,
  position: readonly [number, number, number], rotation?: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(geometry, mat);
  // Every part is named: the test finds the barrel, the magazine tube and the pump by name
  // and measures their boxes, so a rename is a failure rather than a silent pass. The
  // pump's name is also what the mechanism rig hooks on, so it is not free to change.
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

/** The pump forend's mesh name. A constant because the mechanism rig and the test both key on it. */
export const REMINGTON870_PUMP_MESH = 'Remington870PumpForend';

/**
 * Builds the 870 mesh as a fresh `Group` per call (a Group cannot be in two scenes).
 *
 * Layout, in metres along +Z (origin at the shooting hand, on the stock's wrist where it
 * meets the receiver):
 *
 *   -0.42 .. -0.36  recoil pad, the rearmost part
 *   -0.40 .. -0.08  stock, dropped towards the heel the way a shotgun stock is
 *   -0.12 ..  0.01  the wrist/grip at the origin, trigger group just ahead of it
 *   -0.16 .. +0.14  receiver, with the ejection port on the right and the sight line on top
 *   +0.13 .. +0.73  barrel to the muzzle, magazine tube running under it from +0.17
 *   +0.17 .. +0.64  magazine tube, on the centre line but *below* the barrel
 *   +0.24 .. +0.43  pump forend wrapping the tube, ribs underneath for the hand
 *   +0.61 .. +0.62  barrel band tying the tube to the barrel in front of the forend
 *
 * The two facts the geometry has to carry, and that a name alone cannot: the tube sits under
 * the barrel (it is on the same centre line, 46 mm lower), and the forend is a separate,
 * clearly-shaped part *below* both, forward of the receiver — which is where a pump has to
 * be for the mechanism rig to slide it back along the tube.
 */
export function createRemington870(): Group {
  const group = new Group();
  group.name = 'WeaponRemington870';

  // Blued steel for the metal, walnut for the furniture: the classic 870 is a wood-stocked
  // gun, and wood is also what tells it apart from the polymer black of the short shotgun
  // at any distance a view model is seen from.
  const blued = material(WEAPON_PALETTE.gunmetal, 0.5, 0.75);
  const bluedBright = material(WEAPON_PALETTE.steelDark, 0.38, 0.85);
  const steel = material(WEAPON_PALETTE.steel, 0.32, 0.88);
  const wood = material(WEAPON_PALETTE.wood, 0.85, 0.05);
  const woodDark = material(WEAPON_PALETTE.woodDark, 0.9, 0.05);
  const rubber = material(WEAPON_PALETTE.polymer, 0.92, 0.05);

  // Receiver: the slab everything hangs off, from behind the trigger to the barrel's throat.
  add(group, 'Remington870Receiver', new BoxGeometry(0.062, 0.092, 0.3), blued, [0, 0.012, -0.01]);
  // Sight line on top: a low rib and a rear sight block. The moulded receiver's top edge
  // alone reads as a box; these two are what make it read as a gun with sights.
  add(group, 'Remington870TopRail', new BoxGeometry(0.018, 0.01, 0.17), bluedBright, [0, 0.063, -0.04]);
  add(group, 'Remington870RearSight', new BoxGeometry(0.012, 0.016, 0.02), bluedBright, [0, 0.076, -0.12]);
  // Ejection port on the shooter's right, and the loading port under the receiver — the two
  // cut-outs a pump gun is fed through, so they belong on the model.
  add(group, 'Remington870EjectionPort', new BoxGeometry(0.006, 0.03, 0.09), bluedBright, [0.033, 0.02, -0.02]);
  add(group, 'Remington870LoadingPort', new BoxGeometry(0.03, 0.008, 0.06), steel, [0, -0.034, -0.02]);

  // Fire control: a housing under the receiver, the trigger in it and a guard bar under the
  // trigger. The guard is a flat bar rather than a loop because at this size the bar is the
  // silhouette and the loop is three more boxes nobody sees.
  add(group, 'Remington870TriggerHousing', new BoxGeometry(0.032, 0.034, 0.075), blued, [0, -0.051, 0.045]);
  add(group, 'Remington870Trigger', new BoxGeometry(0.009, 0.026, 0.01), steel, [0, -0.08, 0.032]);
  add(group, 'Remington870TriggerGuard', new BoxGeometry(0.012, 0.007, 0.088), blued, [0, -0.093, 0.046]);

  // The grip itself: the wrist of the stock, at the origin, angled back the way the hand
  // wraps it. This is the part the whole convention hangs off — the origin is where the
  // shooting hand is, not the middle of the weapon.
  add(group, 'Remington870Grip', new BoxGeometry(0.038, 0.088, 0.095), wood, [0, -0.072, -0.045], [-0.16, 0, 0]);

  // Barrel, with a shank at its base: the throat is wider than the bore, which is what makes
  // the barrel look screwed into the receiver rather than passing through it.
  add(group, 'Remington870BarrelShank', new CylinderGeometry(0.017, 0.017, 0.06, 12), bluedBright,
    [0, 0.026, 0.155], [Math.PI / 2, 0, 0]);
  add(group, 'Remington870Barrel', new CylinderGeometry(0.0115, 0.0115, 0.56, 12), bluedBright,
    [0, 0.026, 0.45], [Math.PI / 2, 0, 0]);
  // Front bead on its post: a shotgun is aimed down the barrel, so the muzzle end needs
  // something to point with.
  add(group, 'Remington870FrontSight', new BoxGeometry(0.006, 0.014, 0.01), blued, [0, 0.044, 0.69]);
  add(group, 'Remington870FrontBead', new BoxGeometry(0.01, 0.009, 0.01), steel, [0, 0.055, 0.69]);

  // Magazine tube UNDER the barrel, on the same centre line 46 mm lower. That offset is not
  // decoration: the tube is the part the forend slides on, and it is the one measured fact
  // that separates this weapon's geometry from a rifle's (a rifle's rounds go in a box mag).
  add(group, 'Remington870MagazineTube', new CylinderGeometry(0.0105, 0.0105, 0.47, 12), bluedBright,
    [0, -0.02, 0.405], [Math.PI / 2, 0, 0]);
  // Follower cap at the tube's front end, where the shells go in.
  add(group, 'Remington870MagazineCap', new CylinderGeometry(0.0135, 0.0135, 0.022, 12), blued,
    [0, -0.02, 0.651], [Math.PI / 2, 0, 0]);
  // Barrel band in front of the forend: it clamps the tube to the barrel, so the two read as
  // one rigid assembly out at the muzzle end rather than two rods that happen to be parallel.
  add(group, 'Remington870BarrelBand', new BoxGeometry(0.048, 0.072, 0.02), blued, [0, 0.003, 0.615]);

  // The pump forend. Named, separate and clearly shaped, because it is the part the
  // mechanism rig moves — everything else on this weapon is static.
  add(group, REMINGTON870_PUMP_MESH, new BoxGeometry(0.056, 0.052, 0.185), wood, [0, -0.024, 0.335]);
  // Ribs under the forend: the ridges a hand grips, and what keeps the pump from reading as
  // a smooth block on a tube.
  for (let index = 0; index < 3; index += 1) {
    add(group, `Remington870ForendRib${index}`, new BoxGeometry(0.058, 0.007, 0.012), woodDark,
      [0, -0.051, 0.275 + index * 0.06]);
  }

  // Stock: long, and dropped towards the heel (a 0.16 rad pitch), so the comb rises to the
  // sight line at the front of the stock and the butt drops below the trigger hand — which
  // is the pitch a shotgun stock has so the shooter's eye lines up with the bead.
  add(group, 'Remington870Stock', new BoxGeometry(0.048, 0.115, 0.3), wood, [0, -0.055, -0.24], [0.16, 0, 0]);
  // Cheek piece on top of the stock, at the comb.
  add(group, 'Remington870Comb', new BoxGeometry(0.044, 0.02, 0.24), wood, [0, 0.014, -0.24], [0.16, 0, 0]);
  // Recoil pad: the rearmost point of the weapon. The palette's matte polymer stands in for
  // the black rubber of the pad — the darkest matte colour the code-built parts share.
  add(group, 'Remington870ButtPlate', new BoxGeometry(0.052, 0.126, 0.024), rubber, [0, -0.078, -0.398], [0.16, 0, 0]);

  return group;
}

/**
 * The 870's stats as data, in the shape of a `WeaponConfig` minus the fields the store and
 * the runtime add (`slot`, `modelPath`, `viewModel`, `headshotMultiplier`).
 *
 * Every number is chosen against the short pump shotgun already on the shelf and the reason
 * is written next to it. The trade is consistent in one direction: the 870 throws a heavier
 * payload further and in a tighter pattern, and charges for it with a slower stroke, a
 * slower reload and a little more muzzle rise. Nothing here is better in every column, which
 * is what keeps the short gun worth carrying.
 */
export interface Remington870Descriptor {
  id: 'remington-870';
  name: string;
  /** Damage per pellet, not per shell: `pellets` of these land on one trigger pull. */
  damage: number;
  fireRate: number;
  automatic: boolean;
  pellets: number;
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

export const REMINGTON870_DESCRIPTOR: Remington870Descriptor = {
  id: 'remington-870',
  name: 'Remington 870',
  // 13 per pellet: eight of them is 104 damage at contact against the short gun's 96, so one
  // shell still drops a walker outright — but only one, and only at contact, which is what
  // the barrel length is paying for. Per pellet rather than per shell because that is how
  // `WeaponConfig.damage` is defined for a weapon with `pellets`.
  damage: 13,
  // 0.85 rounds/s (one shell per 1.18 s): a pump stroke is a deliberate, two-handed action
  // and the mesh has a forend that has to travel and come back visibly (fireRate drives the
  // mechanism's cycle — see `mechanismCycleSeconds`). Slower than the short gun's 1.15, and
  // that gap is the first thing the 870's extra reach costs.
  fireRate: 0.85,
  automatic: false,
  // 8 pellets a shell, the same load as the short pump gun: felt recoil, pattern density and
  // the single-shell kill are all decided by the shell, not by the barrel it is fired from.
  pellets: 8,
  // 7: a 6-round tube plus the one in the chamber, which is exactly what a "7-shot" 870 is —
  // a 20 in barrel with an extended tube. One more shell than the short gun (6) is part of
  // what the extra barrel buys, and it is not more than the tube on the model can hold.
  magazineSize: 7,
  // 56: eight full tube-loads, the same number of reloads the short gun's 48/6 gives. The
  // ratio is the point — a bigger magazine gets proportionally more reserve, so neither gun
  // runs dry sooner in a fight that goes long.
  startingReserve: 56,
  // 112: double the starting reserve, matching the short gun's 48/96, so the pickup economy
  // does not have to learn a second scale for one weapon.
  maxReserve: 112,
  // 3.1 s: longer than the short gun's 2.6 because there is one more shell to push in and
  // every one of them is hand-fed down the same tube. This is the 870's real cost: a pump
  // gun's reload is slow, and the model has the tube on it to explain why.
  reloadSeconds: 3.1,
  // 55 m against the short gun's 40: a 26 in barrel holds its pattern, so the pellets are
  // still grouped past the reach of the shorter gun. Kept well under the rifle's 110 so it
  // is a shotgun with a long barrel, not a rifle with a wide one.
  range: 55,
  // 0.052 rad against the short gun's 0.062: a tighter cone is the whole reason for the
  // longer barrel, and the reason the 870 is the one you take an aimed shot with.
  spread: 0.052,
  // 0.030 rad of kick, a shade over the short gun's 0.028: the same eight pellets with more
  // powder behind them, since that is what buys the range. The extra mass of the barrel only
  // partly absorbs it, and the model is a heavier gun either way, so the number stays close.
  recoil: 0.03,
  // 6.0, a shade under the short gun's 6.5, so the 870 settles like the heavier and more
  // barrel-forward weapon it is when this per-weapon number is picked up. Said plainly:
  // nothing in `src/` reads `recoilRecovery` yet — the camera's decay rate is still the
  // global `RECOIL_RECOVERY` in `PlayerController` — so this is a carried number, not a
  // live one, and it is set in the same direction as `recoil` above.
  recoilRecovery: 6,
  // 0.08 s, just longer than the short gun's 0.075: a full-power shell out of a longer tube
  // burns longer, and the flash has to stay under half the shot interval or the pump stroke
  // would be hidden behind it. At 1.18 s an interval it is nowhere near that floor.
  muzzleFlashSeconds: 0.08,
  // 1: every shell, like the short gun. At under a round a second a tracer per shot is
  // readable rather than the solid bar it would be on an automatic.
  tracerEvery: 1,
  // Held like the short pump gun: a shoulder stock and a sliding forend need the two-handed
  // shotgun pose in `proceduralArms`, not the rifle's.
  grip: 'shotgun',
};
