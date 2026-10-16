import {
  BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
  SphereGeometry, TorusGeometry,
} from 'three';
import type { MeleeId } from '../app/meleeConfig';
import type { GrenadeId } from '../app/grenadeConfig';
import type { WeaponId } from '../app/gameConfig';

/**
 * The extra weapon meshes, built from primitives in code.
 *
 * Why code and not a download: the project's only weapon pack (Quaternius) ships no glTF
 * build, Sketchfab needs an account the project does not have, and `agents.md` forbids
 * FBX at runtime — so the meshes that a downloaded pack cannot supply are written here,
 * the same way `proceduralGear.ts` already supplies Jack's axe and barbed bat.
 *
 * Why the meshes are then exported to glTF rather than handed to the renderer directly:
 * the runtime's asset policy is glTF-only (`AssetManager` rejects anything else), the view
 * model is loaded from `WEAPONS[id].modelPath` / `MELEE[id].modelPath` like every other
 * weapon, and `tests/weapon-assets.test.ts` requires a real file behind every modelPath.
 * So this module is the source of truth and `tools/export-weapon-models.mjs` writes each
 * mesh to `public/assets/weapons/<File>.gltf` — one re-runnable command, and the meshes
 * afterwards travel the ordinary loading path with no special case anywhere.
 *
 * Convention, identical to `proceduralGear.ts` and to the pack's own weapons: the grip
 * sits at the origin, **+Z runs towards the muzzle or the biting end**, +X is the shooter's
 * right and -Y is down (a magazine hangs below the weapon). Nothing here sets a scale
 * that matters: `Game.normalizeViewModel()` normalises each model by its longest axis, so
 * only the proportions and the placement of the grip are load-bearing.
 */

/** Colours for the code-built weapons. Original to this project, sampled from nothing. */
export const WEAPON_PALETTE = {
  /** Receiver metal: dark, mostly matte, a little sheen on the edges. */
  gunmetal: 0x3b4046,
  /** Matte polymer furniture: grips, handguards, magazines. */
  polymer: 0x2b2f34,
  polymerLight: 0x424852,
  /** Bright steel: barrels, blades, bolt carriers. */
  steel: 0x9aa1a8,
  steelDark: 0x565c63,
  /** Carpentry: hafts and stocks. */
  wood: 0x6f4a2a,
  woodDark: 0x45301c,
  /** Rounds and the belt that carries them. */
  brass: 0xb08d3f,
  /** Webbing, tape and wrapped handles. */
  wrap: 0x1b1e22,
  /** Steel with a wet edge, for a blade that is meant to read as sharp. */
  blade: 0xc6ccd3,
  /** A crowbar's pitted iron, not a polished tool. */
  rust: 0x6b4a35,
  redPaint: 0xa8231f,
  redPaintWorn: 0x7d2420,
  /** Olive metal, the colour of an ammo box. */
  olive: 0x4a5238,
  oliveDark: 0x333a27,
} as const;

function material(colour: number, roughness: number, metalness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: colour, roughness, metalness });
}

function add(parent: Group, geometry: BufferGeometry, mat: MeshStandardMaterial,
  position: readonly [number, number, number], rotation?: readonly [number, number, number]): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  // A view model sits inside the camera; `normalizeViewModel` clears these flags at load,
  // and the export writes them so a mesh previewed in the store behaves the same way.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Firearms
// ---------------------------------------------------------------------------

/**
 * MP5-class submachine gun.
 *
 * A heavier, better-held version of the pack's own compact SMG: a machined receiver, a
 * barrel shroud, a curved magazine and a solid stock, at about 0.65 m overall. It is the
 * controlled close-quarters weapon the cheap SMG is not.
 */
