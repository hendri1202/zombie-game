import { describe, expect, it } from 'vitest';
import { Group, Mesh, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { WEAPON_FEEL, WEAPONS, type WeaponId } from '../src/app/gameConfig';
import { WeaponController } from '../src/player/WeaponController';
import { normalizeViewModel } from '../src/player/viewModel';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import type { PlayerController } from '../src/player/PlayerController';

/**
 * Where each firearm actually is on screen, measured rather than configured.
 *
 * `view-model-scale.test.ts` reads `mountedViewModelScale` and passed with values that draw
 * almost nothing: the LMG shipped at the largest multiplier in the game (1.6) and the
 * deepest hold of any weapon (-0.66), which made it the longest firearm in the world
 * (0.417 m) while covering *less* of the frame than the P90 — 1410 px against 2220 px of the
 * harness's own 900x363 — and that is how it came to be read off a photograph as "the LMG
 * model is not rendered". The scale was right and the picture was wrong; no assertion on a
 * number can tell those two apart.
 *
 * So these tests mount every firearm through the real `WeaponController` — the same wrapper,
 * the same per-weapon scale, the same parent camera, the same shipped glTF files normalised
 * by the same `normalizeViewModel` the game calls — and then measure what the camera gets:
 * no vertex clipped by the near plane or off the frame, the bounding box meeting the
 * frustum, a non-trivial silhouette, and the belt-fed gun drawing the largest silhouette of
 * the roster. A weapon pushed behind the camera, scaled away, or grown until the near plane
 * eats it fails here; a weapon whose scale is merely different does not.
 */

// The pack's own files carry embedded textures, and GLTFLoader decodes them through browser
// globals that node does not have. Only geometry is measured here, so stub bitmaps are
// enough and no canvas is needed.
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

/** The harness photographs a 900x363 canvas: the frame every measurement here is taken in. */
const FRAME_WIDTH = 900;
const FRAME_HEIGHT = 363;
/** Game builds its camera as PerspectiveCamera(76, aspect, 0.08, 420). */
const FOV = 76;
const NEAR = 0.08;
const FAR = 420;
/** Arm's length: a view model nearer than this is through the camera, further is a prop. */
const MIN_DISTANCE = 0.2;
const MAX_DISTANCE = 1.5;

/**
 * The shipped glTF files, read through Vite's raw glob rather than `node:fs`, which keeps
 * this test on the same `vite/client` types as the rest of the suite.
 */
const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** Loads the shipped models and normalises them exactly as `Game.loadViewModels` does. */
async function loadViewModels(): Promise<Map<WeaponId, Object3D>> {
  const loader = new GLTFLoader();
  const models = new Map<WeaponId, Object3D>();
  for (const id of Object.keys(WEAPONS) as WeaponId[]) {
    const name = WEAPONS[id].modelPath.split('/').pop();
    const key = Object.keys(WEAPON_FILES).find((path) => path.endsWith(`/${name}`));
    expect(key, `${id}: ${WEAPONS[id].modelPath} is missing`).toBeTruthy();
    if (!key) continue;
    const scene = await new Promise<Group>((resolve, reject) => {
      loader.parse(WEAPON_FILES[key], '', (gltf) => resolve(gltf.scene as Group), reject);
    });
    models.set(id, normalizeViewModel(scene));
  }
  return models;
}

interface Rig {
  weapons: WeaponController;
  camera: PerspectiveCamera;
}

async function rig(): Promise<Rig> {
  const camera = new PerspectiveCamera(FOV, FRAME_WIDTH / FRAME_HEIGHT, NEAR, FAR);
  const weapons = new WeaponController({
    camera,
    events: new EventBus<GameEvents>(),
    damage: {} as unknown as DamageSystem,
    player: {} as unknown as PlayerController,
    melee: {} as unknown as MeleeSystem,
    viewModels: await loadViewModels(),
  });
  for (const id of Object.keys(WEAPONS) as WeaponId[]) weapons.grantWeapon(id);
  // The camera carries the view model, so it has to be posed before anything is measured:
  // at the player's eye height, as the game puts it.
  camera.position.set(0, 1.62, 0);
  camera.updateMatrixWorld(true);
  return { weapons, camera };
}

/** Every vertex of the mounted model, as the camera would have to draw it. */
function verticesOf(model: Object3D, camera: PerspectiveCamera): {
  total: number; undrawable: number; near: number; far: number; forwardReach: number;
} {
  camera.updateMatrixWorld(true);
  const eye = camera.getWorldPosition(new Vector3());
  const forward = camera.getWorldDirection(new Vector3());
  const vertex = new Vector3();
  let total = 0;
  let undrawable = 0;
  let near = Number.POSITIVE_INFINITY;
  let far = 0;
  let forwardReach = 0;
  model.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.attributes.position;
    for (let index = 0; index < position.count; index += 1) {
      vertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
      const distance = vertex.distanceTo(eye);
      near = Math.min(near, distance);
      far = Math.max(far, distance);
      forwardReach = Math.max(forwardReach, vertex.clone().sub(eye).dot(forward));
      total += 1;
      vertex.project(camera);
      // Off the edge of the frame, or behind the near plane, is clipped and never seen.
      if (Math.abs(vertex.x) > 1 || Math.abs(vertex.y) > 1 || distance <= camera.near) undrawable += 1;
    }
  });
  return { total, undrawable, near, far, forwardReach };
}

