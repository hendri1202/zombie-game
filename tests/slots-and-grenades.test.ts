import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, PerspectiveCamera, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  DEFAULT_GRENADE, GRENADES, MELEE, WEAPONS, ZOMBIE_TYPES, type MeleeId, type WeaponId,
} from '../src/app/gameConfig';
import { hudWeaponReadout } from '../src/ui/HUD';
import {
  GrenadeSystem, grenadeDamageAt, selectGrenadeTargets, type GrenadeCandidate,
} from '../src/combat/GrenadeSystem';
import { PROCEDURAL_ORDNANCE, proceduralWeaponPath } from '../src/player/proceduralWeapons';
import { WeaponController } from '../src/player/WeaponController';
import { EventBus } from '../src/core/EventBus';
import { CollisionWorld } from '../src/level/CollisionWorld';
import {
  applyPoints, defaultProfile, ownsItem, purchaseItem, PROFILE_VERSION,
} from '../src/economy/ProfileStore';
import { findStoreItem } from '../src/economy/storeItems';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import type { PlayerController } from '../src/player/PlayerController';
import type { Zombie } from '../src/zombies/Zombie';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';
import type { ZombieKind } from '../src/app/gameConfig';

/**
 * The four slot categories from §14.1, and the grenade that fills the fourth.
 *
 * The category table is pinned as exact sets, not as a spot check: a weapon filed in the wrong
 * category is invisible at runtime — the key still works, it just reaches the wrong weapon —
 * and only this kind of assertion catches it. The grenade logic is exercised through the pure
 * blast functions and a scene-free system, so the flight, the fuse and the falloff are all
 * ordinary assertions rather than something a browser has to be driven to show.
 */

/** §14.1's own table, written out independently of the config so a config edit cannot pass. */
const EXPECTED_SLOTS: Record<number, readonly string[]> = {
  1: ['rifle', 'shotgun', 'smg', 'mp5', 'p90', 'lmg', 'mp7', 'aug', 'remington-870'],
  2: ['pistol'],
  3: ['knife', 'axe', 'barbed-bat', 'spear', 'katana', 'machete', 'crowbar', 'sledgehammer', 'fire-axe'],
  4: ['frag'],
};

