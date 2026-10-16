import { describe, expect, it } from 'vitest';
import { Group, Mesh, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { MELEE, QUALITY_PRESETS, WEAPONS, type MeleeId, type WeaponId } from '../src/app/gameConfig';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import { DamageSystem } from '../src/combat/DamageSystem';
import type { CollisionWorld } from '../src/level/CollisionWorld';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';
import { WeaponController } from '../src/player/WeaponController';
import { normalizeViewModel } from '../src/player/viewModel';
import {
  WEAPON_MECHANISMS, WeaponMechanism, measureWeaponFrame, mechanismCycleSeconds, mechanismTravel,
  type MechanismKind,
} from '../src/player/weaponMechanism';
import { SeededRandom } from '../src/utils/math';
import type { PlayerController } from '../src/player/PlayerController';
import type { MeleeSystem } from '../src/combat/MeleeSystem';

/**
 * F2: the slide, the bolt and the pump.
 *
 * These tests exercise state, not pixels: a unit test cannot see whether the part that
 * racks back *looks* like a slide, and this host has no browser to photograph it with
 * (agents.md and the work order both forbid it here). What they can hold to, and therefore
 * what they do hold to, is everything the feature promised as a fact: each weapon with a
 * mechanism has exactly one moving part and it is a separate object from the weapon's own
 * meshes; the part moves back and returns within the shot's own timing; the weapon's
 * ballistics are untouched; and the muzzle — where the flash and the tracer come from —
 * does not move by so much as a float bit.
 *
 * The models are the shipped glTF files, loaded through the same `GLTFLoader` and
 * normalised by the same `normalizeViewModel` the game calls, so nothing here is measured
 * against a hand-made stand-in.
 */

// The pack's files carry embedded textures, and GLTFLoader decodes them through browser
// globals node does not have. Only geometry is measured, so stub bitmaps are enough.
(globalThis as unknown as { self?: unknown }).self = globalThis;
if (typeof globalThis.ProgressEvent !== 'function') {
  (globalThis as unknown as { ProgressEvent: unknown }).ProgressEvent = class ProgressEvent {
    constructor(public type: string, init: Record<string, unknown> = {}) {
      Object.assign(this, init);
    }
  };
}
if (typeof globalThis.createImageBitmap !== 'function') {
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
    async () => ({ width: 1, height: 1, close() {} });
}

const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const FIREARMS = Object.keys(WEAPONS) as WeaponId[];
const MECHANISED: WeaponId[] = ['pistol', 'rifle', 'shotgun', 'smg', 'mp5', 'p90', 'lmg'];

function fileFor(modelPath: string): string {
  const name = modelPath.split('/').pop() ?? '';
  const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
  expect(key, `${modelPath} is not among the shipped weapon files`).toBeTruthy();
  return WEAPON_FILES[key ?? ''];
}

async function load(modelPath: string): Promise<Group> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
    loader.parse(fileFor(modelPath), '', resolve, reject);
  });
  return gltf.scene;
}

/** The shipped view models, normalised exactly as `Game.loadViewModels` normalises them. */
let templatesPromise: Promise<Map<WeaponId, Object3D>> | null = null;
function modelTemplates(): Promise<Map<WeaponId, Object3D>> {
  templatesPromise ??= (async () => {
    const models = new Map<WeaponId, Object3D>();
    for (const id of FIREARMS) models.set(id, normalizeViewModel(await load(WEAPONS[id].modelPath)));
    return models;
  })();
  return templatesPromise;
}

/**
 * A private copy of every firearm's view model.
 *
 * A copy per caller, not the loaded original: a mechanism parents its moving part to the
 * mesh it was built against, so two tests sharing one model would count each other's parts
 * — and each rig would be measuring a mesh with three slides on it. `clone` is the same
 * call `Game.previewModelFor` makes, and it shares geometry and materials, so nothing here
 * measures a different mesh than the one the game draws.
 */
async function firearmModels(): Promise<Map<WeaponId, Object3D>> {
  const templates = await modelTemplates();
  const models = new Map<WeaponId, Object3D>();
  for (const [id, template] of templates) models.set(id, template.clone(true));
  return models;
}