/**
 * How many of the frame's pixels the mounted model covers.
 *
 * Rasterised here on purpose: "is the gun on screen, and how big is it" is a photograph's
 * question and the one the scale-only test could not ask. Triangles are filled with a
 * bounding-box prefilter, which is exact enough for a pixel count and needs no renderer.
 */
function silhouettePixels(model: Object3D, camera: PerspectiveCamera): number {
  camera.updateMatrixWorld(true);
  const covered = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  const vertex = new Vector3();
  const triangle = [new Vector3(), new Vector3(), new Vector3()];
  model.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      let clipped = false;
      for (let k = 0; k < 3; k += 1) {
        const at = index ? index.getX(i + k) : i + k;
        vertex.fromBufferAttribute(position, at).applyMatrix4(mesh.matrixWorld).project(camera);
        triangle[k].copy(vertex);
        if (Math.abs(vertex.z) > 1) clipped = true;
      }
      // A triangle the near plane cuts is drawn clipped or not at all: dropping it keeps
      // this a floor on the covered pixels rather than an over-count.
      if (clipped) continue;
      const points = triangle.map((p) => [(p.x + 1) / 2 * FRAME_WIDTH, (1 - p.y) / 2 * FRAME_HEIGHT]);
      const [[ax, ay], [bx, by], [cx, cy]] = points;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(FRAME_WIDTH - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(FRAME_HEIGHT - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / area;
          const w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / area;
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          covered[y * FRAME_WIDTH + x] = 1;
        }
      }
    }
  });
  let pixels = 0;
  for (const value of covered) pixels += value;
  return pixels;
}

/** Frames a weapon is lowered for after a swap; the harness photographs it once it is up. */
const EQUIP_SETTLE_SECONDS = 0.3;

/** Switches weapon and lets the equip drop play out, as the harness does before a frame. */
function equip(weapons: WeaponController, id: WeaponId): void {
  weapons.switchTo(id);
  // The holder is dropped and pitched down for WEAPON_EQUIP_SECONDS after a swap, so a
  // measurement taken immediately would describe the weapon mid-raise, off the bottom of
  // the frame, and would pass or fail for a reason no player ever sees.
  weapons.update(EQUIP_SETTLE_SECONDS, null, true);
}