export function createMp5(): Group {
  const group = new Group();
  group.name = 'WeaponMP5';
  const polymer = material(WEAPON_PALETTE.polymer, 0.75, 0.1);
  const polymerLight = material(WEAPON_PALETTE.polymerLight, 0.7, 0.15);
  const gunmetal = material(WEAPON_PALETTE.gunmetal, 0.5, 0.75);
  const steel = material(WEAPON_PALETTE.steel, 0.35, 0.85);
  const wrap = material(WEAPON_PALETTE.wrap, 0.9, 0.05);

  // Receiver: the slab everything hangs off, from behind the trigger to the handguard.
  add(group, new BoxGeometry(0.055, 0.085, 0.34), polymer, [0, 0.005, 0.06]);
  // Barrel, with a shroud around its base so the front end is not a bare rod.
  add(group, new CylinderGeometry(0.011, 0.011, 0.24, 10), gunmetal, [0, 0.02, 0.34], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.026, 0.026, 0.14, 10), polymerLight, [0, 0.0, 0.28], [Math.PI / 2, 0, 0]);
  // Cocking handle, front post and rear drum: the three small parts that make a
  // rectangular receiver read as a submachine gun rather than a box.
  add(group, new BoxGeometry(0.022, 0.02, 0.05), steel, [0.028, 0.058, 0.16]);
  add(group, new BoxGeometry(0.012, 0.032, 0.02), steel, [0, 0.058, 0.4]);
  add(group, new CylinderGeometry(0.016, 0.016, 0.03, 8), gunmetal, [0, 0.052, 0.02], [Math.PI / 2, 0, 0]);
  // Magazine: two boxes, the lower one tipped further forward. At this size that kink is
  // what reads as the MP5's curved magazine; a lathe would be a lot of triangles for it.
  add(group, new BoxGeometry(0.03, 0.14, 0.055), polymerLight, [0, -0.12, 0.06], [0.22, 0, 0]);
  add(group, new BoxGeometry(0.028, 0.09, 0.05), polymerLight, [0, -0.23, 0.09], [0.42, 0, 0]);
  // Pistol grip with a taped seam, and a solid stock rather than a folding one.
  add(group, new BoxGeometry(0.032, 0.11, 0.045), polymer, [0, -0.09, -0.1], [-0.25, 0, 0]);
  add(group, new BoxGeometry(0.036, 0.022, 0.05), wrap, [0, -0.13, -0.115], [-0.25, 0, 0]);
  add(group, new BoxGeometry(0.03, 0.05, 0.2), polymer, [0, 0.0, -0.16]);
  add(group, new BoxGeometry(0.04, 0.075, 0.04), polymerLight, [0, 0.0, -0.27]);
  return group;
}

/**
 * P90-class bullpup.
 *
 * Bullpup shape: no separate stock, the action sits behind the grip, and the magazine
 * lies flat along the top of the shell with an optic above it. About 0.5 m long, so it is
 * the shortest weapon in the roster and the easiest to swing indoors.
 */
export function createP90(): Group {
  const group = new Group();
  group.name = 'WeaponP90';
  const polymer = material(WEAPON_PALETTE.polymer, 0.72, 0.1);
  const polymerLight = material(WEAPON_PALETTE.polymerLight, 0.68, 0.15);
  const gunmetal = material(WEAPON_PALETTE.gunmetal, 0.5, 0.75);
  const steel = material(WEAPON_PALETTE.steel, 0.35, 0.85);
  const wrap = material(WEAPON_PALETTE.wrap, 0.9, 0.05);

  // One-piece shell. The P90 is a single moulding, not a receiver with a stock bolted on,
  // so the body is one tall slab and everything else is a detail on it.
  add(group, new BoxGeometry(0.06, 0.1, 0.34), polymer, [0, 0.0, 0.03]);
  // Magazine along the top: the weapon's whole silhouette in one box.
  add(group, new BoxGeometry(0.05, 0.022, 0.3), polymerLight, [0, 0.062, 0.02]);
  add(group, new BoxGeometry(0.052, 0.008, 0.3), wrap, [0, 0.078, 0.02]);
  // Short barrel and muzzle brake, poking out past the shell.
  add(group, new CylinderGeometry(0.014, 0.014, 0.14, 10), gunmetal, [0, 0.0, 0.26], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.021, 0.021, 0.03, 10), steel, [0, 0.0, 0.33], [Math.PI / 2, 0, 0]);
  // Thumbhole: a front strap and two cheeks leave the gap the hand goes through.
  add(group, new BoxGeometry(0.05, 0.11, 0.05), polymer, [0, -0.07, -0.03]);
  add(group, new BoxGeometry(0.05, 0.03, 0.08), polymer, [0, -0.03, -0.05]);
  add(group, new BoxGeometry(0.05, 0.11, 0.04), polymer, [0, -0.07, -0.14]);
  // Integrated optic: a tube over the magazine, on a short rail.
  add(group, new BoxGeometry(0.02, 0.012, 0.22), steel, [0, 0.086, 0.03]);
  add(group, new CylinderGeometry(0.03, 0.03, 0.05, 10), gunmetal, [0, 0.108, 0.06], [Math.PI / 2, 0, 0]);
  return group;
}