interface Rig {
  weapons: WeaponController;
  camera: PerspectiveCamera;
  models: Map<WeaponId, Object3D>;
}

/**
 * A controller over the real meshes, with a real `DamageSystem` and a player stub.
 *
 * The damage system is the shipping one with nothing in front of the muzzle: firing has to
 * go through the real `tryFire` path for the mechanism to be started from the same place the
 * game starts it, and a hit is not what is under test. The player is a stub because
 * `tryFire` reads its eye position and adds recoil to it, and the controller never asks it
 * anything else.
 */
async function rig(options: { weaponMechanisms?: boolean } = {}): Promise<Rig> {
  const models = await firearmModels();
  const camera = new PerspectiveCamera(76, 900 / 363, 0.08, 420);
  camera.position.set(0, 1.62, 0);
  camera.updateMatrixWorld(true);
  const events = new EventBus<GameEvents>();
  const damage = new DamageSystem({
    director: { list: [], hitboxTargets: () => [] } as unknown as ZombieDirector,
    collision: { raycast: () => null } as unknown as CollisionWorld,
    events,
    random: new SeededRandom(3),
  });
  const player = {
    eyePosition: new Vector3(0, 1.62, 0),
    facingAngle: 0,
    addRecoil: () => {},
  } as unknown as PlayerController;
  const weapons = new WeaponController({
    camera,
    events,
    damage,
    player,
    melee: {} as unknown as MeleeSystem,
    viewModels: models,
    ...(options.weaponMechanisms === undefined ? {} : { weaponMechanisms: options.weaponMechanisms }),
  });
  for (const id of FIREARMS) weapons.grantWeapon(id);
  return { weapons, camera, models };
}

/** Switches to a weapon and lets the equip drop play out, as the harness does. */
function equip(weapons: WeaponController, id: WeaponId): void {
  weapons.switchTo(id);
  weapons.update(0.3, null, true);
}

/** Every mesh below `root` that this feature added, by the name it was given. */
function mechanismParts(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((child) => {
    if ((child as Mesh).isMesh && child.name.startsWith('weapon-mechanism:')) found.push(child as Mesh);
  });
  return found;
}

/**
 * Local transforms of every node below `root` except the moving part.
 *
 * The part is excluded by name and the test separately asserts there is exactly one of
 * them, so this is "the weapon's own geometry" rather than "whatever happened to be there".
 */
function bodyTransforms(root: Object3D): Array<[string, [number, number, number]]> {
  const seen: Array<[string, [number, number, number]]> = [];
  root.traverse((child) => {
    if (child.name.startsWith('weapon-mechanism:')) return;
    seen.push([`${child.name}@${child.id}`, [child.position.x, child.position.y, child.position.z]]);
  });
  return seen;
}

function mechanismOf(weapons: WeaponController, id: WeaponId): {
  kind: string; parts: number; travel: number; offset: number; distance: number;
} {
  const found = weapons.mechanismReport.weapons.find((entry) => entry.weaponId === id);
  expect(found, `${id} has no mechanism at all`).toBeTruthy();
  return found ?? { kind: 'none', parts: 0, travel: 0, offset: 0, distance: 0 };
}

/**
 * Runs one full mechanism cycle of `id`, sampling the travel as it goes.
 *
 * Stepped rather than jumped to a time: the peak is a point on a curve whose length comes
 * from the weapon's own cadence, and a test that jumped there with a hand-written duration
 * would pass even if the curve were flat.
 */
function runCycle(weapons: WeaponController, id: WeaponId, step = 0.002): {
  peakTravel: number; peakOffset: number; activeSeen: boolean;
} {
  // Let the weapon's own fire cadence come round first: a shot fired inside its cooldown is
  // refused, and this helper is about the mechanism, not about the trigger being ready.
  const cycle = mechanismCycleSeconds(WEAPONS[id]);
  weapons.update(cycle * 2 + 0.05, null, true);
  expect(weapons.tryFire(), `${id}: the trigger was refused`).not.toBeNull();
  let peakTravel = 0;
  let peakOffset = 0;
  let activeSeen = false;
  for (let elapsed = 0; elapsed <= cycle * 1.05; elapsed += step) {
    weapons.update(step, null, true);
    const state = mechanismOf(weapons, id);
    peakTravel = Math.max(peakTravel, state.travel);
    peakOffset = Math.max(peakOffset, state.offset);
    if (weapons.mechanismReport.running === id) activeSeen = true;
  }
  return { peakTravel, peakOffset, activeSeen };
}

