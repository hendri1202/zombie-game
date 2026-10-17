import { describe, expect, it } from 'vitest';
import { Box3, Group, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { ADS, WEAPONS, ZOMBIE_TYPES, type ZombieKind, type WeaponId } from '../src/app/gameConfig';
import type { GameEvents } from '../src/app/GameEvents';
import type { CollisionWorld } from '../src/level/CollisionWorld';
import { DamageSystem } from '../src/combat/DamageSystem';
import { EventBus } from '../src/core/EventBus';
import { SeededRandom } from '../src/utils/math';
import { ZombieFactory } from '../src/zombies/ZombieFactory';
import type { Zombie } from '../src/zombies/Zombie';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';

/**
 * "Shots miss a zombie that is already in range" — measured, not judged.
 *
 * The owner's report was that hits sometimes do not land on a zombie the crosshair was on at
 * a range the weapon reaches. The cause was in the hitbox layout, and it is a number: the
 * torso capsule is sized `height * 0.74` while the head sphere is put at the top of the model,
 * which left a band at neck height belonging to neither box. At zero spread a walker was
 * unhittable between 1.33 m and 1.42 m, a Runner between 1.24 m and 1.33 m and a Brute between
 * 1.57 m and 1.67 m — at every distance, from the first metre out. The player's own eye is at
 * 1.62 m, so that band sat exactly on the crosshair of anyone level with a Brute, and the Brute
 * could not be hit by a level shot at all: measured 0% at 3 m and 5 m with every weapon, hip
 * *and* sights, where a Walker was 100%.
 *
 * These tests hold the fix to the behaviour it promised, on the models the game ships and the
 * real `DamageSystem`, `ZombieFactory` and weapon table:
 *
 *  - no hole anywhere in the silhouette: a shot at any height of the body hits it, at both
 *    close and medium range;
 *  - hits at the range the owner actually fights at are reliable (a level shot at a zombie
 *    standing on the same ground, and a shot at its centre of mass);
 *  - the sights measurably improve the long shots and change nothing up close — which is the
 *    honest answer to "holding right click does not help me aim", and it is asserted rather
 *    than assumed;
 *  - a zombie past the weapon's range is still never hit, so the wider boxes did not turn the
 *    roster into hit-scan artillery.
 *
 * Restoring `bodyHeight = Math.max(0.6, height * 0.74)` fails the first, second and fourth
 * assertions, which is what makes them worth having.
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

/** Player eye height, `PLAYER.eyeHeight` — the line the crosshair sits on when looking level. */
const EYE = 1.62;
const KINDS: ZombieKind[] = ['walker', 'runner', 'tank'];

let factoryPromise: Promise<ZombieFactory> | null = null;
/** One factory for the whole file: loading a skinned character is the expensive part. */
function factory(): Promise<ZombieFactory> {
  factoryPromise ??= (async () => {
    const instance = new ZombieFactory({ assets: { loadModel } as never });
    const result = await instance.load(KINDS);
    expect(result.failed).toEqual([]);
    expect(result.loaded.sort()).toEqual([...KINDS].sort());
    return instance;
  })();
  return factoryPromise;
}

interface Rig {
  zombie: Zombie;
  system: DamageSystem;
  /** Places the target `distance` down -Z and refreshes its world matrices. */
  place(distance: number): void;
  /** Fraction of `shots` that resolved onto the zombie, aiming at `targetY` metres up. */
  hitRate(weapon: WeaponId, distance: number, targetY: number, shots?: number, ads?: boolean): number;
  headRate(weapon: WeaponId, distance: number, targetY: number, shots?: number): number;
}

/**
 * A real zombie, its real hitboxes and the real shot resolver, over an empty world.
 *
 * The zombie is kept alive by construction: only the raycast is under test here, and a target
 * that dies after four pistol rounds would turn a hit rate into a measurement of its health.
 */
function rig(zombie: Zombie): Rig {
  const system = new DamageSystem({
    director: {
      list: [zombie],
      hitboxTargets: () => zombie.hitboxes,
    } as unknown as ZombieDirector,
    // Nothing solid in the way: this file measures the hitboxes, not the level.
    collision: { raycast: () => null } as unknown as CollisionWorld,
    events: new EventBus<GameEvents>(),
    random: new SeededRandom(20240417),
  });
  (zombie as unknown as { applyDamage: (amount: number) => { applied: number; died: boolean } })
    .applyDamage = (amount: number) => ({ applied: amount, died: false });

  const origin = new Vector3(0, EYE, 0);
  const aim = new Vector3();
  let at = 10;

  const fire = (weapon: WeaponId, targetY: number, shots: number, ads: boolean) => {
    const config = WEAPONS[weapon];
    const spread = config.spread * (ads ? ADS.spreadMultiplier : 1);
    // Aim from the eye at a point `targetY` up on the target's own line of advance.
    aim.set(0, targetY - EYE, -at).normalize();
    let hits = 0;
    let heads = 0;
    for (let shot = 0; shot < shots; shot += 1) {
      const report = system.fire({
        origin,
        direction: aim,
        damage: config.damage,
        range: config.range,
        spread,
        headshotMultiplier: config.headshotMultiplier,
        pellets: config.pellets,
      });
      if (report.target === 'zombie') {
        hits += 1;
        if (report.zone === 'head') heads += 1;
      }
    }
    return { hits, heads };
  };

  return {
    zombie,
    system,
    place(distance: number) {
      at = distance;
      zombie.root.position.set(0, 0, -distance);
      zombie.root.rotation.y = 0;
      zombie.root.updateMatrixWorld(true);
    },
    hitRate(weapon, distance, targetY, shots = 200, ads = false) {
      this.place(distance);
      return fire(weapon, targetY, shots, ads).hits / shots;
    },
    headRate(weapon, distance, targetY, shots = 200) {
      this.place(distance);
      return fire(weapon, targetY, shots, false).heads / shots;
    },
  };
}

async function rigFor(kind: ZombieKind): Promise<Rig> {
  const instance = await factory();
  const zombie = instance.create(kind);
  expect(zombie, `${kind} could not be created`).not.toBeNull();
  if (!zombie) throw new Error('unreachable');
  zombie.reset(0, 0, 0);
  zombie.root.updateMatrixWorld(true);
  return rig(zombie);
}

/** World-space vertical extent of one hitbox. */
function boxOf(root: Object3D, name: string): Box3 {
  const mesh = root.getObjectByName(name);
  expect(mesh, `${name} is missing`).toBeTruthy();
  return new Box3().setFromObject(mesh as Object3D);
}

describe('a shot cannot fall through a zombie', () => {
  it('has no vertical hole in the silhouette, at close and at medium range', async () => {
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      const height = ZOMBIE_TYPES[kind].height;
      // Every height of the body, from the ankles to just under the crown. Zero spread, so
      // this is the geometry and nothing else: a miss here is a hole in the boxes.
      for (const distance of [3, 10]) {
        for (let y = 0.3; y <= height - 0.15 + 1e-9; y += 0.05) {
          const rate = r.hitRate('pistol', distance, y, 1);
          expect(rate, `${kind} at ${distance} m has a hole at ${y.toFixed(2)} m`).toBe(1);
        }
      }
    }
  });

  it('touches the torso to the head, and leaves the head sphere its own volume', async () => {
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      const body = boxOf(r.zombie.root, 'hitbox-body');
      const head = boxOf(r.zombie.root, 'hitbox-head');
      const height = ZOMBIE_TYPES[kind].height;

      // No seam: the torso reaches the underside of the head sphere.
      expect(body.max.y, `${kind} torso stops below its head`).toBeGreaterThanOrEqual(head.min.y - 1e-6);
      // The head is still where the head is: its centre sits above the crown of the torso, so
      // the top half of the sphere — where a headshot is aimed — is unreachable by the torso.
      expect(head.getCenter(new Vector3()).y).toBeGreaterThan(body.max.y - 1e-6);
      expect(head.max.y).toBeLessThanOrEqual(height + 1e-6);
      // And the torso no longer stops at 0.74 of the height.
      expect(body.max.y).toBeGreaterThan(height * 0.74 + 0.05);
    }
  });

  it('is hit by a level shot from the player`s own eye line, at the range the fight happens', async () => {
    // The owner's case: a zombie on the same ground as the player, crosshair level. Before the
    // fix a Brute was 0% at 3 m and 5 m — every shot passed through the band at its neck.
    //
    // 0.95 rather than 1.0 for the one case that cannot reach it: the Runner is 1.68 m tall, so
    // a perfectly level hold is a graze across the top of its crown, six centimetres below the
    // eye line. Everything below that hits, which the sweep above proves — this is the aim
    // being above the model, not a hole in it. The Walker (1.8 m) and the Brute (2.12 m) are
    // hit on the head at every shot.
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      for (const weapon of ['pistol', 'smg', 'shotgun'] as WeaponId[]) {
        for (const distance of [3, 5]) {
          const rate = r.hitRate(weapon, distance, EYE);
          expect(rate, `${kind} ${weapon} level at ${distance} m`).toBeGreaterThanOrEqual(0.95);
        }
      }
    }
  });

  it('is hit when the crosshair is on its body, at every range the weapon reaches', async () => {
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      const chest = ZOMBIE_TYPES[kind].height * 0.52;
      for (const distance of [3, 5, 10, 20, 30]) {
        const rate = r.hitRate('rifle', distance, chest);
        expect(rate, `${kind} rifle at the chest, ${distance} m`).toBeGreaterThanOrEqual(0.9);
      }
    }
  });
});