/**
 * Belt-fed light machine gun with a 150-round box.
 *
 * The heaviest thing on the shelf, and built to look it: a long barrel behind a shroud, a
 * box magazine hanging under the receiver, a belt feeding up into it, a carry handle and a
 * folded bipod. About 1.1 m overall, roughly twice the length of the bullpup.
 */
export function createLmg(): Group {
  const group = new Group();
  group.name = 'WeaponLMG';
  const gunmetal = material(WEAPON_PALETTE.gunmetal, 0.5, 0.75);
  const steelDark = material(WEAPON_PALETTE.steelDark, 0.45, 0.8);
  const steel = material(WEAPON_PALETTE.steel, 0.35, 0.85);
  const polymer = material(WEAPON_PALETTE.polymer, 0.75, 0.1);
  const brass = material(WEAPON_PALETTE.brass, 0.35, 0.85);
  const oliveDark = material(WEAPON_PALETTE.oliveDark, 0.8, 0.2);

  add(group, new BoxGeometry(0.075, 0.11, 0.4), gunmetal, [0, 0, 0.1]);
  // Barrel with a vented-looking shroud and a muzzle brake.
  add(group, new CylinderGeometry(0.013, 0.013, 0.36, 10), steelDark, [0, 0.015, 0.5], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.03, 0.03, 0.16, 10), gunmetal, [0, 0.015, 0.4], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.02, 0.02, 0.05, 10), steel, [0, 0.015, 0.7], [Math.PI / 2, 0, 0]);
  add(group, new BoxGeometry(0.012, 0.035, 0.02), steel, [0, 0.062, 0.62]);
  // Ammo box: the 150 rounds that make this the only weapon the player walks slower with.
  add(group, new BoxGeometry(0.11, 0.14, 0.2), oliveDark, [0, -0.13, 0.12]);
  // Belt climbing from the box into the feed tray.
  add(group, new BoxGeometry(0.03, 0.11, 0.02), brass, [0.05, -0.05, 0.12], [0, 0, 0.3]);
  // Carry handle on posts, so the weapon can be carried over the shoulder.
  add(group, new BoxGeometry(0.02, 0.02, 0.24), gunmetal, [0, 0.09, 0.06]);
  add(group, new BoxGeometry(0.02, 0.05, 0.03), gunmetal, [0, 0.065, -0.05]);
  add(group, new BoxGeometry(0.02, 0.05, 0.03), gunmetal, [0, 0.065, 0.17]);
  // Bipod, folded back along the barrel.
  for (const side of [-1, 1]) {
    add(group, new CylinderGeometry(0.008, 0.008, 0.22, 6), steelDark,
      [side * 0.05, -0.075, 0.52], [0.55, 0, side * 0.7]);
  }
  // Pistol grip, trigger guard and a solid stock with a cheek riser.
  add(group, new BoxGeometry(0.034, 0.11, 0.045), polymer, [0, -0.09, -0.08], [-0.2, 0, 0]);
  add(group, new BoxGeometry(0.03, 0.05, 0.22), gunmetal, [0, -0.01, -0.22]);
  add(group, new BoxGeometry(0.05, 0.08, 0.05), polymer, [0, 0.0, -0.34]);
  return group;
}

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

/**
 * Katana: a wrapped handle, a tsuba at the origin and a long blade built from four
 * segments, each pitched a little further off the axis. That fan is the curvature a katana
 * has; one straight box reads as a machete at any distance the weapon is seen from.
 */