describe('the mechanism profile', () => {
  it('starts at rest, reaches full travel, and is home again by the end of the cycle', () => {
    for (const kind of ['slide', 'bolt', 'pump'] as MechanismKind[]) {
      expect(mechanismTravel(0, kind), kind).toBe(0);
      expect(mechanismTravel(1, kind), kind).toBe(0);
      let peak = 0;
      for (let step = 0; step <= 1; step += 0.001) peak = Math.max(peak, mechanismTravel(step, kind));
      // A mechanism whose curve never reaches the back is one that visibly does nothing.
      expect(peak, kind).toBe(1);
    }
  });

  it('gives the pump a pause at the rear, which a slide and a bolt do not have', () => {
    // Read as back-click-forward: the distinction the shotgun's action is supposed to have.
    expect(mechanismTravel(0.4, 'pump')).toBe(1);
    expect(mechanismTravel(0.45, 'pump')).toBe(1);
    // A blowback slide is already on its way home in that part of its cycle.
    expect(mechanismTravel(0.45, 'slide')).toBeLessThan(1);
    expect(mechanismTravel(0.5, 'bolt')).toBeLessThan(1);
    // And the lighter part gets back sooner: at the same point in their cycles the slide is
    // much further along than the bolt.
    expect(mechanismTravel(0.35, 'slide')).toBe(1);
    expect(mechanismTravel(0.35, 'bolt')).toBeLessThan(1);
    expect(mechanismTravel(0.3, 'slide')).toBeGreaterThan(mechanismTravel(0.3, 'bolt'));
  });

  it('takes its cycle from the weapon own cadence, not from a table of new numbers', () => {
    // The interval between shots is the cycle: the part that moved is the part that has to
    // be home before the next round. Where the flash is longer than the interval (the belt
    // gun's 60 ms against 83 ms), the flash is the floor — a mechanism hidden inside it is
    // a mechanism nobody sees.
    expect(mechanismCycleSeconds(WEAPONS.pistol)).toBeCloseTo(1 / WEAPONS.pistol.fireRate, 9);
    expect(mechanismCycleSeconds(WEAPONS.shotgun)).toBeCloseTo(1 / WEAPONS.shotgun.fireRate, 9);
    expect(mechanismCycleSeconds(WEAPONS.lmg))
      .toBeCloseTo(WEAPONS.lmg.muzzleFlashSeconds * 2, 9);
    for (const id of MECHANISED) {
      expect(mechanismCycleSeconds(WEAPONS[id]), id)
        .toBeGreaterThanOrEqual(WEAPONS[id].muzzleFlashSeconds * 2 - 1e-9);
    }
    // The pump is the slow one by a wide margin, which is what makes it read as a pump.
    expect(mechanismCycleSeconds(WEAPONS.shotgun))
      .toBeGreaterThan(mechanismCycleSeconds(WEAPONS.pistol) * 3);
  });

  it('decides what moves on every firearm, and nothing else', () => {
    // A `Record<WeaponId, …>`: a weapon added to the table without a mechanism is a type
    // error rather than a silent omission.
    expect(Object.keys(WEAPON_MECHANISMS).sort()).toEqual([...FIREARMS].sort());
    for (const id of FIREARMS) {
      const spec = WEAPON_MECHANISMS[id];
      expect(['slide', 'bolt', 'pump'], id).toContain(spec.kind);
      expect(spec.station, id).toBeGreaterThan(0);
      expect(spec.station, id).toBeLessThan(1);
      expect(spec.travel, id).toBeGreaterThan(0);
      // Travel is a fraction of the weapon's own length: a value this large would mean the
      // part leaves the weapon entirely.
      expect(spec.travel, id).toBeLessThan(0.3);
    }
    // The three weapons the work order names by hand, each with the action it has.
    expect(WEAPON_MECHANISMS.pistol.kind).toBe('slide');
    expect(WEAPON_MECHANISMS.rifle.kind).toBe('bolt');
    expect(WEAPON_MECHANISMS.shotgun.kind).toBe('pump');
  });
});