describe('slot categories (§14.1)', () => {
  it('files every firearm under primary or sidearm, exactly as the table says', () => {
    const bySlot: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [] };
    for (const id of Object.keys(WEAPONS) as WeaponId[]) bySlot[WEAPONS[id].slot].push(id);
    expect(bySlot[1].sort()).toEqual([...EXPECTED_SLOTS[1]].sort());
    expect(bySlot[2].sort()).toEqual([...EXPECTED_SLOTS[2]].sort());
    // No firearm may carry a melee or ordnance slot number.
    expect(bySlot[3]).toEqual([]);
    expect(bySlot[4]).toEqual([]);
  });

  it('files every melee weapon under slot 3, no more and no less', () => {
    const ids = Object.keys(MELEE) as MeleeId[];
    for (const id of ids) expect(MELEE[id].slot, id).toBe(3);
    expect([...ids].sort()).toEqual([...EXPECTED_SLOTS[3]].sort());
  });

  it('files the grenade under slot 4', () => {
    expect(GRENADES.frag.slot).toBe(4);
    expect(Object.keys(GRENADES)).toEqual(EXPECTED_SLOTS[4]);
  });

  it('keeps one grenade as the default ordnance for slot 4', () => {
    expect(GRENADES[DEFAULT_GRENADE]).toBeTruthy();
    expect(GRENADES[DEFAULT_GRENADE].slot).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Rotation across all four categories
// ---------------------------------------------------------------------------

function grenadeHarness(options: { zombies?: FakeZombie[]; boxes?: CollisionWorld; scene?: Scene } = {}) {
  const events = new EventBus<GameEvents>();
  const collision = options.boxes ?? new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
  const director = {
    list: (options.zombies ?? []).map((zombie) => zombie.asZombie()),
    hitboxTargets: () => [],
  } as unknown as ZombieDirector;
  // A scene only when a test is about what a blast draws; the damage path is scene-free.
  const grenades = new GrenadeSystem({ scene: options.scene ?? null, director, collision, events });
  return { grenades, events, collision };
}

function controllerHarness(grenades: GrenadeSystem) {
  const events = new EventBus<GameEvents>();
  const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
  const player = { eyePosition: new Vector3(0, 1.62, 0) } as unknown as PlayerController;
  const weapons = new WeaponController({
    camera,
    events,
    damage: {} as unknown as DamageSystem,
    player,
    melee: {} as unknown as MeleeSystem,
    grenades,
  });
  return { weapons, events };
}

describe('the number keys cycle inside their own category', () => {
  it('rotates within each of the four categories', () => {
    const grenades = grenadeHarness().grenades;
    const { weapons } = controllerHarness(grenades);
    // Two primaries, so key 1 has something to rotate to.
    weapons.grantWeapon('rifle');
    weapons.grantWeapon('smg');
    // Two melee weapons, so key 3 has something to rotate to.
    weapons.grantMelee('axe');

    // 1 — primary: first press draws the first primary, the second advances to the next.
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('rifle');
    expect(weapons.switchSlot(1)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('smg');

    // 2 — sidearm: one weapon, so the press draws it and the next is a no-op.
    expect(weapons.switchSlot(2)).toBe(true);
    expect(weapons.snapshot.weaponId).toBe('pistol');
    expect(weapons.switchSlot(2)).toBe(false);
    expect(weapons.snapshot.weaponId).toBe('pistol');

    // 3 — melee: draws the carried knife, then rotates to the axe.
    expect(weapons.switchSlot(3)).toBe(true);
    expect(weapons.activeMelee.id).toBe('knife');
    expect(weapons.switchSlot(3)).toBe(true);
    expect(weapons.activeMelee.id).toBe('axe');

    // 4 — ordnance: selects the grenade, and there is only one to rotate to.
    expect(weapons.switchSlot(4)).toBe(true);
    expect(weapons.isOrdnanceSelected).toBe(true);
    expect(weapons.switchSlot(4)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The blast rule, pure
// ---------------------------------------------------------------------------

describe('grenadeDamageAt', () => {
  it('does full damage at the centre and nothing at or beyond the rim', () => {
    const { radius, maxDamage } = GRENADES[DEFAULT_GRENADE];
    expect(grenadeDamageAt(0, radius, maxDamage)).toBe(maxDamage);
    expect(grenadeDamageAt(radius, radius, maxDamage)).toBe(0);
    expect(grenadeDamageAt(radius + 0.01, radius, maxDamage)).toBe(0);
    expect(grenadeDamageAt(50, radius, maxDamage)).toBe(0);
  });

  it('falls off with distance and never rises', () => {
    const { radius, maxDamage } = GRENADES[DEFAULT_GRENADE];
    let previous = Number.POSITIVE_INFINITY;
    for (let distance = 0; distance <= radius; distance += 0.25) {
      const damage = grenadeDamageAt(distance, radius, maxDamage);
      expect(damage, `distance ${distance}`).toBeLessThanOrEqual(previous);
      expect(damage, `distance ${distance}`).toBeGreaterThanOrEqual(0);
      previous = damage;
    }
    // Halfway out is half the damage: the falloff is linear, not a step.
    expect(grenadeDamageAt(radius / 2, radius, maxDamage)).toBeCloseTo(maxDamage / 2, 6);
    // And nearer always hurts more than farther.
    expect(grenadeDamageAt(1, radius, maxDamage)).toBeGreaterThan(grenadeDamageAt(4, radius, maxDamage));
  });

  it('returns zero for a nonsense blast rather than a negative or NaN damage', () => {
    expect(grenadeDamageAt(1, 0, 100)).toBe(0);
    expect(grenadeDamageAt(1, 6, 0)).toBe(0);
    expect(grenadeDamageAt(Number.NaN, 6, 100)).toBe(0);
    expect(grenadeDamageAt(1, Number.NaN, 100)).toBe(0);
  });
});

describe('selectGrenadeTargets', () => {
  const candidate = (id: number, x: number, z: number, radius = 0.42, alive = true): GrenadeCandidate =>
    ({ id, x, z, radius, alive });

  it('takes everything whose surface is inside the radius, nearest first', () => {
    const hits = selectGrenadeTargets({ x: 0, z: 0 }, [
      candidate(1, 4, 0),
      candidate(2, 1, 0),
      candidate(3, 20, 0),
      candidate(4, 0, 0, 0.42, false),
    ], 6);
    expect(hits.map((hit) => hit.target.id)).toEqual([2, 1]);
    expect(hits[0].distance).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// The grenade through the system
// ---------------------------------------------------------------------------

/** A zombie with only the surface the grenade system touches. */
class FakeZombie {
  readonly id: number;
  readonly kind: ZombieKind = 'walker';
  readonly position: Vector3;
  readonly stats = { radius: 0.42, height: 1.8 };
  isAlive = true;
  health = 100;
  taken = 0;

  constructor(id: number, x: number, z: number) {
    this.id = id;
    this.position = new Vector3(x, 0, z);
  }

  applyDamage(damage: number): { applied: number; died: boolean } {
    const applied = Math.min(damage, this.health);
    this.health -= applied;
    this.taken += applied;
    const died = this.health <= 0;
    if (died) this.isAlive = false;
    return { applied, died };
  }

  asZombie(): Zombie {
    return this as unknown as Zombie;
  }
}

describe('the grenade pouch is a limited resource', () => {
  it('starts with the configured count and spends one per throw', () => {
    const { grenades } = grenadeHarness();
    const { weapons } = controllerHarness(grenades);
    const start = GRENADES[DEFAULT_GRENADE].startingCount;
    expect(start).toBeGreaterThan(0);
    expect(grenades.available).toBe(start);

    // The trigger only throws while the grenade is the item in hand.
    expect(weapons.tryThrowGrenade()).toBe(false);
    expect(grenades.available).toBe(start);

    expect(weapons.switchSlot(4)).toBe(true);
    expect(weapons.tryThrowGrenade()).toBe(true);
    expect(grenades.available).toBe(start - 1);
    expect(grenades.liveCount).toBe(1);
    expect(weapons.tryThrowGrenade()).toBe(true);
    expect(grenades.available).toBe(start - 2);
    expect(grenades.liveCount).toBe(2);
  });

  it('cannot throw when the pouch is empty, and does not fire the gun underneath', () => {
    const { grenades, events } = grenadeHarness();
    const { weapons } = controllerHarness(grenades);
    weapons.switchSlot(4);
    grenades.setCount(0);

    expect(weapons.tryThrowGrenade()).toBe(false);
    expect(grenades.available).toBe(0);

    // A trigger pull with an empty pouch while the grenade is selected: nothing is thrown and
    // the sidearm is not fired either — the player cannot aim a gun they are not holding.
    const fired = new Set<WeaponId>();
    events.on('weapon:fired', ({ weaponId }) => fired.add(weaponId));
    const magazine = weapons.snapshot.magazine;
    weapons.update(1 / 60, {
      forward: 0, right: 0, sprint: false, lookX: 0, lookY: 0, firing: true,
      firePressed: true, jumpPressed: false, reloadPressed: false, meleePressed: false,
      weaponSlotRequested: null,
    }, true);
    expect(fired.size).toBe(0);
    expect(weapons.snapshot.magazine).toBe(magazine);
  });

  it('adds grenades from a purchase or a pickup, and a run reset refills the pouch', () => {
    const { grenades } = grenadeHarness();
    grenades.setCount(1);
    expect(grenades.add(GRENADES[DEFAULT_GRENADE].storeQuantity)).toBe(1 + GRENADES[DEFAULT_GRENADE].storeQuantity);
    grenades.reset();
    expect(grenades.available).toBe(GRENADES[DEFAULT_GRENADE].startingCount);
  });
});

describe('the blast', () => {
  it('damages by distance and leaves anything outside the radius untouched', () => {
    const near = new FakeZombie(1, 1, 0);
    const far = new FakeZombie(2, 4, 0);
    const outside = new FakeZombie(3, 9, 0);
    // Sturdy targets on purpose: a walker dies to the near blast, and a dead target stops at
    // its own health, which would hide the falloff this test exists to measure.
    for (const target of [near, far, outside]) target.health = 1000;
    const { grenades } = grenadeHarness({ zombies: [near, far, outside] });

    const report = grenades.explode(new Vector3(0, 0.2, 0));
    const { radius, maxDamage } = GRENADES[DEFAULT_GRENADE];
    expect(near.taken).toBeCloseTo(grenadeDamageAt(1, radius, maxDamage), 6);
    expect(far.taken).toBeCloseTo(grenadeDamageAt(4, radius, maxDamage), 6);
    expect(near.taken).toBeGreaterThan(far.taken);
    expect(far.taken).toBeGreaterThan(0);
    expect(outside.taken).toBe(0);
    expect(report.damage).toBeCloseTo(near.taken + far.taken, 6);
    expect(report.damaged).toBe(2);
  });

  it('does not reach through a wall', () => {
    const collision = new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
    // A full-height wall between the blast and the target behind it: x[-5,5], z[3,4].
    collision.addCenteredBox(0, 3.5, 10, 1, 0, 'wall', { blocksPlayer: true, blocksZombies: true });
    const behind = new FakeZombie(1, 0, 5);
    const inFront = new FakeZombie(2, 0, -4);
    const { grenades } = grenadeHarness({ zombies: [behind, inFront], boxes: collision });

    grenades.explode(new Vector3(0, 0.2, 0));
    expect(behind.taken).toBe(0);
    expect(inFront.taken).toBeGreaterThan(0);
  });

  /**
   * The blast area the owner asked to grow, measured rather than asserted.
   *
   * `OLD_RADIUS` is pinned to the literal 6 the grenade used before the change, on purpose: the
   * whole point of these tests is the distance between the old and the new number, so putting the
   * radius back removes what they are about and they must fail rather than quietly follow the
   * config down. (Verified by reverting the radius: see the report.)
   */
  const OLD_RADIUS = 6;

  it('reaches a zombie the old smaller blast could not, and stops at the new rim', () => {
    const { radius, maxDamage } = GRENADES[DEFAULT_GRENADE];
    expect(radius, 'the blast area never grew').toBeGreaterThan(OLD_RADIUS);

    // Halfway between the two radii: 7 m to the centre, 6.58 m to a walker's surface — clear of
    // the old blast, inside the new one. Health pinned high so a death cannot mask the falloff.
    const between = new FakeZombie(1, (OLD_RADIUS + radius) / 2, 0);
    const beyond = new FakeZombie(2, radius + 1, 0);
    for (const target of [between, beyond]) target.health = 1000;
    const { grenades } = grenadeHarness({ zombies: [between, beyond] });

    const report = grenades.explode(new Vector3(0, 0.2, 0));
    // The rule as it was: at this distance, nothing at all.
    expect(grenadeDamageAt((OLD_RADIUS + radius) / 2, OLD_RADIUS, maxDamage)).toBe(0);
    // The rule now: caught, and for the falloff the new radius gives at that distance.
    expect(between.taken).toBeCloseTo(grenadeDamageAt((OLD_RADIUS + radius) / 2, radius, maxDamage), 6);
    expect(between.taken).toBeGreaterThan(0);
    // And the new edge is still an edge: a metre past it, untouched.
    expect(beyond.taken).toBe(0);
    expect(report.damaged).toBe(1);
    expect(report.radius).toBe(radius);
  });

  it('uses the configured radius as its rim, and the number is argued against the game', () => {
    const { radius } = GRENADES[DEFAULT_GRENADE];
    const inside = new FakeZombie(1, radius - 0.6, 0);
    const outside = new FakeZombie(2, radius + 1, 0);
    for (const target of [inside, outside]) target.health = 1000;
    const { grenades } = grenadeHarness({ zombies: [inside, outside] });

    grenades.explode(new Vector3(0, 0.2, 0));
    expect(inside.taken).toBeGreaterThan(0);
    expect(outside.taken).toBe(0);

    // Why 8 and not some other number. It out-reaches the whole ring of bodies that can touch the
    // player — the longest zombie attackRange is the brute's 2.15 m — so the blast is a surround
    // breaker; and it stays under a quarter of the shortest firearm's range (the pump shotgun's
    // 40 m), so it is still a thrown close-range crowd weapon and not a ranged replacement.
    const longestZombieReach = Math.max(...Object.values(ZOMBIE_TYPES).map((entry) => entry.attackRange));
    const shortestGunRange = Math.min(...Object.values(WEAPONS).map((weapon) => weapon.range));
    expect(radius).toBeGreaterThan(longestZombieReach * 3);
    expect(radius).toBeLessThan(shortestGunRange / 4);
  });

  it('a bigger blast still cannot reach through a wall', () => {
    const collision = new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
    // The same full-height wall between the blast and the targets behind it: x[-5,5], z[3,4].
    collision.addCenteredBox(0, 3.5, 10, 1, 0, 'wall', { blocksPlayer: true, blocksZombies: true });
    // 5 m behind the wall was already inside the old 6 m radius; 7 m is only inside the new one.
    // Both must be shielded, and a target the same 7 m away in the open must not be.
    const behindOldRim = new FakeZombie(1, 0, 5);
    const behindNewRing = new FakeZombie(2, 0, 7);
    const openAtNewRing = new FakeZombie(3, 0, -7);
    for (const target of [behindOldRim, behindNewRing, openAtNewRing]) target.health = 1000;
    const { grenades } = grenadeHarness({
      zombies: [behindOldRim, behindNewRing, openAtNewRing], boxes: collision,
    });

    grenades.explode(new Vector3(0, 0.2, 0));
    expect(behindOldRim.taken).toBe(0);
    expect(behindNewRing.taken).toBe(0);
    expect(openAtNewRing.taken).toBeGreaterThan(0);
  });

  it('kills only inside a disc under half the radius, so one throw cannot clear a wave', () => {
    const { radius, maxDamage } = GRENADES[DEFAULT_GRENADE];
    const walkerHealth = ZOMBIE_TYPES.walker.maxHealth;
    // Where the linear falloff still equals a whole walker: radius * (1 - health / centre damage).
    const lethal = radius * (1 - walkerHealth / maxDamage);
    expect(lethal).toBeLessThan(radius / 2);

    const atLethal = new FakeZombie(1, lethal - 0.05, 0);
    const pastLethal = new FakeZombie(2, lethal + 0.5, 0);
    const { grenades } = grenadeHarness({ zombies: [atLethal, pastLethal] });
    grenades.explode(new Vector3(0, 0.2, 0));

    expect(atLethal.isAlive).toBe(false);
    // Past the lethal disc the blast still lands — it staggers rather than ignores — but the
    // walker survives, which is what stops one grenade from deleting a whole wave.
    expect(pastLethal.isAlive).toBe(true);
    expect(pastLethal.taken).toBeGreaterThan(0);
  });

  it('draws the blast at the radius, so the effect states the area the damage used', () => {
    const scene = new Scene();
    const { radius } = GRENADES[DEFAULT_GRENADE];
    const { grenades } = grenadeHarness({ scene });

    grenades.explode(new Vector3(2, 0.2, -3));
    const blast = scene.getObjectByName('GrenadeBlast');
    expect(blast, 'the explosion drew nothing').toBeTruthy();
    expect(grenades.blastCount).toBe(1);
    // At the blast point, and on the ground: the ring is a footprint, not a floating decal.
    expect(blast?.position.x).toBeCloseTo(2, 6);
    expect(blast?.position.z).toBeCloseTo(-3, 6);
    expect(blast?.position.y).toBeCloseTo(0.2, 6);

    // The effect is three pieces, not one: the pop, the fireball, and the ring that carries the
    // edge. The ring is the one that states the size, and it starts inset.
    const ring = blast?.getObjectByName('GrenadeBlastRing') as Mesh;
    const fireball = blast?.getObjectByName('GrenadeBlastFireball') as Mesh;
    const core = blast?.getObjectByName('GrenadeBlastCore') as Mesh;
    expect(core, 'no hot core').toBeTruthy();
    expect(ring.scale.x).toBeLessThan(radius);
    expect(fireball.scale.x).toBeLessThan(radius);

    // Walk the whole life of the blast and take the peaks: it must grow out to the edge the damage
    // used, and never past it. A small fixed puff — what this effect was before — fails both, and
    // so does a ring that stops short of the radius.
    let ringPeak = 0;
    let fireballPeak = 0;
    let corePeak = 0;
    let steps = 0;
    while (grenades.blastCount > 0 && steps < 600) {
      grenades.update(1 / 60);
      steps += 1;
      if (grenades.blastCount === 0) break;
      ringPeak = Math.max(ringPeak, ring.scale.x);
      fireballPeak = Math.max(fireballPeak, fireball.scale.x);
      corePeak = Math.max(corePeak, core.scale.x);
    }
    expect(ringPeak).toBeGreaterThan(radius * 0.95);
    expect(ringPeak).toBeLessThanOrEqual(radius + 1e-9);
    expect(ringPeak).toBeGreaterThan(OLD_RADIUS);
    // The fireball stays inside the ring's edge, so the edge the player reads is the damage edge.
    expect(fireballPeak).toBeLessThan(radius);
    expect(fireballPeak).toBeLessThan(ringPeak);
    // And the core is the smallest piece of the three.
    expect(corePeak).toBeLessThan(fireballPeak);

    // Nothing piles up in the scene once it is over.
    expect(grenades.blastCount).toBe(0);
    expect(scene.getObjectByName('GrenadeBlast')).toBeFalsy();
    // And clearing a live blast takes it out of the scene, as a run restart needs.
    grenades.explode(new Vector3(0, 0.2, 0));
    expect(grenades.blastCount).toBe(1);
    grenades.clear();
    expect(grenades.blastCount).toBe(0);
    expect(scene.getObjectByName('GrenadeBlast')).toBeFalsy();
  });

  it('kills what it can and reports the count, through the same events a shot uses', () => {
    const walker = new FakeZombie(1, 1, 0);
    const { grenades, events } = grenadeHarness({ zombies: [walker] });
    const hits: number[] = [];
    let kills = 0;
    events.on('combat:hit', () => hits.push(1));
    events.on('zombie:killed', () => { kills += 1; });

    const report = grenades.explode(new Vector3(0, 0.2, 0));
    expect(walker.isAlive).toBe(false);
    expect(kills).toBe(1);
    expect(hits.length).toBe(1);
    expect(report.killed).toBe(1);
  });

  it('detonates a thrown grenade when the fuse runs out', () => {
    const target = new FakeZombie(1, 3, 0);
    const { grenades, events } = grenadeHarness({ zombies: [target] });
    let exploded = 0;
    events.on('grenade:exploded', () => { exploded += 1; });

    expect(grenades.throw(new Vector3(0, 1.4, 0), new Vector3(1, 0, 0))).toBe(true);
    expect(grenades.liveCount).toBe(1);

    // The fuse is 2.75 s: nothing detonates before it, and it does not leak after.
    for (let elapsed = 0; elapsed < GRENADES[DEFAULT_GRENADE].fuseSeconds - 0.1; elapsed += 1 / 60) {
      grenades.update(1 / 60);
    }
    expect(exploded).toBe(0);
    expect(grenades.liveCount).toBe(1);

    grenades.update(0.2);
    expect(exploded).toBe(1);
    expect(grenades.liveCount).toBe(0);
  });

  it('keeps a thrown grenade on the near side of a wall instead of passing through it', () => {
    const collision = new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
    // The same full-height wall: z[3,4], so passing it would mean a z beyond 4.
    collision.addCenteredBox(0, 3.5, 10, 1, 0, 'wall', { blocksPlayer: true, blocksZombies: true });
    const { grenades } = grenadeHarness({ boxes: collision });

    // Thrown straight down +Z at the wall, with the lift taking it up first. Over its whole
    // flight its leading edge must never end up on the far side of the wall.
    grenades.throw(new Vector3(0, 1.4, 0), new Vector3(0, 0, 1));
    let furthestZ = Number.NEGATIVE_INFINITY;
    const fuse = GRENADES[DEFAULT_GRENADE].fuseSeconds;
    for (let elapsed = 0; elapsed < fuse + 0.2; elapsed += 1 / 60) {
      grenades.update(1 / 60);
      for (const position of grenades.livePositions) furthestZ = Math.max(furthestZ, position.z);
    }
    // It reached the wall (so it really was thrown at it) and stopped short of its far face.
    expect(furthestZ).toBeGreaterThan(2.5);
    expect(furthestZ).toBeLessThan(4);
    // And the fuse ran out, leaving nothing behind.
    expect(grenades.report().live).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The HUD and the store
// ---------------------------------------------------------------------------

describe('the grenade count in the HUD', () => {
  it('shows the grenade by name and by pouch count while it is in hand', () => {
    const readout = hudWeaponReadout({
      weaponName: 'Sidearm', meleeName: 'Combat Knife', magazine: 12, reserve: 60, melee: false,
      ordnance: true, ordnanceName: GRENADES[DEFAULT_GRENADE].name, grenades: 2,
    });
    expect(readout.name).toBe('FRAG GRENADE');
    expect(readout.ammo).toBe('2');
    // A grenade has no magazine: the slash and the reserve cell stay hidden.
    expect(readout.reserve).toBe('');
    expect(readout.hideReserve).toBe(true);
  });

  it('leaves the firearm and melee readouts untouched', () => {
    const firearm = hudWeaponReadout({
      weaponName: 'Sidearm', meleeName: 'Combat Knife', magazine: 12, reserve: 60, melee: false,
    });
    expect(firearm.name).toBe('SIDEARM');
    expect(firearm.ammo).toBe('12');
    expect(firearm.hideReserve).toBe(false);
  });
});

describe('the store sells grenades', () => {
  it('sells a grenade row with a positive price and a quantity per purchase', () => {
    const frag = findStoreItem('frag');
    expect(frag, 'the store does not sell a grenade').not.toBeNull();
    if (!frag || frag.category !== 'ordnance') throw new Error('the grenade row is not ordnance');
    expect(frag.name).toBe(GRENADES.frag.name);
    expect(Number.isInteger(frag.price)).toBe(true);
    expect(frag.price).toBeGreaterThan(0);
    expect(frag.quantity).toBeGreaterThan(0);
  });

  it('charges the price and never marks a grenade as owned, so it can be bought again', () => {
    const frag = findStoreItem('frag');
    if (!frag) throw new Error('the store does not sell a grenade');
    const rich = applyPoints(defaultProfile(), frag.price * 2 + 10);

    const first = purchaseItem(rich, frag);
    expect(first.ok).toBe(true);
    expect(first.profile.points).toBe(rich.points - frag.price);
    // A consumable has no ownership: the shelf row must stay buyable.
    expect(ownsItem(first.profile, frag)).toBe(false);

    const second = purchaseItem(first.profile, frag);
    expect(second.ok).toBe(true);
    expect(second.profile.points).toBe(rich.points - frag.price * 2);

    // And it is refused, not overdrawn, when the balance cannot cover it.
    const poor = applyPoints(defaultProfile(), frag.price - 1);
    const refused = purchaseItem(poor, frag);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('poor');
    expect(refused.profile.points).toBe(frag.price - 1);
  });

  it('does not disturb the saved profile schema', () => {
    // The pouch lives per run (see GrenadeConfig.startingCount), so a purchase leaves the
    // persisted profile shape — and its version — exactly as it was.
    const frag = findStoreItem('frag');
    if (!frag) throw new Error('the store does not sell a grenade');
    const bought = purchaseItem(applyPoints(defaultProfile(), 500), frag);
    expect(bought.profile.version).toBe(PROFILE_VERSION);
    expect(bought.profile.ownedFirearms).toEqual(['pistol']);
    expect(bought.profile.ownedMelee).toEqual(['knife']);
  });
});

// ---------------------------------------------------------------------------
// The grenade's mesh
// ---------------------------------------------------------------------------

const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/**
 * `ProgressEvent` for Node.
 *
 * `GLTFLoader` reports progress with a browser-only `ProgressEvent`, and this suite runs in
 * Node. Same stub as `weapon-roster.test.ts`; the event is only read for its type.
 */
if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as unknown as { ProgressEvent: unknown }).ProgressEvent = class {
    readonly type: string;

    constructor(type: string, init: Record<string, unknown> = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
}

describe('the grenade model', () => {
  it('ships the glTF the config names, with the mesh inside it', () => {
    const modelPath = GRENADES[DEFAULT_GRENADE].modelPath;
    expect(modelPath).toMatch(/^\/assets\/weapons\/[A-Za-z0-9_-]+\.gltf$/);
    const name = modelPath.split('/').pop() ?? '';
    const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
    expect(key, `${modelPath} is missing`).toBeTruthy();
    if (!key) return;
    const gltf = JSON.parse(WEAPON_FILES[key]) as {
      asset?: { version?: string };
      meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
    };
    expect(gltf.asset?.version).toBe('2.0');
    expect(gltf.meshes?.length ?? 0).toBeGreaterThan(0);
    expect(gltf.meshes?.[0]?.primitives?.[0]?.attributes?.POSITION).toBeTypeOf('number');
  });

  it('is the file the code-built registry produces, so the two cannot drift', () => {
    const registry = new Map(PROCEDURAL_ORDNANCE.map((entry) => [entry.id, entry.file]));
    for (const entry of PROCEDURAL_ORDNANCE) {
      expect(GRENADES[entry.id].modelPath).toBe(proceduralWeaponPath(entry.file));
    }
    expect(registry.has(DEFAULT_GRENADE)).toBe(true);
  });

  it('builds a mesh with real geometry in it', () => {
    for (const entry of PROCEDURAL_ORDNANCE) {
      const group = entry.build();
      expect(group.name).toMatch(/^Weapon/);
      let meshes = 0;
      group.traverse((child) => {
        if ((child as Mesh).isMesh) meshes += 1;
      });
      expect(meshes, entry.id).toBeGreaterThan(1);
      const box = new Box3().setFromObject(group);
      const size = box.getSize(new Vector3());
      expect(box.isEmpty(), entry.id).toBe(false);
      // A grenade is small — about the length of a hand — but never flat or empty.
      expect(Math.max(size.x, size.y, size.z), entry.id).toBeGreaterThan(0.1);
    }
  });

  it('parses through the GLTFLoader the runtime loads view models with', async () => {
    // The end of the chain a browser check would otherwise be the only witness to: the file the
    // view model and the store preview both name actually loads, into a scene of meshes.
    const modelPath = GRENADES[DEFAULT_GRENADE].modelPath;
    const name = modelPath.split('/').pop() ?? '';
    const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
    expect(key, `${modelPath} is missing`).toBeTruthy();

    const loader = new GLTFLoader();
    const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
      loader.parse(WEAPON_FILES[key ?? ''] ?? '', '', resolve, reject);
    });
    let meshes = 0;
    gltf.scene.traverse((child) => {
      if ((child as Mesh).isMesh) meshes += 1;
    });
    expect(meshes).toBeGreaterThan(1);
  }, 30000);
});