export function createKatana(): Group {
  const group = new Group();
  group.name = 'WeaponKatana';
  const wrap = material(WEAPON_PALETTE.wrap, 0.9, 0.05);
  const blade = material(WEAPON_PALETTE.blade, 0.25, 0.9);
  const steelDark = material(WEAPON_PALETTE.steelDark, 0.4, 0.85);

  add(group, new BoxGeometry(0.028, 0.028, 0.24), wrap, [0, 0, -0.13]);
  // Wrap crosses down the handle, which is what tells a katana's grip from a plain rod.
  for (let index = 0; index < 6; index += 1) {
    add(group, new TorusGeometry(0.019, 0.004, 5, 10), wrap, [0, 0, -0.03 - index * 0.04], [Math.PI / 2, 0, 0]);
  }
  add(group, new CylinderGeometry(0.05, 0.05, 0.009, 12), steelDark, [0, 0, 0.0], [Math.PI / 2, 0, 0]);

  let z = 0.07;
  for (let index = 0; index < 4; index += 1) {
    add(group, new BoxGeometry(0.011, 0.03, 0.2), blade, [0, 0, z], [index * 0.028, 0, 0]);
    z += 0.19;
  }
  // Kissaki: the tip, tapered to a point rather than cut off square.
  add(group, new ConeGeometry(0.015, 0.09, 4), blade, [0, 0.11, z], [Math.PI / 2, 0, 0]);
  return group;
}

/**
 * Machete: a short wrapped handle and a flat blade that widens towards a clipped point.
 * The widening is the whole difference between a machete and a sword at this polygon count.
 */
export function createMachete(): Group {
  const group = new Group();
  group.name = 'WeaponMachete';
  const wrap = material(WEAPON_PALETTE.wrap, 0.9, 0.05);
  const blade = material(WEAPON_PALETTE.blade, 0.35, 0.8);
  const steel = material(WEAPON_PALETTE.steel, 0.3, 0.9);
  const steelDark = material(WEAPON_PALETTE.steelDark, 0.45, 0.8);

  add(group, new CylinderGeometry(0.018, 0.021, 0.17, 8), wrap, [0, 0, -0.09], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.024, 0.024, 0.02, 8), steelDark, [0, 0, 0.0], [Math.PI / 2, 0, 0]);
  add(group, new BoxGeometry(0.008, 0.06, 0.34), blade, [0, 0.01, 0.19]);
  add(group, new BoxGeometry(0.008, 0.075, 0.12), blade, [0, 0.02, 0.4]);
  add(group, new BoxGeometry(0.008, 0.06, 0.1), blade, [0, 0.05, 0.47], [0, -0.45, 0]);
  // Honed edge, a brighter strip down the cutting side so the blade catches the light.
  add(group, new BoxGeometry(0.004, 0.012, 0.5), steel, [0.005, 0.03, 0.3]);
  return group;
}

/**
 * Crowbar: a hexagonal iron bar with a chisel behind the grip and a forked claw at the
 * far end. Six sides rather than a smooth cylinder, because the flat faces are what make a
 * crowbar read as forged rather than machined.
 */
export function createCrowbar(): Group {
  const group = new Group();
  group.name = 'WeaponCrowbar';
  const rust = material(WEAPON_PALETTE.rust, 0.7, 0.6);

  add(group, new CylinderGeometry(0.014, 0.014, 0.62, 6), rust, [0, 0, 0.06], [Math.PI / 2, 0, 0]);
  // Chisel end, behind the grip: squashed flat rather than round, as a real one is.
  add(group, new BoxGeometry(0.034, 0.012, 0.1), rust, [0, 0, -0.28]);
  // Claw: a fork that splits up and forward, with the prying point on the upper arm.
  add(group, new BoxGeometry(0.014, 0.03, 0.16), rust, [0, 0.035, 0.42], [-0.5, 0, 0]);
  add(group, new BoxGeometry(0.014, 0.03, 0.14), rust, [0, 0.03, 0.41], [0.7, 0, 0]);
  add(group, new BoxGeometry(0.012, 0.016, 0.07), rust, [0, 0.095, 0.46], [-0.95, 0, 0]);
  return group;
}

/**
 * Sledgehammer: a long wooden haft, a taped grip and a solid steel head with a face at
 * each end. The head is seated just under the haft's tip so the whole mass sits at the end
 * of the swing, which is what a 1.25 s cooldown is paying for.
 */