describe('a mechanism on the shipped mesh', () => {
  it('measures each weapon own axis rather than assuming one', async () => {
    const models = await firearmModels();
    // The convention is +Z towards the muzzle, and the pistol and the rifle follow it.
    for (const id of ['pistol', 'rifle', 'mp5'] as WeaponId[]) {
      const frame = measureWeaponFrame(models.get(id) as Object3D);
      expect(Math.abs(frame.yaw), `${id} is not along its own +Z`).toBeLessThan(0.15);
      expect(frame.length, id).toBeGreaterThan(0);
      expect(frame.height, id).toBeGreaterThan(0);
    }
    // The shotgun and the SMG — both extracted from the survivor bundle — are turned inside
    // their own space. This is the reason the frame is measured at all: a fixed +Z offset
    // would put their moving part in mid-air beside them.
    const shotgun = measureWeaponFrame(models.get('shotgun') as Object3D);
    const smg = measureWeaponFrame(models.get('smg') as Object3D);
    expect(Math.abs(shotgun.yaw), 'the shotgun is diagonal, and that has to be measured')
      .toBeGreaterThan(0.3);
    expect(Math.abs(smg.yaw), 'the SMG is diagonal, and that has to be measured').toBeGreaterThan(0.3);
    // And the measured surface height at a station is inside the body's own vertical extent.
    const frame = measureWeaponFrame(models.get('pistol') as Object3D);
    expect(frame.topAt(0.5)).toBeLessThanOrEqual(frame.centreAt(0.5) + frame.height);
    expect(frame.topAt(0.5)).toBeGreaterThan(frame.centreAt(0.5) - frame.height);
  });

  it('builds exactly one moving part per weapon, separate from the weapon own meshes', async () => {
    const models = await firearmModels();
    for (const id of MECHANISED) {
      const model = models.get(id) as Object3D;
      const mechanism = new WeaponMechanism(model, WEAPON_MECHANISMS[id]);
      const parts = mechanism.parts;
      expect(parts.length, id).toBe(1);
      const part = parts[0];
      // Parented to the weapon, and not one of the weapon's own meshes: a part that was the
      // body would move the whole gun.
      expect(part.parent, id).toBe(model);
      expect(part.name, id).toBe(`weapon-mechanism:${WEAPON_MECHANISMS[id].kind}`);
      expect(part.geometry.getAttribute('position').count, id).toBeGreaterThan(8);
      expect(mechanism.kind, id).toBe(WEAPON_MECHANISMS[id].kind);
      // Travel is a real distance in the mesh's own units, not zero.
      expect(mechanism.travelDistance, id).toBeGreaterThan(0);
      expect(mechanism.offset, id).toBe(0);
    }
  });

  it('returns the part to exactly its rest position when the cycle ends', async () => {
    const models = await firearmModels();
    for (const id of MECHANISED) {
      const model = models.get(id) as Object3D;
      const mechanism = new WeaponMechanism(model, WEAPON_MECHANISMS[id]);
      const rest = mechanism.restPosition;
      expect(mechanism.parts[0].position.toArray(), id).toEqual(rest.toArray());

      mechanism.trigger(WEAPONS[id]);
      const cycle = mechanismCycleSeconds(WEAPONS[id]);
      let peak = 0;
      for (let elapsed = 0; elapsed < cycle; elapsed += cycle / 200) {
        mechanism.update(cycle / 200);
        peak = Math.max(peak, mechanism.offset);
      }
      // It went back — by most of its travel — and it came home.
      expect(peak, `${id}: the part did not move`).toBeGreaterThan(mechanism.travelDistance * 0.9);
      // The last step of the cycle lands on or past the end: the part is at rest, exactly.
      while (mechanism.active) mechanism.update(cycle / 200);
      expect(mechanism.parts[0].position.toArray(), `${id}: the part did not come home`)
        .toEqual(rest.toArray());
      expect(mechanism.offset, id).toBe(0);
    }
  });

  it('moves only the part: the weapon own meshes keep their transforms', async () => {
    const models = await firearmModels();
    for (const id of MECHANISED) {
      const model = models.get(id) as Object3D;
      const mechanism = new WeaponMechanism(model, WEAPON_MECHANISMS[id]);
      const rest = mechanism.restPosition;
      const before = bodyTransforms(model);
      // Exactly one part, so "everything but the part" is a complete description of the
      // weapon's own geometry rather than a list with a hole in it.
      expect(mechanismParts(model), id).toHaveLength(1);
      mechanism.trigger(WEAPONS[id]);
      const cycle = mechanismCycleSeconds(WEAPONS[id]);
      // Stopped at the back of its travel rather than run to the end: a cycle that has
      // finished is a part that is home again, which proves nothing about the middle.
      let peak: [number, number, number] = rest.toArray();
      for (let step = 0; step < 30; step += 1) {
        // Three quarters of the way through: the part is out or on its way home, and the
        // cycle is still in flight, so the transform comparison below is between "at rest"
        // and "moving", not between two resting states.
        mechanism.update(cycle / 40);
        if (mechanism.travel > 0.95) peak = mechanism.parts[0].position.toArray();
      }
      const after = bodyTransforms(model);
      // Same nodes, same local transforms — including the root the whole weapon is drawn
      // from, which is what makes this a moving part rather than a moving weapon.
      expect(mechanism.active, `${id}: the cycle was already over`).toBe(true);
      expect(after).toEqual(before);
      // And the part is the one thing that did move.
      expect(peak, `${id}: the part never left its rest position`).not.toEqual(rest.toArray());
      const travelled = Math.hypot(peak[0] - rest.x, peak[1] - rest.y, peak[2] - rest.z);
      expect(travelled, id).toBeGreaterThan(mechanism.travelDistance * 0.9);
    }
  });

  it('can be switched off, and then leaves the part at rest', async () => {
    const models = await firearmModels();
    const model = models.get('pistol') as Object3D;
    const mechanism = new WeaponMechanism(model, WEAPON_MECHANISMS.pistol, false);
    const rest = mechanism.restPosition;
    expect(mechanism.isEnabled).toBe(false);
    // A trigger from a disabled mechanism does nothing at all rather than starting a cycle
    // that is never advanced.
    mechanism.trigger(WEAPONS.pistol);
    expect(mechanism.active).toBe(false);
    mechanism.update(0.02);
    expect(mechanism.parts[0].position.toArray()).toEqual(rest.toArray());
    // Turned back on, it works: the switch is the only difference.
    mechanism.setEnabled(true);
    mechanism.trigger(WEAPONS.pistol);
    expect(mechanism.active).toBe(true);
    mechanism.update(mechanismCycleSeconds(WEAPONS.pistol) * 0.35);
    expect(mechanism.offset).toBeGreaterThan(0);
    // And switching it off mid-cycle parks it where it belongs.
    mechanism.setEnabled(false);
    expect(mechanism.parts[0].position.toArray()).toEqual(rest.toArray());
  });
  it('takes its part back off the weapon again on teardown', async () => {
    const models = await firearmModels();
    const model = models.get('rifle') as Object3D;
    const mechanism = new WeaponMechanism(model, WEAPON_MECHANISMS.rifle);
    expect(mechanismParts(model)).toHaveLength(1);
    mechanism.dispose();
    // Nothing of the mechanism is left on the mesh a later run would draw.
    expect(mechanismParts(model)).toHaveLength(0);
  });
});