describe('the four original firearms keep their captured-frame placement', () => {
  it('leaves their multiplier and hold untouched', () => {
    // Fixing the new weapons must not move the old ones: these are the values the existing
    // photographs were signed off against.
    const reference: Record<string, [number, number, number]> = {
      pistol: [0.26, -0.24, -0.5],
      rifle: [0.24, -0.22, -0.62],
      smg: [0.24, -0.22, -0.56],
      shotgun: [0.27, -0.24, -0.58],
    };
    for (const [id, position] of Object.entries(reference)) {
      expect(WEAPONS[id as WeaponId].viewModel.scale, id).toBe(1);
      expect(WEAPONS[id as WeaponId].viewModel.position, id).toEqual(position);
    }
  });
});

describe('every firearm is mounted where the camera can draw it', () => {
  it('draws no part of any weapon outside the frame, behind the eye or into the near plane',
    async () => {
      const { weapons, camera } = await rig();
      for (const id of Object.keys(WEAPONS) as WeaponId[]) {
        equip(weapons, id);
        const model = weapons.mountedModel;
        expect(model, `${id}: nothing is mounted in the holder`).not.toBeNull();
        expect((model as Object3D).parent, `${id}: the model is detached from the holder`)
          .not.toBeNull();

        const framing = verticesOf(model as Object3D, camera);
        expect(framing.total, `${id}: the model has no vertices`).toBeGreaterThan(0);
        expect(framing.undrawable, `${id}: part of the model cannot be drawn at all`).toBe(0);
        expect(framing.near, `${id}: the model reaches into the camera`).toBeGreaterThan(MIN_DISTANCE);
        expect(framing.far, `${id}: the model is drawn beyond arm's length`).toBeLessThan(MAX_DISTANCE);
        expect(silhouettePixels(model as Object3D, camera), `${id}: the model covers no pixels`)
          .toBeGreaterThan(80);
      }
    });

  it('puts the belt-fed LMG clearly ahead of the bullpup on screen, not only in the table',
    async () => {
      const { weapons, camera } = await rig();
      const measured = new Map<WeaponId, number>();
      for (const id of Object.keys(WEAPONS) as WeaponId[]) {
        equip(weapons, id);
        measured.set(id, silhouettePixels(weapons.mountedModel as Object3D, camera));
      }
      const lmg = measured.get('lmg') as number;
      const p90 = measured.get('p90') as number;
      const mp5 = measured.get('mp5') as number;

      // The owner's requirement as pixels rather than as a multiplier: the heaviest weapon
      // on the shelf has to read as the biggest one, by a margin a player can see. At 1.6
      // and a hold of -0.66 this was 1410 against the P90's 2220 and the test failed, which
      // is the point of measuring here instead of reading the scale back.
      expect(lmg, 'the LMG must read bigger than the bullpup').toBeGreaterThan(p90 * 1.2);
      expect(lmg, 'the LMG must read bigger than the MP5').toBeGreaterThan(mp5 * 1.2);
      // A fix for one weapon that hides another is not a fix.
      expect(mp5).toBeGreaterThan(0);
      expect(p90).toBeGreaterThan(0);
    });
});

describe('the muzzle flash lands at the barrel, not inside it', () => {
  it('keeps the fixed flash offset at or beyond every firearm muzzle', async () => {
    const { weapons, camera } = await rig();
    // WEAPON_FEEL.muzzleOffset is a fixed offset from the holder in camera space, so a
    // weapon scaled past it would have its flash drawn inside the barrel: the trap this
    // per-weapon scale walks into, and the reason the LMG cannot simply be scaled again.
    const flashAheadOfHolder = -WEAPON_FEEL.muzzleOffset[2];
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      equip(weapons, id);
      const model = weapons.mountedModel as Object3D;
      const barrelTip = verticesOf(model, camera).forwardReach;
      const flash = Math.abs(WEAPONS[id].viewModel.position[2]) + flashAheadOfHolder;
      expect(flash, `${id}: the muzzle flash is drawn inside the barrel`)
        .toBeGreaterThanOrEqual(barrelTip - 0.01);
    }
  });
});