export function createSledgehammer(): Group {
  const group = new Group();
  group.name = 'WeaponSledgehammer';
  const wood = material(WEAPON_PALETTE.wood, 0.85, 0.05);
  const wrap = material(WEAPON_PALETTE.wrap, 0.9, 0.08);
  const steel = material(WEAPON_PALETTE.steel, 0.4, 0.85);
  const steelDark = material(WEAPON_PALETTE.steelDark, 0.5, 0.8);

  add(group, new CylinderGeometry(0.019, 0.022, 0.92, 10), wood, [0, 0, 0.2], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.026, 0.026, 0.24, 10), wrap, [0, 0, -0.1], [Math.PI / 2, 0, 0]);
  add(group, new BoxGeometry(0.12, 0.12, 0.28), steel, [0, 0, 0.66]);
  add(group, new CylinderGeometry(0.06, 0.055, 0.03, 12), steelDark, [0, 0, 0.82], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.06, 0.055, 0.03, 12), steelDark, [0, 0, 0.5], [Math.PI / 2, 0, 0]);
  // Eye of the head, where the haft passes through: without it the head looks cast onto
  // the handle instead of hung on it.
  add(group, new BoxGeometry(0.075, 0.075, 0.07), steelDark, [0, 0, 0.66]);
  return group;
}

/**
 * Fire axe: the firefighter's two-handed pattern, longer than the pack's own axe and with
 * a pick on the back of the head. The blade faces +X like every other axe in the project,
 * so a swing that looks right for one looks right for all of them.
 */
export function createFireAxe(): Group {
  const group = new Group();
  group.name = 'WeaponFireAxe';
  const wood = material(WEAPON_PALETTE.wood, 0.85, 0.05);
  const woodDark = material(WEAPON_PALETTE.woodDark, 0.9, 0.05);
  const red = material(WEAPON_PALETTE.redPaint, 0.55, 0.25);
  const redWorn = material(WEAPON_PALETTE.redPaintWorn, 0.7, 0.2);
  const blade = material(WEAPON_PALETTE.blade, 0.3, 0.9);
  const steel = material(WEAPON_PALETTE.steel, 0.35, 0.85);
  const steelDark = material(WEAPON_PALETTE.steelDark, 0.5, 0.8);

  add(group, new CylinderGeometry(0.024, 0.03, 0.98, 10), wood, [0, 0, 0.22], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.034, 0.034, 0.26, 10), woodDark, [0, 0, -0.12], [Math.PI / 2, 0, 0]);
  add(group, new CylinderGeometry(0.03, 0.03, 0.03, 10), steelDark, [0, 0, -0.26], [Math.PI / 2, 0, 0]);
  // Head: painted socket, a broad bit to +X and the pick to -X.
  add(group, new BoxGeometry(0.1, 0.13, 0.2), red, [0, 0, 0.68]);
  add(group, new BoxGeometry(0.26, 0.05, 0.22), redWorn, [0.14, 0, 0.68]);
  add(group, new BoxGeometry(0.05, 0.06, 0.24), blade, [0.28, 0, 0.68]);
  add(group, new ConeGeometry(0.03, 0.24, 6), steel, [-0.16, 0, 0.68], [0, 0, Math.PI / 2]);
  return group;
}

// ---------------------------------------------------------------------------
// Ordnance
// ---------------------------------------------------------------------------

/**
 * Frag grenade.
 *
 * A small ribbed oval with a fuse head, a folded spoon and a pin ring: the three details that
 * make a grenade read as a grenade at arm's length, before it is thrown. About 0.18 m tall, so
 * it is the smallest weapon in the roster — which the view-model scale of 1.1 keeps honest
 * rather than trying to make it look like a gun.
 *
 * Built here rather than in its own module so it can reuse the palette and the `add` helper:
 * a grenade that imported them across modules could not be exported through Node's type
 * stripping, which resolves runtime imports only with explicit file extensions.
 */