describe('the mechanism in the player hands', () => {
  it('reports the axis each part was measured against', async () => {
    const { weapons } = await rig();
    const yawOf = (id: WeaponId): number =>
      weapons.mechanismReport.weapons.find((entry) => entry.weaponId === id)?.yawDeg ?? Number.NaN;
    // Two of the shipped meshes are turned inside their own space, and the report says so:
    // this is the measurement a fixed +Z offset could not have survived.
    expect(Math.abs(yawOf('shotgun')), 'the shotgun').toBeGreaterThan(30);
    expect(Math.abs(yawOf('smg')), 'the SMG').toBeGreaterThan(30);
    // The rest obey the convention, so their parts sit on their own axis.
    for (const id of ['pistol', 'rifle', 'mp5', 'p90', 'lmg'] as WeaponId[]) {
      expect(Math.abs(yawOf(id)), id).toBeLessThan(10);
    }
    for (const entry of weapons.mechanismReport.weapons) {
      expect(entry.bodyLength, entry.weaponId).toBeGreaterThan(0);
      expect(Number.isFinite(entry.yawDeg), entry.weaponId).toBe(true);
    }
  });

  it('gives every firearm a part and starts none of them moving', async () => {
    const { weapons } = await rig();
    const report = weapons.mechanismReport;
    expect(report.enabled).toBe(true);
    expect(report.running).toBeNull();
    expect(report.weapons.map((entry) => entry.weaponId).sort()).toEqual([...FIREARMS].sort());
    for (const id of FIREARMS) {
      const entry = mechanismOf(weapons, id);
      expect(entry.parts, id).toBe(1);
      expect(entry.kind, id).toBe(WEAPON_MECHANISMS[id].kind);
      expect(entry.travel, id).toBe(0);
      expect(entry.offset, id).toBe(0);
    }
  });

  it('racks back and returns on a shot, for each weapon with an action', async () => {
    const { weapons } = await rig();
    for (const id of MECHANISED) {
      equip(weapons, id);
      const before = mechanismOf(weapons, id);
      const cycle = runCycle(weapons, id);
      const after = mechanismOf(weapons, id);
      expect(cycle.activeSeen, `${id}: the mechanism never ran`).toBe(true);
      expect(cycle.peakTravel, `${id}: the part never reached the back`).toBeGreaterThan(0.9);
      expect(cycle.peakOffset, `${id}: the part moved no distance`).toBeGreaterThan(before.distance * 0.9);
      // Back where it started, and not running.
      expect(after.travel, `${id}: the part did not return`).toBe(0);
      expect(after.offset, id).toBe(0);
      expect(weapons.mechanismReport.running, id).toBeNull();
      // Only the weapon in hand was ever running.
      for (const other of FIREARMS) {
        if (other === id) continue;
        expect(mechanismOf(weapons, other).travel, `${other} moved while ${id} was drawn`).toBe(0);
      }
    }
  });

  it('does not move the muzzle the flash and the tracer leave from', async () => {
    /**
     * Two identical rigs, the same shot, the same frames — one with the mechanism and one
     * without it.
     *
     * Comparing "before the shot" with "at the back of the travel" inside one rig would not
     * answer this: a shot kicks the weapon (WEAPON_FEEL), so the muzzle moves a centimetre
     * or so on its own in the frames after a trigger pull, and that movement is the shot
     * feeling like a shot. Holding the trigger timeline constant and changing only the
     * mechanism is the comparison that isolates what this feature did.
     */
    const withMechanism = await rig();
    const withoutMechanism = await rig({ weaponMechanisms: false });
    for (const id of FIREARMS) {
      // Both rigs see exactly the same thing: same weapon, same equip settle, same shot.
      equip(withMechanism.weapons, id);
      equip(withoutMechanism.weapons, id);
      const fired = withMechanism.weapons.tryFire();
      expect(fired, `${id}: the shot was refused`).not.toBeNull();
      expect(withoutMechanism.weapons.tryFire(), id).not.toBeNull();

      const cycle = mechanismCycleSeconds(WEAPONS[id]);
      let peakTravel = 0;
      let muzzleAtPeak: Vector3 | null = null;
      let muzzleWithoutAtPeak: Vector3 | null = null;
      for (let step = 0; step <= 200; step += 1) {
        withMechanism.weapons.update(cycle / 200, null, true);
        withoutMechanism.weapons.update(cycle / 200, null, true);
        withMechanism.camera.updateMatrixWorld(true);
        withoutMechanism.camera.updateMatrixWorld(true);

        // The whole path, frame by frame, not just the peak: a mechanism that nudged the
        // muzzle at any point in the cycle would be a flash drawn away from the barrel.
        const withMuzzle = withMechanism.weapons.muzzleWorldPosition.clone();
        const withoutMuzzle = withoutMechanism.weapons.muzzleWorldPosition.clone();
        expect(withMuzzle.x, `${id} muzzle x at frame ${step}`).toBe(withoutMuzzle.x);
        expect(withMuzzle.y, `${id} muzzle y at frame ${step}`).toBe(withoutMuzzle.y);
        expect(withMuzzle.z, `${id} muzzle z at frame ${step}`).toBe(withoutMuzzle.z);

        const state = mechanismOf(withMechanism.weapons, id);
        if (state.travel > peakTravel) {
          peakTravel = state.travel;
          muzzleAtPeak = withMuzzle;
          muzzleWithoutAtPeak = withoutMuzzle;
        }
      }
      // The comparison is only worth anything if the window it was taken over actually
      // contained the retraction.
      expect(peakTravel, `${id}: the part never reached the back`).toBeGreaterThan(0.9);
      expect((muzzleAtPeak as Vector3).toArray(), id)
        .toEqual((muzzleWithoutAtPeak as Vector3).toArray());
    }
  });

  it('leaves the weapon itself where it was, down to its own transform', async () => {
    const { weapons } = await rig();
    for (const id of FIREARMS) {
      equip(weapons, id);
      const model = weapons.mountedModel as Object3D;
      const positionAtRest = model.position.clone();
      const quaternionAtRest = model.quaternion.clone();
      const scaleAtRest = model.scale.clone();
      const viewScaleAtRest = weapons.mountedViewModelScale;

      const cycle = mechanismCycleSeconds(WEAPONS[id]);
      weapons.update(cycle * 2 + 0.05, null, true);
      expect(weapons.tryFire(), `${id}: the shot was refused`).not.toBeNull();
      let peakTravel = 0;
      for (let step = 0; step <= 200; step += 1) {
        weapons.update(cycle / 200, null, true);
        peakTravel = Math.max(peakTravel, mechanismOf(weapons, id).travel);
      }
      expect(peakTravel, id).toBeGreaterThan(0.9);
      // Identical: the mechanism is a part on the weapon, not a movement of it.
      expect(model.position.toArray(), id).toEqual(positionAtRest.toArray());
      expect(model.quaternion.toArray(), id).toEqual(quaternionAtRest.toArray());
      expect(model.scale.toArray(), id).toEqual(scaleAtRest.toArray());
      expect(weapons.mountedViewModelScale, id).toBe(viewScaleAtRest);
    }
  });

  it('leaves damage, fire rate, magazine and spread exactly as they were', async () => {
    const table = JSON.parse(JSON.stringify(WEAPONS)) as typeof WEAPONS;
    const { weapons } = await rig();
    for (const id of MECHANISED) {
      equip(weapons, id);
      const magazineBefore = weapons.snapshot.magazine;
      runCycle(weapons, id);
      // One round spent, and one round only: the mechanism is a visual, not a second shot.
      expect(weapons.snapshot.magazine, id).toBe(magazineBefore - 1);
      expect(weapons.snapshot.weaponId, id).toBe(id);
    }
    // The config table is what the ballistics read from, so it is the thing to compare:
    // every damage, cadence, magazine and spread value the game shipped is still there.
    expect(WEAPONS).toEqual(table);
    expect(WEAPONS.pistol.damage).toBe(table.pistol.damage);
    expect(WEAPONS.rifle.fireRate).toBe(table.rifle.fireRate);
    expect(WEAPONS.shotgun.magazineSize).toBe(table.shotgun.magazineSize);
    expect(WEAPONS.lmg.spread).toBe(table.lmg.spread);
  });

  it('parks the part when the weapon is put away, and never draws one half open', async () => {
    const { weapons } = await rig();
    equip(weapons, 'pistol');
    weapons.tryFire();
    // Part way through the cycle, and then the weapon is swapped.
    weapons.update(mechanismCycleSeconds(WEAPONS.pistol) * 0.35, null, true);
    expect(mechanismOf(weapons, 'pistol').travel).toBeGreaterThan(0.9);
    expect(weapons.switchTo('rifle')).toBe(true);
    expect(mechanismOf(weapons, 'pistol').travel, 'the slide stayed open in the rack').toBe(0);
    // Back to it: it is shut, and firing again starts a fresh cycle.
    expect(weapons.switchTo('pistol')).toBe(true);
    expect(mechanismOf(weapons, 'pistol').travel).toBe(0);
    const cycle = runCycle(weapons, 'pistol');
    expect(cycle.activeSeen).toBe(true);
    // A run restart parks everything too.
    weapons.tryFire();
    weapons.update(mechanismCycleSeconds(WEAPONS.pistol) * 0.35, null, true);
    weapons.reset();
    for (const id of FIREARMS) expect(mechanismOf(weapons, id).travel, id).toBe(0);
  });

  it('is switched off by the quality preset without breaking anything else', async () => {
    const { weapons } = await rig({ weaponMechanisms: false });
    const report = weapons.mechanismReport;
    expect(report.enabled).toBe(false);
    // The parts are still built — the weapon must not change shape between tiers — but
    // nothing moves, and a shot still spends its round.
    expect(report.weapons).toHaveLength(FIREARMS.length);
    equip(weapons, 'shotgun');
    const magazineBefore = weapons.snapshot.magazine;
    const cycle = runCycle(weapons, 'shotgun');
    expect(cycle.activeSeen).toBe(false);
    expect(cycle.peakTravel).toBe(0);
    expect(cycle.peakOffset).toBe(0);
    expect(weapons.snapshot.magazine).toBe(magazineBefore - 1);
    expect(mechanismOf(weapons, 'shotgun').parts).toBe(1);

    // Every tier answers the question, so a preset cannot silently lack the switch.
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(typeof QUALITY_PRESETS[tier].weaponMechanisms, tier).toBe('boolean');
    }
  });

  it('does nothing at all for melee weapons and the grenade', async () => {
    // The models those two use, loaded the way the game loads them, plus one firearm so the
    // mechanism report has something in it: this is about what happens *around* the
    // firearms, not about a controller with no weapons at all.
    const meleeModels = new Map<MeleeId, Object3D>();
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      meleeModels.set(id, normalizeViewModel(await load(MELEE[id].modelPath)));
    }
    const grenade = normalizeViewModel(await load('/assets/weapons/Grenade.gltf'));
    const firearms = new Map<WeaponId, Object3D>();
    firearms.set('pistol', normalizeViewModel(await load(WEAPONS.pistol.modelPath)));

    const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
    const events = new EventBus<GameEvents>();
    const weapons = new WeaponController({
      camera,
      events,
      damage: {
        fire: () => ({ target: 'none', zone: 'body', killed: false, kind: null, damage: 0 }),
      } as unknown as DamageSystem,
      player: {
        eyePosition: new Vector3(0, 1.62, 0),
        facingAngle: 0,
        addRecoil: () => {},
      } as unknown as PlayerController,
      melee: {
        swing: () => ({ target: 'none', targetId: null, damage: 0 }),
      } as unknown as MeleeSystem,
      viewModels: firearms,
      meleeViewModels: meleeModels,
      grenadeViewModel: grenade,
    });

    // Two paths, neither of which may throw and neither of which may attach a part: the
    // mechanism table is keyed by firearm id, and neither of these is one.
    expect(weapons.equipMelee('katana')).toBe(true);
    weapons.update(0.05, null, true);
    weapons.tryMelee();
    weapons.update(0.2, null, true);
    expect(weapons.switchTo('pistol')).toBe(true);
    weapons.update(0.05, null, true);
    expect(weapons.equipOrdnance()).toBe(true);
    weapons.update(0.05, null, true);
    weapons.update(0, null, true);

    for (const id of Object.keys(MELEE) as MeleeId[]) {
      expect(mechanismParts(meleeModels.get(id) as Object3D), id).toHaveLength(0);
    }
    expect(mechanismParts(grenade), 'the grenade').toHaveLength(0);
    // And the report describes the firearm, not the melee weapon or the grenade.
    expect(weapons.mechanismReport.weapons.map((entry) => entry.weaponId)).toEqual(['pistol']);
    for (const entry of weapons.mechanismReport.weapons) expect(entry.travel, entry.weaponId).toBe(0);
  });
});
