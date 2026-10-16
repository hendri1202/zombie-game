import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { DamageSystem, spreadDirection, type HitscanRequest } from '../src/combat/DamageSystem';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import { HITBOX_LAYER } from '../src/zombies/ZombieFactory';
import { SeededRandom } from '../src/utils/math';
import { WEAPONS } from '../src/app/gameConfig';
import type { Zombie } from '../src/zombies/Zombie';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';
import type { CollisionWorld } from '../src/level/CollisionWorld';

describe('spread geometry', () => {
  it('keeps every pellet inside the cone it was given', () => {
    const base = new Vector3(0, 0, -1);
    const random = new SeededRandom(11);
    for (let shot = 0; shot < 400; shot += 1) {
      const direction = base.clone();
      const magnitude = random.range(0, 0.08);
      spreadDirection(direction, random.range(0, Math.PI * 2), magnitude);
      direction.normalize();
      // A pellet outside its cone would be a hit the weapon should not be able to make.
      expect(direction.angleTo(base)).toBeLessThanOrEqual(magnitude + 1e-6);
    }
  });

  it('leaves the aim untouched with no spread', () => {
    const base = new Vector3(0.3, -0.2, -1).normalize();
    const direction = base.clone();
    spreadDirection(direction, 1.2, 0);
    expect(direction.angleTo(base)).toBeLessThan(1e-9);
  });

  it('still works when aiming straight up or down', () => {
    // The basis has to change or the cross product collapses to zero and every shot
    // lands on the axis.
    for (const y of [1, -1]) {
      const base = new Vector3(0, y, 0);
      const direction = base.clone();
      spreadDirection(direction, 0.5, 0.05);
      direction.normalize();
      expect(direction.angleTo(base)).toBeGreaterThan(1e-4);
      expect(Number.isNaN(direction.x)).toBe(false);
    }
  });
});

interface Harness {
  system: DamageSystem;
  bus: EventBus<GameEvents>;
  damageTaken: () => number;
  request: Partial<HitscanRequest>;
}

/**
 * A DamageSystem with one huge hitbox in front of the muzzle and no world geometry.
 *
 * The target sits clear of the origin on purpose: a ray that starts inside a box hits the
 * far face from behind, which front-side culling discards, so a target wrapped around the
 * muzzle is never hit at all.
 */
function harness(size = 20, distance = 25): Harness {
  const mesh = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  mesh.position.set(0, 0, -distance);
  mesh.layers.set(HITBOX_LAYER);
  mesh.userData.hitZone = 'body';
  mesh.updateMatrixWorld(true);

  let taken = 0;
  const zombie = {
    hitboxes: [mesh],
    kind: 'walker',
    isAlive: true,
    applyDamage(damage: number) {
      taken += damage;
      return { applied: damage, died: false };
    },
  } as unknown as Zombie;

  const director = {
    list: [zombie],
    hitboxTargets: () => [mesh],
  } as unknown as ZombieDirector;

  const collision = {
    raycast: () => null,
  } as unknown as CollisionWorld;

  const bus = new EventBus<GameEvents>();
  return {
    system: new DamageSystem({ director, collision, events: bus, random: new SeededRandom(5) }),
    bus,
    damageTaken: () => taken,
    request: {},
  };
}

describe('shotgun pellets', () => {
  it('fires one ray per pellet and reports the total', () => {
    const h = harness();
    let impacts = 0;
    h.bus.on('combat:hit', () => { impacts += 1; });

    const report = h.system.fire({
      origin: new Vector3(0, 0, 0),
      direction: new Vector3(0, 0, -1),
      damage: 12,
      range: 40,
      spread: 0.06,
      headshotMultiplier: 1.5,
      pellets: 8,
    });

    // Against a target this large every pellet connects, so eight impacts, eight damage
    // applications, and a report that adds them up.
    expect(impacts).toBe(8);
    expect(h.damageTaken()).toBe(report.damage);
    expect(report.damage).toBeGreaterThanOrEqual(8 * 12 * 0.9);
    expect(report.target).toBe('zombie');
  });

  it('spends the pellets on the world when nothing is in the way', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mesh.layers.set(HITBOX_LAYER);
    mesh.userData.hitZone = 'body';
    const zombie = { hitboxes: [], kind: 'walker', isAlive: false } as unknown as Zombie;
    const bus = new EventBus<GameEvents>();
    let worldHits = 0;
    bus.on('combat:world-hit', () => { worldHits += 1; });
    const system = new DamageSystem({
      director: { list: [zombie], hitboxTargets: () => [mesh] } as unknown as ZombieDirector,
      collision: {
        raycast: () => ({ distance: 3, tag: 'wall', pointX: 0, pointY: 0, pointZ: -3 }),
      } as unknown as CollisionWorld,
      events: bus,
      random: new SeededRandom(9),
    });

    const report = system.fire({
      origin: new Vector3(0, 0, 0),
      direction: new Vector3(0, 0, -1),
      damage: 12,
      range: 40,
      spread: 0.06,
      headshotMultiplier: 1.5,
      pellets: 8,
    });

    expect(worldHits).toBe(8);
    expect(report.target).toBe('world');
    expect(report.damage).toBe(0);
  });

  it('treats a missing pellet count as a single projectile', () => {
    const h = harness();
    let impacts = 0;
    h.bus.on('combat:hit', () => { impacts += 1; });
    const report = h.system.fire({
      origin: new Vector3(0, 0, 0),
      direction: new Vector3(0, 0, -1),
      damage: 34,
      range: 120,
      spread: 0,
      headshotMultiplier: 2,
    });
    expect(impacts).toBe(1);
    expect(report.damage).toBe(34);
  });

  it('reads the pellet count from the weapon config', () => {
    expect(WEAPONS.shotgun.pellets).toBe(8);
    // Every other weapon fires a single projectile, and the field stays absent.
    for (const id of ['pistol', 'rifle', 'smg'] as const) {
      expect(WEAPONS[id].pellets, id).toBeUndefined();
    }
    // One shell is one round of ammunition however many pellets leave the barrel.
    expect(WEAPONS.shotgun.magazineSize).toBe(6);
  });
});