export function createGrenade(): Group {
  const group = new Group();
  group.name = 'WeaponGrenade';
  const shell = material(WEAPON_PALETTE.olive, 0.55, 0.45);
  const shellDark = material(WEAPON_PALETTE.oliveDark, 0.7, 0.3);
  const steel = material(WEAPON_PALETTE.steelDark, 0.45, 0.8);

  // Body: an egg rather than a ball, which is the shape a frag grenade actually has. Carried as
  // a node scale, which the exporter writes into the glTF and the loader applies on the way back.
  const body = add(group, new SphereGeometry(0.06, 14, 10), shell, [0, 0, 0]);
  body.scale.set(1, 1.35, 1);
  // Two grooves around the shell: the ridges that read as "grenade" and not "stone".
  for (const offset of [-0.03, 0.03]) {
    add(group, new TorusGeometry(0.0585, 0.006, 6, 16), shellDark, [0, offset, 0], [Math.PI / 2, 0, 0]);
  }
  // Fuse head at the top, the spoon folded down one side, and the pin ring standing off the head.
  add(group, new BoxGeometry(0.036, 0.03, 0.036), steel, [0, 0.088, 0]);
  add(group, new BoxGeometry(0.012, 0.1, 0.006), steel, [0.03, 0.03, 0.046], [0, 0, 0.12]);
  add(group, new TorusGeometry(0.018, 0.004, 5, 10), steel, [-0.036, 0.09, 0], [0, Math.PI / 2, 0]);
  return group;
}

// ---------------------------------------------------------------------------
// The export registry
// ---------------------------------------------------------------------------

export interface ProceduralWeaponModel {
  /** Weapon this mesh belongs to: a `WeaponId` for a firearm, a `MeleeId` for melee. */
  id: WeaponId | MeleeId;
  kind: 'firearm' | 'melee';
  /**
   * File name, without extension, written under `public/assets/weapons/`.
   *
   * Kept as data rather than derived from the id so the id can change (a hyphen, a rename)
   * without silently orphaning the enum the config already names. No underscores-only
   * names are required, but the name is kept to `[A-Za-z0-9_]` because
   * `tests/weapon-assets.test.ts` pins that shape for firearm model paths.
   */
  file: string;
  /** Builds a fresh mesh. Called per export, never cached: a Group cannot be in two scenes. */
  build: () => Group;
}

/**
 * Every code-built weapon mesh, in one place.
 *
 * `tools/export-weapon-models.mjs` walks this list to write the glTF files, and
 * `tests/weapon-roster.test.ts` walks it to check each config entry actually points at the
 * file this list produces — so the mesh, the file and the config cannot drift apart.
 */
export const PROCEDURAL_WEAPONS: readonly ProceduralWeaponModel[] = [
  { id: 'mp5', kind: 'firearm', file: 'MP5', build: createMp5 },
  { id: 'p90', kind: 'firearm', file: 'P90', build: createP90 },
  { id: 'lmg', kind: 'firearm', file: 'LMG', build: createLmg },
  { id: 'katana', kind: 'melee', file: 'Katana', build: createKatana },
  { id: 'machete', kind: 'melee', file: 'Machete', build: createMachete },
  { id: 'crowbar', kind: 'melee', file: 'Crowbar', build: createCrowbar },
  { id: 'sledgehammer', kind: 'melee', file: 'Sledgehammer', build: createSledgehammer },
  { id: 'fire-axe', kind: 'melee', file: 'FireAxe', build: createFireAxe },
];

/** One code-built ordnance mesh, keyed on a `GrenadeId`. */
export interface ProceduralOrdnanceModel {
  id: GrenadeId;
  /** File name, without extension, written under `public/assets/weapons/`. */
  file: string;
  build: () => Group;
}

/**
 * Every code-built ordnance mesh.
 *
 * Kept in its own list rather than appended to `PROCEDURAL_WEAPONS`: that registry is keyed on
 * firearm and melee ids and is checked against those two tables, and `frag` belongs to neither.
 * `tools/export-weapon-models.mjs` walks both lists to write the glTF, so the mesh, the file and
 * the config still cannot drift apart.
 */
export const PROCEDURAL_ORDNANCE: readonly ProceduralOrdnanceModel[] = [
  { id: 'frag', file: 'Grenade', build: createGrenade },
];

/** The model path a weapon's config is expected to name, from this registry. */
export function proceduralWeaponPath(file: string): string {
  return `/assets/weapons/${file}.gltf`;
}
