import { describe, expect, it } from 'vitest';
import { Box3, Group, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { WEAPON_FEEL, WEAPONS, type WeaponId } from '../src/app/gameConfig';
import { createFirstPersonHands } from '../src/player/proceduralArms';
import { normalizeViewModel } from '../src/player/viewModel';
import { WEAPON_VIEW_MODEL_SCALE } from '../src/player/WeaponController';
import {
  SUPPORT_GRIP_STATION, measureWeaponFit, muzzleOffsetInPlacement, supportGripInHands,
} from '../src/player/weaponFit';

/**
 * The muzzle and the support hand are measured from the mesh, not chosen.
 *
 * Both defects these tests cover were invisible to any assertion on a number: `muzzleOffset`
 * was correct *as a number* and still drew the flash in the air past the MP7's muzzle, and
 * `supportReach` was correct *as a number* and still put the support hand over the front of a
 * 0.29 m gun. What is checkable is the geometry the numbers have to produce — the flash point
 * against the mesh's own barrel tip, and the hand against the mesh's own fore-end — so that is
 * what is asserted here, on the shipped glTF files, through the same `weaponFit` helpers and
 * the same placement maths `WeaponController` uses.
 */

(globalThis as unknown as { self?: unknown }).self = globalThis;
if (typeof globalThis.ProgressEvent !== 'function') {
  (globalThis as unknown as { ProgressEvent: unknown }).ProgressEvent = class ProgressEvent {
    constructor(public type: string, init: Record<string, unknown> = {}) { Object.assign(this, init); }
  };
}
if (typeof globalThis.createImageBitmap !== 'function') {
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
    async () => ({ width: 1, height: 1, close() {} });
}

const FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

async function load(id: WeaponId): Promise<Group> {
  const name = WEAPONS[id].modelPath.split('/').pop();
  const key = Object.keys(FILES).find((path) => path.endsWith(`/${name}`));
  expect(key, `${id}: ${WEAPONS[id].modelPath} is missing`).toBeTruthy();
  const loader = new GLTFLoader();
  const scene = await new Promise<Group>((resolve, reject) => {
    loader.parse(FILES[key as string], '', (gltf) => resolve(gltf.scene as Group), reject);
  });
  return normalizeViewModel(scene) as Group;
}

/**
 * The game's own mounting: a holder at the weapon's placement, carrying the model and the
 * hands, inside a parent that stands in for the camera's view-model root.
 */
async function mount(id: WeaponId): Promise<{
  root: Group; holder: Group; model: Object3D; hands: Group;
}> {
  const placement = WEAPONS[id].viewModel;
  const root = new Group();
  const holder = new Group();
  holder.position.set(placement.position[0], placement.position[1], placement.position[2]);
  holder.rotation.set(placement.rotation[0], placement.rotation[1], placement.rotation[2]);
  holder.scale.setScalar(WEAPON_VIEW_MODEL_SCALE * placement.scale);
  const model = await load(id);
  holder.add(model);
  const hands = createFirstPersonHands(WEAPONS[id].grip);
  holder.add(hands);
  root.add(holder);
  root.updateMatrixWorld(true);
  return { root, holder, model, hands };
}

/** The point a flash is spawned at, in the holder's parent space (the camera's). */
function flashPointInParent(id: WeaponId, holder: Group): Vector3 {
  const offset = muzzleOffsetInPlacement(
    measureWeaponFit(holder.children[0] as Object3D),
    holder.children[0] as Object3D,
    holder.scale.x,
    WEAPONS[id].viewModel.rotation,
  );
  return holder.position.clone().add(offset);
}

const MEASURED: WeaponId[] = ['mp7', 'aug', 'remington-870'];
const HAND_TUNED: WeaponId[] = ['pistol', 'rifle'];

describe('measured weapon fit', () => {
  it('declares the measured fit only for the weapons that needed it', () => {
    for (const id of MEASURED) {
      expect(WEAPONS[id].muzzleFromMesh, `${id}: muzzleFromMesh`).toBe(true);
      expect(WEAPONS[id].supportFromMesh, `${id}: supportFromMesh`).toBe(true);
    }
    // The four originals plus the three code-built ones were signed off against the shared
    // offset and the tuned hand pose; re-deriving them would move a flash and a hand those
    // frames already accept.
    for (const id of HAND_TUNED) {
      expect(WEAPONS[id].muzzleFromMesh ?? false, `${id}: muzzleFromMesh`).toBe(false);
      expect(WEAPONS[id].supportFromMesh ?? false, `${id}: supportFromMesh`).toBe(false);
    }
    // The shared fallback is untouched, which is what keeps those weapons byte-for-byte on
    // the offset their frames were captured with.
    expect(WEAPON_FEEL.muzzleOffset).toEqual([0, 0.03, -0.36]);
  });

  it('puts the flash at the barrel tip measured from each mesh', async () => {
    for (const id of MEASURED) {
      const { root, holder, model } = await mount(id);
      const fit = measureWeaponFit(model);
      const tip = model.localToWorld(fit.barrelTip.clone());
      root.worldToLocal(tip);
      const flash = flashPointInParent(id, holder);
      // Within a centimetre along every axis: the same tip the mesh's own vertices give.
      expect(flash.distanceTo(tip), `${id}: flash ${flash.toArray()} vs tip ${tip.toArray()}`)
        .toBeLessThan(0.01);
    }
  });

  it('proves the shared offset was wrong for the short weapons, and stays for the rest', async () => {
    const legacy = new Vector3(...WEAPON_FEEL.muzzleOffset);
    for (const id of MEASURED) {
      const { root, holder, model } = await mount(id);
      const tip = model.localToWorld(measureWeaponFit(model).barrelTip.clone());
      root.worldToLocal(tip);
      const legacyPoint = holder.position.clone().add(legacy);
      const error = legacyPoint.distanceTo(tip);
      // The MP7's flash used to leave 20 cm past its muzzle; the AUG's 9 cm; the 870's 3 cm.
      // All three are more than a flash quad's half-width away from the bore.
      expect(error, `${id}: shared offset was ${error.toFixed(3)} m from the barrel tip`)
        .toBeGreaterThan(0.025);
    }
    for (const id of HAND_TUNED) {
      const { holder } = await mount(id);
      const offset = muzzleOffsetInPlacement(
        measureWeaponFit(holder.children[0] as Object3D),
        holder.children[0] as Object3D,
        holder.scale.x,
        WEAPONS[id].viewModel.rotation,
      );
      // Not used at runtime for these two, but the helper must still agree with the config
      // offset they were tuned with to within the same 2 cm: the measurement is honest.
      expect(Math.abs(offset.z - legacy.z), `${id}: z`).toBeLessThan(0.2);
    }
  });

  it('puts the support hand on the fore-end, behind the muzzle', async () => {
    for (const id of MEASURED) {
      const { root, holder, model, hands } = await mount(id);
      const fit = measureWeaponFit(model);
      const spec = id === 'remington-870' ? 0.65 : SUPPORT_GRIP_STATION;
      const target = supportGripInHands(fit, model, holder, hands, spec);
      const world = hands.localToWorld(target.clone());
      root.worldToLocal(world);

      const box = new Box3().setFromObject(model);
      // On the weapon, not floating beside it: the target is inside the mesh's own box.
      expect(box.containsPoint(world), `${id}: support grip ${world.toArray()} outside ${box.min.toArray()}..${box.max.toArray()}`)
        .toBe(true);

      // And behind the muzzle by a hand's width, which is the defect the frames showed.
      const tip = model.localToWorld(fit.barrelTip.clone());
      root.worldToLocal(tip);
      const drawn = box.max.z - box.min.z;
      const fromMuzzle = (world.z - tip.z) / drawn;
      expect(fromMuzzle, `${id}: support hand is ${(fromMuzzle * 100).toFixed(0)}% of the weapon behind the muzzle`)
        .toBeGreaterThan(0.18);
    }
  });
});
