import {
  BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
} from 'three';

/**
 * MP7-class personal defense weapon, built from primitives in code.
 *
 * Same arrangement as `proceduralWeapons.ts`: the mesh is written here because the project's
 * only weapon pack ships no `mp7`, code is the project's stated way of supplying a weapon the
 * pack cannot (`agents.md` forbids FBX at runtime), and the result is exported to glTF by
 * `tools/export-weapon-models.mjs` so the runtime still loads it through the ordinary path.
 *
 * Spatial convention, identical to every other weapon in the project, because
 * `Game.normalizeViewModel()` and the first-person hand placement depend on it: the grip sits
 * at the origin, **+Z runs towards the muzzle**, +X is the shooter's right and -Y is down (the
 * magazine hangs below). Only proportions and the placement of the grip are load-bearing —
 * nothing here sets a scale that matters.
 *
 * Size: about 0.64 m with the stock out, against the MP5's 0.65 m, but with a 0.18 m barrel
 * against the MP5's 0.24 m and the mass gathered over the grip — which is the whole point of a
 * PDW, and the reason this weapon is the shortest-shooting automatic in the roster.
 */

/**
 * Colours, kept as literals rather than imported from `WEAPON_PALETTE`.
 *
 * `proceduralWeapons.ts` will import this module to register the MP7 for export, so importing
 * the palette back the other way would make the two modules a cycle — and a cycle that the
 * exporter's Node type-stripping run would have to resolve through an explicit file
 * extension. The values are copied from that palette on purpose: the MP7 is meant to sit in
 * the same visual family as the MP5 and the P90 it joins, not to introduce a second grey.
 */
const MP7_PALETTE = {
  /** Receiver: dark, mostly matte, a little sheen. */
  gunmetal: 0x3b4046,
  /** Matte polymer shell and grip. */
  polymer: 0x2b2f34,
  polymerLight: 0x424852,
  /** Bright steel: barrel and muzzle device. */
  steel: 0x9aa1a8,
  steelDark: 0x565c63,
  /** Charging handle and sights. */
  wrap: 0x1b1e22,
} as const;

function material(colour: number, roughness: number, metalness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour, roughness, metalness });
}

/**
 * Adds one primitive to the weapon.
 *
 * `name` is required here where it is optional in `proceduralWeapons.ts`, for two reasons: the
 * glTF export keeps the node name, so a mesh previewed in the store is identifiable, and
 * `tests/weapon-mp7.test.ts` reads parts back by name (the grip, the muzzle) instead of
 * guessing which box in the list is which.
 */