describe('the sights tighten the long shot and cannot change the close one', () => {
  it('improves the long shot measurably, on the geometry it should not have to fix', async () => {
    // A head-sized target at 30 m: the hip cone is wider than it, the sights are not. Both
    // numbers are the same geometry, so the only difference is the cone.
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      const headY = ZOMBIE_TYPES[kind].height * 0.92;
      const hip = r.hitRate('rifle', 30, headY, 600);
      const ads = r.hitRate('rifle', 30, headY, 600, true);
      expect(ads, `${kind}: the sights did not improve the 30 m shot`).toBeGreaterThan(hip + 0.15);
    }
  });

  it('changes nothing at close range, where the cone is already inside the target', async () => {
    // This is the measured answer to "holding right click does not help me aim": inside 10 m
    // both cones land on the zombie, so there is nothing for the sights to improve. The fix
    // for the felt problem is the hitboxes, not a tighter cone.
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      const chest = ZOMBIE_TYPES[kind].height * 0.52;
      for (const distance of [3, 5, 10]) {
        const hip = r.hitRate('rifle', distance, chest, 300);
        const ads = r.hitRate('rifle', distance, chest, 300, true);
        expect(hip, `${kind} hip at ${distance} m`).toBe(1);
        expect(ads, `${kind} sights at ${distance} m`).toBe(1);
      }
    }
  });

  it('does not turn a headshot into an automatic one', async () => {
    // Aimed at the chest, the sights still never produce a head hit: the wider torso did not
    // grow into the head's zone.
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      const chest = ZOMBIE_TYPES[kind].height * 0.52;
      for (const weapon of ['pistol', 'rifle'] as WeaponId[]) {
        expect(r.headRate(weapon, 10, chest), `${kind} ${weapon} chest shots became headshots`)
          .toBe(0);
      }
    }
  });
});

describe('range still ends the shot', () => {
  it('never hits a zombie past the weapon`s range, and hits the same one inside it', async () => {
    for (const kind of KINDS) {
      const r = await rigFor(kind);
      const chest = ZOMBIE_TYPES[kind].height * 0.52;
      const near = WEAPONS.pistol.range + 10; // 100 m: past the pistol, inside the rifle
      // The same target, at the same distance, reached by one weapon and not the other — so
      // the zero is the ray's far plane, not a hitbox that has been left behind.
      expect(r.hitRate('pistol', near, chest, 200), `${kind} pistol at ${near} m`).toBe(0);
      expect(r.hitRate('rifle', near, chest, 200), `${kind} rifle at ${near} m`)
        .toBeGreaterThan(0.1);
      // And past the long gun's own range, nothing at all.
      expect(r.hitRate('rifle', WEAPONS.rifle.range + 20, chest, 200), `${kind} rifle beyond range`)
        .toBe(0);
    }
  });
});
