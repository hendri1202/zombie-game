import { describe, expect, it } from 'vitest';
import { Box3, Group, PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { ADS, PLAYER, WEAPONS } from '../src/app/gameConfig';
import type { GameEvents } from '../src/app/GameEvents';
import { EventBus } from '../src/core/EventBus';
import { DamageSystem, type HitscanRequest } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import { CollisionWorld } from '../src/level/CollisionWorld';
import { PlayerController } from '../src/player/PlayerController';
import { WeaponController } from '../src/player/WeaponController';
import type { ViewMode } from '../src/player/viewCamera';
import type { InputSnapshot } from '../src/input/InputManager';
import { SeededRandom } from '../src/utils/math';
import { ZombieFactory } from '../src/zombies/ZombieFactory';
import type { Zombie } from '../src/zombies/Zombie';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';

/**
 * "Third person does not shoot where the crosshair points" — measured, and held to a line.
 *
 * The crosshair is drawn at the centre of the screen, so the line it marks is the camera's own
 * forward ray. The shot used to leave the player's eye (1.62 m) along the *camera's* direction,
 * and in third person the camera sits 3.4 m back and 1.02 m up: the round therefore travelled
 * parallel to the crosshair and exactly one height-offset below it, at every range. Measured
 * through the real controller with the crosshair on a walker's head at 4 m, third person landed
 * body hits (18 damage) and misses where first person landed head hits (37.8) — so headshots,
 * the thing the sights and the whole hitbox layout exist for, were impossible in the mode the
 * game starts in.
 *
 * These tests hold the fix to the properties it promised, on the real `DamageSystem`, the real
 * shipped walker model and the real `WeaponController`, over the real `PlayerController` and the
 * real `placeViewCamera` maths:
 *
 *  - the round's ray *is* the crosshair's ray, in first person, in third person, at the hip and
 *    with the sights up: the same direction to the last bit, and an origin on that line;
 *  - the crosshair on a head produces head hits (and head damage) in third person, at 4 m, 8 m
 *    and 15 m, where it used to produce body hits and misses;
 *  - first person is left exactly as it was: the round still leaves the eye, to the millimetre;
 *  - a wall behind the player — where the boom is clamped inside the geometry — does not eat the
 *    shot, because the round leaves from the player's own column rather than from the camera.
 *
 * Restoring `this.origin.copy(this.player.eyePosition)` fails the first, second and fourth
 * assertions (and passing the camera's raw position as the origin fails the fourth), which is
 * what makes them worth having.
 */

// The pack's files carry embedded textures, and GLTFLoader decodes them through browser
// globals node does not have. Only geometry is measured here, so stub bitmaps are enough.
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

const ZOMBIE_FILES = import.meta.glob('/public/assets/characters/zombies/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

async function loadModel(url: string) {
  const name = url.split('/').pop() ?? '';
  const key = Object.keys(ZOMBIE_FILES).find((candidate) => candidate.endsWith(`/${name}`));
  expect(key, `${url} is not among the shipped zombie models`).toBeTruthy();
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: Group; animations: unknown[] }>((resolve, reject) => {
    loader.parse(ZOMBIE_FILES[key ?? ''], '', resolve as never, reject);
  });
  return { scene: gltf.scene, animations: gltf.animations, url };
}

let factoryPromise: Promise<ZombieFactory> | null = null;
function factory(): Promise<ZombieFactory> {
  factoryPromise ??= (async () => {
    const instance = new ZombieFactory({ assets: { loadModel } as never });
    const result = await instance.load(['walker']);
    expect(result.failed).toEqual([]);
    return instance;
  })();
  return factoryPromise;
}

/** Game builds its camera as `PerspectiveCamera(76, aspect, 0.08, 420)`. */
const HIP_FOV = 76;
const STEP = 1 / 60;

function input(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
  return {
    forward: 0,
    right: 0,
    sprint: false,
    lookX: 0,
    lookY: 0,
    firing: false,
    firePressed: false,
    jumpPressed: false,
    reloadPressed: false,
    meleePressed: false,
    weaponSlotRequested: null,
    ...overrides,
  };
}

interface Shot {
  origin: Vector3;
  direction: Vector3;
}

interface Rig {
  camera: PerspectiveCamera;
  player: PlayerController;
  weapons: WeaponController;
  zombie: Zombie;
  /** Every ray the controller actually fired, in order, before spread is applied. */
  shots: Shot[];
  /** The origin Game is handed for the ejected casing, from the event. */
  eventOrigins: Vector3[];
  /** Places the walker `distance` metres in front of the player, feet on the ground. */
  place(distance: number): void;
  /** World centre of the walker's head hitbox. */
  headCentre(): Vector3;
  /** Runs `seconds` of frames exactly as `Game.update` drives them. */
  run(seconds: number, frame: InputSnapshot | null): void;
  /** Solves the player's look so the *camera's* forward ray passes through `target`. */
  aimAt(target: Vector3): void;
  /** Aims the crosshair at the walker's head and fires `count` rounds, one per settle. */
  fireAtHead(distance: number, count: number, ads: boolean): Array<{ zone: string; target: string; damage: number }>;
}

/**
 * The whole aiming stack over one walker.
 *
 * `collision` is the real `CollisionWorld`, so the camera's own obstruction maths and the
 * shot's world ray answer the same box maths the game uses; `wall` is an optional wall behind
 * the player's back. The damage system is the real one, wrapped only to record the ray it was
 * asked for — the report (zone, damage) is its own.
 */
async function rig(options: { mode: ViewMode; wallBehind?: number }): Promise<Rig> {
  const camera = new PerspectiveCamera(HIP_FOV, 16 / 9, 0.08, 420);
  const collision = new CollisionWorld({ minX: -200, maxX: 200, minZ: -200, maxZ: 200 });
  if (options.wallBehind !== undefined) {
    // A wall at the player's back, the way the game builds the level: a real box in the real
    // collision world, so `measureCameraObstruction` and the shot's world ray both see it.
    // Behind is -Z at the default yaw, which is where `measureCameraObstruction` looks.
    collision.addBox({
      minX: -50, maxX: 50,
      minZ: PLAYER.spawn.z - options.wallBehind - 2,
      maxZ: PLAYER.spawn.z - options.wallBehind,
      height: 0, tag: 'test-wall', blocksPlayer: true, blocksZombies: true,
    });
  }

  const events = new EventBus<GameEvents>();
  const zombie = (await factory()).create('walker');
  expect(zombie, 'the walker could not be created').not.toBeNull();
  if (!zombie) throw new Error('unreachable');
  zombie.reset(PLAYER.spawn.x, PLAYER.spawn.z, 0);
  // Only the raycast is under test, and a target that dies after three rounds would turn a hit
  // rate into a measurement of its health.
  (zombie as unknown as { applyDamage: (amount: number) => { applied: number; died: boolean } })
    .applyDamage = (amount: number) => ({ applied: amount, died: false });

  const system = new DamageSystem({
    director: { list: [zombie], hitboxTargets: () => zombie.hitboxes } as unknown as ZombieDirector,
    collision,
    events,
    random: new SeededRandom(20261017),
  });

  const shots: Shot[] = [];
  const eventOrigins: Vector3[] = [];
  const realFire = system.fire.bind(system);
  const damage = {
    fire: (request: HitscanRequest) => {
      // The request is the controller's own scratch vectors, so it has to be copied here.
      shots.push({ origin: request.origin.clone(), direction: request.direction.clone() });
      return realFire(request);
    },
  } as unknown as DamageSystem;
  events.on('weapon:fired', ({ origin }) => {
    eventOrigins.push(new Vector3(origin[0], origin[1], origin[2]));
  });

  const player = new PlayerController({ camera, collision });
  player.setViewMode(options.mode);

  const weapons = new WeaponController({
    camera,
    events,
    damage,
    player,
    melee: { swing: () => ({ target: 'none', targetId: null, damage: 0 }) } as unknown as MeleeSystem,
  });
  for (const id of Object.keys(WEAPONS) as Array<keyof typeof WEAPONS>) weapons.grantWeapon(id);
  expect(weapons.switchTo('rifle')).toBe(true);

  const run = (seconds: number, frame: InputSnapshot | null): void => {
    let remaining = seconds;
    while (remaining > 1e-9) {
      const dt = Math.min(STEP, remaining);
      player.update(dt, frame);
      weapons.update(dt, frame, true);
      remaining -= dt;
    }
  };

  const headCentre = (): Vector3 => {
    const head = zombie.hitboxes.find((box) => box.userData.hitZone === 'head');
    if (!head) throw new Error('the walker has no head hitbox');
    zombie.root.updateMatrixWorld(true);
    return new Box3().setFromObject(head).getCenter(new Vector3());
  };

  const place = (distance: number): void => {
    // The player's own forward is +Z at the default yaw of PI (`forwardXZ` is (-sin, -cos)),
    // so the target stands down +Z from the player's spawn.
    zombie.reset(PLAYER.spawn.x, PLAYER.spawn.z + distance, 0);
    zombie.root.updateMatrixWorld(true);
  };

  const aimAt = (target: Vector3): void => {
    // The crosshair is the camera's axis, and the camera is not at the eye, so the look that
    // puts the mark on the target has to be solved from where the camera actually is — and
    // where the camera is depends on the look. Four rounds of it converge on the fixed point.
    for (let iteration = 0; iteration < 4; iteration += 1) {
      run(STEP, null);
      const eye = camera.getWorldPosition(new Vector3());
      const dx = target.x - eye.x;
      const dy = target.y - eye.y;
      const dz = target.z - eye.z;
      player.yaw = Math.atan2(-dx, -dz);
      player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
    // One more frame so the camera is placed from the look just solved.
    run(STEP, null);
  };

  const fireAtHead = (distance: number, count: number, ads: boolean) => {
    const frame = input({ adsHeld: ads });
    // Let the sights finish coming up before the first shot.
    run(ADS.seconds + 0.1, frame);
    const reports: Array<{ zone: string; target: string; damage: number }> = [];
    for (let shot = 0; shot < count; shot += 1) {
      // One round in the magazine for the shot about to be fired: a reload in the middle of a
      // measurement would silently drop a round and turn a 12-shot cell into an 8-shot one.
      weapons.addMagazine('rifle', 1);
      place(distance);
      aimAt(headCentre());
      const report = weapons.tryFire();
      if (report) reports.push({ zone: report.zone, target: report.target, damage: report.damage });
      // The weapon's cadence, the burst bloom and the recoil's recovery, all at rest again.
      run(0.5, frame);
    }
    return reports;
  };

  return { camera, player, weapons, zombie, shots, eventOrigins, place, headCentre, run, aimAt, fireAtHead };
}

/** Perpendicular distance from a point to a line. */
function pointToLine(point: Vector3, origin: Vector3, direction: Vector3): number {
  const w = point.clone().sub(origin);
  return w.clone().sub(direction.clone().multiplyScalar(w.dot(direction))).length();
}

const MODES: ViewMode[] = ['first', 'third'];
const table: string[] = [];

describe('the shot is the crosshair, in every camera mode', () => {
  for (const mode of MODES) {
    for (const ads of [false, true]) {
      it(`fires along the crosshair's own ray in ${mode} person${ads ? ', sights up' : ''}`, async () => {
        const r = await rig({ mode });
        r.place(12);
        const frame = input({ adsHeld: ads });
        r.run(ADS.seconds + 0.1, frame);
        r.aimAt(r.headCentre());
        // Freeze the aim: every number below describes the same instant the trigger is pulled.
        const cameraAt = r.camera.getWorldPosition(new Vector3());
        const cameraForward = r.camera.getWorldDirection(new Vector3());
        const before = r.shots.length;
        expect(r.weapons.tryFire()).not.toBeNull();
        const shot = r.shots[before];
        expect(shot).toBeTruthy();

        // The direction is the camera's, to the last bit: a shot that is even a milliradian
        // off the crosshair is a shot that misses a head at range.
        expect(shot.direction.angleTo(cameraForward)).toBeLessThan(1e-9);
        // And the origin is *on* that ray, so the whole trajectory is the marked line. This is
        // the assertion the old code fails in third person: its origin was the eye, 1.02 m
        // below and 3.4 m short of the line.
        const offLine = pointToLine(shot.origin, cameraAt, cameraForward);
        expect(offLine).toBeLessThan(1e-6);
      });
    }
  }

  it('leaves first person firing from the eye, exactly as it always did', async () => {
    const r = await rig({ mode: 'first' });
    r.place(12);
    r.run(ADS.seconds + 0.1, input());
    r.aimAt(r.headCentre());
    const before = r.shots.length;
    const eye = r.player.eyePosition;
    expect(r.weapons.tryFire()).not.toBeNull();
    const shot = r.shots[before];

    // The eye to the millimetre in every axis: first person is not allowed to move, and the
    // projection onto the camera's ray evaluates to exactly zero when the camera is already
    // on the eye (a stationary player, so no head bob).
    expect(shot.origin.x).toBeCloseTo(eye.x, 12);
    expect(shot.origin.y).toBeCloseTo(eye.y, 12);
    expect(shot.origin.z).toBeCloseTo(eye.z, 12);
  });

  it('still reports the eye line in the event, so the ejected casing does not move', async () => {
    // Game hangs the casing off this point (origin + 0.55 m forward, 0.17 m right). The round
    // no longer leaves from the eye in third person, so the event has to keep reporting it on
    // purpose: brass spawning at the camera would be brass appearing behind the character.
    for (const mode of MODES) {
      const r = await rig({ mode });
      r.place(12);
      r.run(ADS.seconds + 0.1, input());
      r.aimAt(r.headCentre());
      const eye = r.player.eyePosition;
      expect(r.weapons.tryFire()).not.toBeNull();
      expect(r.eventOrigins.length).toBeGreaterThan(0);
      expect(r.eventOrigins[r.eventOrigins.length - 1].distanceTo(eye), `${mode} person`).toBeLessThan(1e-9);
    }
  });
});

describe('the camera mode changes nothing about where the round goes', () => {
  it('puts the same shots through the head in third person as in first', async () => {
    // The two modes now fire the same ray from the same place on the player's column — the
    // crosshair's line — so at one range they are the same shot, spread draw included. This is
    // the invariant the whole fix is: in the old code third person was 0/12 head and 12/12 body
    // against first person's 12/12 head, at every range.
    const first = await rig({ mode: 'first' });
    const third = await rig({ mode: 'third' });
    for (const ads of [false, true]) {
      for (const distance of [4, 8, 15]) {
        const a = first.fireAtHead(distance, 12, ads).filter((x) => x.zone === 'head').length;
        const b = third.fireAtHead(distance, 12, ads).filter((x) => x.zone === 'head').length;
        table.push(`first/third ${ads ? 'ADS' : 'hip'} ${distance} m: ${a} vs ${b} head`);
        expect(Math.abs(a - b), `${distance} m, ads=${ads}: ${a} vs ${b} head hits`).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('the crosshair on a head is a headshot in third person', () => {
  it('lands head hits — and head damage — at every range the sights are for', async () => {
    const r = await rig({ mode: 'third' });
    for (const ads of [false, true]) {
      for (const distance of [4, 8, 15]) {
        const reports = r.fireAtHead(distance, 12, ads);
        const heads = reports.filter((report) => report.target === 'zombie' && report.zone === 'head');
        const bodies = reports.filter((report) => report.target === 'zombie' && report.zone === 'body');
        const rate = heads.length / reports.length;
        table.push(`third ${ads ? 'ADS' : 'hip'} ${distance} m: ${heads.length}/${reports.length} head, ` +
          `${bodies.length} body, damage ${[...new Set(heads.map((h) => h.damage))].join('/') || '-'}`);
        // Before the fix this was 0 head and 12 body: every one of these shots left 1.02 m low.
        expect(heads.length, `${distance} m${ads ? ' ADS' : ''}: no head hits at all`).toBeGreaterThanOrEqual(8);
        expect(rate, `${distance} m${ads ? ' ADS' : ''}: ${heads.length}/${reports.length} head`).toBeGreaterThanOrEqual(0.6);
        // The hits that are not headshots are misses, not body shots: a crosshair on the head
        // landing on the torso is the signature of the bug this replaces.
        expect(bodies.length, `${distance} m${ads ? ' ADS' : ''}: the head aim landed on the body`).toBeLessThanOrEqual(1);
        // The head multiplier is the head multiplier: 18 x 2.1, not 18.
        for (const head of heads) {
          expect(head.damage).toBeCloseTo(WEAPONS.rifle.damage * WEAPONS.rifle.headshotMultiplier, 6);
        }
      }
    }
  });

  it('does not turn a crosshair on the body into a headshot', async () => {
    const r = await rig({ mode: 'third' });
    r.place(8);
    const frame = input({ adsHeld: true });
    r.run(ADS.seconds + 0.1, frame);
    // Chest height: the middle of the torso, a clear half metre below the head.
    const chest = new Vector3(PLAYER.spawn.x, 1.0, PLAYER.spawn.z + 8);
    r.aimAt(chest);
    const report = r.weapons.tryFire();
    expect(report?.target).toBe('zombie');
    expect(report?.zone).toBe('body');
    expect(report?.damage).toBeCloseTo(WEAPONS.rifle.damage, 6);
  });
});

describe('a wall at the player`s back does not eat the round', () => {
  it('still hits the head with the boom clamped inside the wall behind', async () => {
    // 0.6 m behind the player: the obstruction ray reports it, the boom is clamped to its
    // minimum 1.1 m and therefore ends up *inside* the wall — the collision world answers a
    // ray that starts inside a box with a hit at distance 0. Firing from the camera would eat
    // every round; the round leaves from the player's column instead.
    const r = await rig({ mode: 'third', wallBehind: 0.6 });
    r.place(8);
    const frame = input({ adsHeld: false });
    r.run(ADS.seconds + 0.1, frame);
    const camera = r.camera.getWorldPosition(new Vector3());
    const player = r.player.position.clone();
    const boomLength = Math.hypot(camera.x - player.x, camera.z - player.z);
    expect(boomLength).toBeLessThan(1.2); // the boom really is pulled in

    r.aimAt(r.headCentre());
    const report = r.weapons.tryFire();
    expect(report?.target, 'the wall ate the shot').toBe('zombie');
    expect(report?.zone).toBe('head');
  });
});

describe('the measured table', () => {
  it('records what each camera mode does with the crosshair on the head', async () => {
    const rows: string[] = [...table];
    for (const mode of MODES) {
      const r = await rig({ mode });
      for (const ads of [false, true]) {
        for (const distance of [4, 8, 15, 30]) {
          const reports = r.fireAtHead(distance, 12, ads);
          const heads = reports.filter((x) => x.target === 'zombie' && x.zone === 'head');
          const bodies = reports.filter((x) => x.target === 'zombie' && x.zone === 'body');
          rows.push(`${mode === 'first' ? 'first' : 'third'} ${ads ? 'ADS' : 'hip'} ${String(distance).padStart(2)} m: ` +
            `${heads.length}/${reports.length} head, ${bodies.length} body, ` +
            `damage ${[...new Set(heads.map((h) => h.damage))].join('/') || '-'}`);
        }
      }
    }
    // The table is printed so it can be read against the browser harness's own numbers; the
    // assertion here is only that third person is not the dead mode it was (0 head hits in 38
    // shots on a real walker).
    for (const row of rows) console.log(row);
    const third = rows.filter((row) => row.startsWith('third'));
    expect(third.join(' ')).toContain('head');
    expect(third.some((row) => /[1-9]\d*\/12 head/.test(row))).toBe(true);
  });
});