function add(parent: Group, name: string, geometry: import('three').BufferGeometry,
  mat: MeshStandardMaterial, position: readonly [number, number, number],
  rotation?: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  // A view model sits inside the camera; `normalizeViewModel` clears these flags at load, and
  // the export writes them so a mesh previewed in the store behaves the same way.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

export function createMp7(): Group {
  const group = new Group();
  group.name = 'WeaponMP7';
  const polymer = material(MP7_PALETTE.polymer, 0.75, 0.1);
  const polymerLight = material(MP7_PALETTE.polymerLight, 0.7, 0.15);
  const gunmetal = material(MP7_PALETTE.gunmetal, 0.5, 0.75);
  const steel = material(MP7_PALETTE.steel, 0.35, 0.85);
  const steelDark = material(MP7_PALETTE.steelDark, 0.45, 0.8);
  const wrap = material(MP7_PALETTE.wrap, 0.9, 0.05);

  // Receiver: 0.26 m long and tall for its width, so it reads as a moulded polymer shell
  // rather than a machined slab. It runs from just behind the trigger to the handguard and is
  // the piece every other part bolts onto.
  add(group, 'Mp7:Receiver', new BoxGeometry(0.052, 0.072, 0.26), polymer, [0, 0.014, 0.055]);
  // Picatinny rail on top. The MP7's rail is the sight line of the whole gun — its iron sights
  // fold onto it — so it is a full-length strip, not a short base.
  add(group, 'Mp7:TopRail', new BoxGeometry(0.026, 0.012, 0.2), steelDark, [0, 0.056, 0.055]);
  // Barrel. The real PDW barrel is 180 mm; this is 170 mm, because the extra 10 mm would come
  // out of the receiver's length and the receiver is what the magazine and the grip hang from.
  add(group, 'Mp7:Barrel', new CylinderGeometry(0.0085, 0.0085, 0.17, 10), steel,
    [0, 0.02, 0.27], [Math.PI / 2, 0, 0]);
  add(group, 'Mp7:Muzzle', new CylinderGeometry(0.013, 0.013, 0.032, 10), gunmetal,
    [0, 0.02, 0.345], [Math.PI / 2, 0, 0]);
  // Polymer handguard over the barrel's base, wide enough to take the support hand.
  add(group, 'Mp7:Handguard', new BoxGeometry(0.038, 0.05, 0.1), polymerLight, [0, 0.005, 0.175]);
  // Folding foregrip, swung down under the handguard. Its whole job in the silhouette is to
  // stop the front of the gun being one straight line.
  add(group, 'Mp7:ForeGrip', new BoxGeometry(0.024, 0.052, 0.028), polymer,
    [0, -0.035, 0.185], [0.22, 0, 0]);
  // Pistol grip, sitting at the origin, angled back the way a PDW's is. The magazine is inside
  // this grip on the real weapon (see `Mp7:Magazine`), which is why the two overlap.
  add(group, 'Mp7:Grip', new BoxGeometry(0.03, 0.095, 0.045), polymer,
    [0, -0.065, -0.008], [-0.2, 0, 0]);
  // Trigger guard: the bar under the trigger plus the post that carries its front end up to the
  // receiver. Two boxes, because a single floating bar reads as a mistake at this polygon count.
  add(group, 'Mp7:TriggerGuard', new BoxGeometry(0.018, 0.006, 0.05), polymerLight, [0, -0.048, 0.05]);
  add(group, 'Mp7:TriggerGuardPost', new BoxGeometry(0.018, 0.03, 0.012), polymerLight, [0, -0.035, 0.073]);
  // Magazine: inserted through the grip, so it is narrower than the grip and its top end sits
  // inside it. 0.12 m of exposed magazine is what a 40-round 4.6 mm box actually shows.
  add(group, 'Mp7:Magazine', new BoxGeometry(0.026, 0.12, 0.042), polymerLight,
    [0, -0.148, -0.018], [-0.08, 0, 0]);
  // Folding stock: two thin rails out the back with a butt plate on the end, which is the MP7's
  // own stock rather than the solid block a rifle has. They start inside the receiver so the
  // weapon has no visible seam when the stock is out.
  for (const side of [-1, 1] as const) {
    add(group, `Mp7:StockRail${side > 0 ? 'Right' : 'Left'}`,
      new CylinderGeometry(0.005, 0.005, 0.2, 6), steelDark,
      [side * 0.02, 0.026, -0.17], [Math.PI / 2, 0, 0]);
  }
  add(group, 'Mp7:ButtPlate', new BoxGeometry(0.048, 0.05, 0.012), polymer, [0, 0.026, -0.276]);
  // Charging handle on the right of the receiver, ejection port under it, and the two folding
  // sights up on the rail. Small parts, but they are what makes a polymer box read as a gun.
  add(group, 'Mp7:ChargingHandle', new BoxGeometry(0.016, 0.013, 0.036), wrap, [0.03, 0.052, 0.12]);
  add(group, 'Mp7:EjectionPort', new BoxGeometry(0.005, 0.016, 0.05), steelDark, [0.027, 0.016, 0.1]);
  add(group, 'Mp7:FrontSight', new BoxGeometry(0.012, 0.022, 0.012), wrap, [0, 0.073, 0.155]);
  add(group, 'Mp7:RearSight', new BoxGeometry(0.016, 0.02, 0.014), wrap, [0, 0.072, -0.035]);
  return group;
}

/**
 * The balance values for the MP7, ready to be merged into `WEAPONS` in `gameConfig.ts`.
 *
 * A plain data object with no Three.js in it, so the weapon can be integrated without
 * dragging the mesh module into any code that only wants to read numbers.
 *
 * Every value is argued against the weapon it sits beside in the roster (MP5: 16 damage,
 * 11 rps, 30 rounds, 95 m, 0.012 spread, 0.008 recoil). Nothing here is copied from another
 * weapon without a reason, because a PDW that is merely a faster MP5 is a balance regression.
 */
export interface Mp7Descriptor {
  id: 'mp7';
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

export const MP7_DESCRIPTOR: Mp7Descriptor = {
  id: 'mp7',
  name: 'MP7',
  /**
   * 4.6x30 mm against the MP5's 9 mm: less mass per round, so less damage per hit (13 against
   * 16). The round is the smallest in the roster, and a weapon that out-damaged the MP5 while
   * also firing half again as fast would simply replace it.
   */
  damage: 13,
  /**
   * 16 rounds per second. The real weapon cycles at about 950 rpm, which is 15.8/s — the
   * highest rate of any firearm in the game and the MP7's defining trait, so it is taken from
   * the hardware rather than tuned. At 40 rounds that is a 2.5 s magazine.
   */
  fireRate: 16,
  // The real selector has a single-shot mode, but every PDW in this roster is sold as an
  // automatic and this one has no trigger discipline to reward at 16 rps.
  automatic: true,
  // The 40-round magazine, the larger of the two the weapon actually takes. It is both the
  // real figure and what keeps the statistic honest: 40 rounds at 13 damage is 520 potential
  // damage, below the MP5's 480 at a much shorter effective range.
  magazineSize: 40,
  // Five spare magazines, matching the P90, which is the other 40-round gun. The reserve is
  // best read as magazines, not rounds: 200/40 = 5 reloads either way.
  startingReserve: 200,
  maxReserve: 400,
  /**
   * 2.1 s: longer than the MP5's 1.9 s because a 40-round magazine is heavier, shorter than
   * the P90's 2.3 s because this magazine goes straight through the grip with nothing to fold
   * out of the way.
   */
  reloadSeconds: 2.1,
  /**
   * 85 m, the shortest of the automatics (the SMG and MP5 sit at 95, the P90 at 100). The
   * 4.6 mm round is flat-shooting, but the barrel is only 180 mm, and the weapon has to give
   * up something for its rate of fire.
   */
  range: 85,
  /**
   * 0.018 rad: the widest cone of the automatics, above the P90's 0.016. The gun is the
   * shortest and lightest thing that fires a rifle-style round, so it wanders most.
   */
  spread: 0.018,
  /**
   * 0.011 rad of muzzle rise per shot, above the MP5's 0.008 and the P90's 0.010. Recoil here
   * tracks the mass of the weapon, and this is the lightest of the three — the kick is the cost
   * of the fire rate.
   */
  recoil: 0.011,
  /**
   * 9.5: recovers quickly, because a fast cycle and low mass settle fast, but not as quickly as
   * the rifle (9) — the muzzle is still thrown further on the way up.
   */
  recoilRecovery: 9.5,
  /**
   * 0.035 s, the shortest flash in the roster. At 16 rounds a second a full-length flash lights
   * the same 0.06 s window three times per shot cycle and washes the screen out; the same
   * reasoning that gave the 13 rps SMG a 0.04 s flash, taken one step further.
   */
  muzzleFlashSeconds: 0.035,
  /**
   * Every second round. At 16 rps one tracer per shot is a solid bar of light (the SMG already
   * has to drop to every second at 13 rps), and every third would leave single rounds invisible
   * in a 2.5 s magazine.
   */
  tracerEvery: 2,
  // A two-handed weapon held at the shoulder, so the rifle pose: the same grip the MP5 and the
  // P90 use. The pistol pose would put the support hand where the handguard is not.
  grip: 'rifle',
};
