import { describe, expect, it } from 'vitest';
import { AnimationClip, PerspectiveCamera, Vector3 } from 'three';
import {
  MeleeSystem, meleeBearing, meleeSwingCurve, selectMeleeTarget, selectMeleeTargets,
  type MeleeCandidate,
} from '../src/combat/MeleeSystem';
import { DamageSystem } from '../src/combat/DamageSystem';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import type { InputSnapshot } from '../src/input/InputManager';
import { CollisionWorld, type RaycastHit } from '../src/level/CollisionWorld';
import { PlayerController } from '../src/player/PlayerController';
import { WeaponController } from '../src/player/WeaponController';
import { SeededRandom } from '../src/utils/math';
import type { Zombie } from '../src/zombies/Zombie';
import type { ZombieDirector } from '../src/zombies/ZombieDirector';
import { DEFAULT_MELEE, MELEE, type MeleeId } from '../src/app/meleeConfig';
import {
  DEFAULT_MELEE as DEFAULT_FROM_CONFIG, MELEE as MELEE_FROM_CONFIG, WEAPONS, type ZombieKind,
} from '../src/app/gameConfig';
import { resolveByCandidates } from '../src/utils/clipResolve';

/** The survivor models, read raw so the melee clips can be checked against the real files. */
const SURVIVOR_FILES = import.meta.glob('/public/assets/characters/survivors/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/**
 * The swing cone.
 *
 * Forward is `(sin yaw, cos yaw)`, so at yaw 0 the player faces +Z. The geometry is the
 * whole content of the melee hit test, so it is pinned here rather than checked through a
 * scene: a swing that lands behind the player or through a wall is a bug a unit test can
 * catch in milliseconds.
 */
function candidate(id: number, x: number, z: number, radius = 0.42, alive = true): MeleeCandidate {
  return { id, x, z, radius, alive };
}

describe('melee swing cone', () => {
  it('reads the facing convention the rest of the game uses', () => {
    expect(meleeBearing({ x: 0, z: 0 }, 0, { x: 0, z: 5 }).angle).toBeCloseTo(0, 6);
    expect(meleeBearing({ x: 0, z: 0 }, 0, { x: 0, z: 5 }).distance).toBeCloseTo(5, 6);
    // Beside the player is a quarter turn away, and behind is a half turn.
    expect(meleeBearing({ x: 0, z: 0 }, 0, { x: 5, z: 0 }).angle).toBeCloseTo(Math.PI / 2, 6);
    expect(meleeBearing({ x: 0, z: 0 }, 0, { x: 0, z: -5 }).angle).toBeCloseTo(Math.PI, 6);
    // Facing -Z (yaw = pi) flips which side is in front.
    expect(meleeBearing({ x: 0, z: 0 }, Math.PI, { x: 0, z: -5 }).angle).toBeCloseTo(0, 6);
  });

  it('hits what is in front of the player', () => {
    const hit = selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, 0, 1.5)], Math.PI / 2, 2);
    expect(hit?.id).toBe(1);
  });

  it('misses what is behind the player', () => {
    const hit = selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, 0, -1.5)], Math.PI / 2, 3);
    expect(hit).toBeNull();
  });

  it('keeps the cone symmetric and stops at the arc edge', () => {
    const arc = Math.PI / 2;
    // 30 degrees off the axis at 2 m: inside a 45 degree half-arc.
    const inside = { x: 2 * Math.sin(Math.PI / 6), z: 2 * Math.cos(Math.PI / 6) };
    // 60 degrees: outside it, and just as far away, so only the angle decides.
    const outside = { x: 2 * Math.sin(Math.PI / 3), z: 2 * Math.cos(Math.PI / 3) };
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, inside.x, inside.z)], arc, 3)?.id).toBe(1);
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, outside.x, outside.z)], arc, 3)).toBeNull();
    // Mirror image on the other side: a swing is symmetric, not handed.
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, -inside.x, inside.z)], arc, 3)?.id).toBe(1);
  });

  it('reaches the target surface, not its centre', () => {
    // 2.3 m away with a 0.42 m radius is 1.88 m of clear air, so a 2 m reach lands even
    // though the centre is beyond it.
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, 0, 2.3)], 1, 2)?.id).toBe(1);
    // 2.6 m away is 2.18 m of clear air: out of reach even with the radius counted.
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, 0, 2.6)], 1, 2)).toBeNull();
  });

  it('picks the nearest target in the arc', () => {
    const targets = [candidate(1, 0, 2.2), candidate(2, 0.3, 1.1), candidate(3, -0.4, 1.7)];
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, targets, 1.2, 3)?.id).toBe(2);
    // The full list comes back nearest-first, which is what lets a blocked target be
    // skipped for the next one in the arc.
    expect(selectMeleeTargets({ x: 0, z: 0 }, 0, targets, 1.2, 3).map((hit) => hit.target.id))
      .toEqual([2, 3, 1]);
  });

  it('ignores the dead', () => {
    const targets = [candidate(1, 0, 1, 0.42, false), candidate(2, 0, 1.6)];
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, targets, 1, 3)?.id).toBe(2);
    expect(selectMeleeTarget({ x: 0, z: 0 }, 0, [candidate(1, 0, 1, 0.42, false)], 1, 3)).toBeNull();
  });

  it('shapes a swing so it starts and ends at rest', () => {
    expect(meleeSwingCurve(0)).toBeCloseTo(0, 6);
    expect(meleeSwingCurve(0.5)).toBeCloseTo(1, 6);
    expect(meleeSwingCurve(1)).toBeCloseTo(0, 6);
    // Out-of-range progress is clamped rather than wrapped: an overshooting timer must not
    // send the weapon off through a full extra swing.
    expect(meleeSwingCurve(-1)).toBeCloseTo(0, 6);
    expect(meleeSwingCurve(2)).toBeCloseTo(0, 6);
    expect(meleeSwingCurve(0.25)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(meleeSwingCurve(0.75)).toBeGreaterThan(0);
  });
});

/** A zombie with just the surface MeleeSystem touches, so a swing needs no scene. */
class FakeZombie {
  readonly id: number;
  readonly kind: ZombieKind;
  readonly position: Vector3;
  readonly stats: { radius: number; height: number };
  isAlive = true;
  health: number;
  /** Total damage this zombie has taken, which is what the swing assertions read. */
  taken = 0;

  constructor(id: number, x: number, z: number, options: { kind?: ZombieKind; health?: number; radius?: number; height?: number } = {}) {
    this.id = id;
    this.kind = options.kind ?? 'walker';
    this.position = new Vector3(x, 0, z);
    this.stats = { radius: options.radius ?? 0.42, height: options.height ?? 1.8 };
    this.health = options.health ?? 100;
  }

  applyDamage(damage: number): { applied: number; died: boolean } {
    this.taken += damage;
    this.health -= damage;
    const died = this.health <= 0;
    if (died) this.isAlive = false;
    return { applied: damage, died };
  }

  asZombie(): Zombie {
    return this as unknown as Zombie;
  }
}

/**
 * A wall straight through the world at z = 1.
 *
 * A plain "always blocked" fake could not tell a swing that skips a blocked target from
 * one that hits through the wall, because the far target would be blocked too. A plane
 * blocks only the rays that actually cross it.
 */
function wallAtZ(distance: number): (origin: Vector3, direction: Vector3, max: number) => RaycastHit | null {
  return (origin, direction, max) => {
    if (direction.z <= 1e-6) return null;
    const travel = (distance - origin.z) / direction.z;
    if (travel <= 0 || travel > max) return null;
    return {
      distance: travel,
      pointX: origin.x + direction.x * travel,
      pointY: origin.y,
      pointZ: distance,
      tag: 'test-wall',
    };
  };
}

/**
 * A wall covering only the player's right.
 *
 * Used to prove the swing walks its target list: the nearest zombie can be behind
 * something while the next one in the same arc is not, which a full-width wall could
 * never show.
 */
function wallRightOf(minDirectionX: number): (origin: Vector3, direction: Vector3, max: number) => RaycastHit | null {
  return (origin, direction) => (direction.x > minDirectionX
    ? { distance: 0.3, pointX: origin.x + direction.x * 0.3, pointY: origin.y, pointZ: origin.z, tag: 'test-wall' }
    : null);
}

function meleeHarness(options: {
  zombies?: FakeZombie[];
  raycast?: (origin: Vector3, direction: Vector3, max: number) => RaycastHit | null;
} = {}) {
  const events = new EventBus<GameEvents>();
  const zombies = options.zombies ?? [];
  const hits: Array<{ zone: string; kind: ZombieKind }> = [];
  let kills = 0;
  events.on('combat:hit', ({ zone, kind }) => hits.push({ zone, kind }));
  events.on('zombie:killed', () => { kills += 1; });

  const director = {
    list: zombies.map((zombie) => zombie.asZombie()),
    hitboxTargets: () => [],
  } as unknown as ZombieDirector;
  const collision = {
    raycast: options.raycast ?? (() => null),
  } as unknown as CollisionWorld;
  const system = new MeleeSystem({ director, collision, events });
  return { system, events, hits, killCount: () => kills, zombies };
}

describe('melee swing resolution', () => {
  const request = {
    origin: new Vector3(0, 1.62, 0),
    forwardYaw: 0,
    damage: 34,
    arc: 1.2,
    reach: 2,
  };

  it('applies the weapon damage once and reports the hit on the gunfire event', () => {
    const h = meleeHarness({ zombies: [new FakeZombie(7, 0, 1.5)] });
    const report = h.system.swing(request);

    expect(h.zombies[0].taken).toBe(34);
    expect(report.target).toBe('zombie');
    expect(report.targetId).toBe(7);
    expect(report.damage).toBe(34);
    expect(report.killed).toBe(false);
    // The same payload a bullet emits, so the HUD hitmarker, the blood spurt and the hit
    // sound are the ones gunfire already uses.
    expect(h.hits).toEqual([{ zone: 'body', kind: 'walker' }]);
    // Chest height, not the ground: a spurting wound at the feet reads as a miss.
    expect(report.point.y).toBeCloseTo(1.8 * 0.55, 6);
  });

  it('never applies a headshot multiplier', () => {
    const h = meleeHarness({ zombies: [new FakeZombie(1, 0, 1.2), new FakeZombie(2, 0, 1.3)] });
    h.system.swing(request);
    // 34 in, 34 applied: a swing resolves against the body radius, so a multiplier would
    // be a number with no hitbox behind it.
    expect(h.zombies[0].taken).toBe(34);
  });

  it('reports a kill so the kill counter and the drop roll see it', () => {
    // Exactly on its last hit point, so the swing finishes it.
    const runner = new FakeZombie(3, 0, 1.5, { kind: 'runner', health: 34 });
    const h = meleeHarness({ zombies: [runner] });
    const report = h.system.swing(request);
    expect(report.killed).toBe(true);
    expect(runner.isAlive).toBe(false);
    expect(h.killCount()).toBe(1);
  });

  it('does not reach through a wall', () => {
    const h = meleeHarness({ zombies: [new FakeZombie(1, 0, 3)], raycast: wallAtZ(1) });
    const report = h.system.swing({ ...request, reach: 4 });
    expect(report.target).toBe('none');
    expect(report.damage).toBe(0);
    expect(h.zombies[0].taken).toBe(0);
    expect(h.hits).toEqual([]);
  });

  it('skips a blocked target for the next one in the arc', () => {
    // Only the player's right is walled, so the swing the right-hand target blocks still
    // lands on the one on the left.
    const blocked = new FakeZombie(1, 0.5, 1);
    const open = new FakeZombie(2, -0.8, 1.5);
    const h = meleeHarness({ zombies: [blocked, open], raycast: wallRightOf(0.3) });
    h.system.swing(request);
    expect(blocked.taken).toBe(0);
    expect(open.taken).toBe(34);
  });

  it('reports a swing at empty air without touching anyone', () => {
    const h = meleeHarness();
    const report = h.system.swing(request);
    expect(report.target).toBe('none');
    expect(report.targetId).toBeNull();
    expect(report.damage).toBe(0);
    expect(h.hits).toEqual([]);
    // Somewhere real for a whoosh: the end of the arc, in front of the player.
    expect(report.point.z).toBeCloseTo(2, 6);
  });
});

/** A full controller, player and melee system, with no renderer in sight. */
function controllerHarness(options: { zombieDistance?: number; zombieCount?: number } = {}) {
  const events = new EventBus<GameEvents>();
  const collision = new CollisionWorld({ minX: -40, maxX: 40, minZ: -40, maxZ: 40 });
  const camera = new PerspectiveCamera(76, 1.6, 0.08, 420);
  const player = new PlayerController({ camera, collision });
  // Spawn is (0, 14) facing -Z, so facingAngle is 0 and forward is +Z: zombies are placed
  // in front of the player along +Z.
  const distance = options.zombieDistance ?? 1.2;
  const zombies = Array.from({ length: options.zombieCount ?? 1 }, (_, index) =>
    new FakeZombie(index + 1, 0, player.position.z + distance));

  const director = {
    list: zombies.map((zombie) => zombie.asZombie()),
    hitboxTargets: () => [],
  } as unknown as ZombieDirector;
  const melee = new MeleeSystem({ director, collision, events });
  const damage = new DamageSystem({ director, collision, events, random: new SeededRandom(7) });
  const weapons = new WeaponController({ camera, events, damage, player, melee });

  /** Advances the controller the way one gameplay frame does. */
  const step = (seconds: number, input: InputSnapshot | null = null): void => {
    weapons.update(seconds, input, true);
  };
  const snapshot = (): InputSnapshot => ({
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
  });

  return { weapons, player, zombies, events, step, snapshot };
}

describe('melee through the weapon controller', () => {
  it('draws a melee weapon and swings it from the F key', () => {
    const h = controllerHarness();
    expect(h.weapons.meleeReport.equipped).toBeNull();

    // First press draws the weapon.
    h.step(1 / 60, { ...h.snapshot(), meleePressed: true });
    expect(h.weapons.meleeReport.equipped).toBe(DEFAULT_MELEE);
    expect(h.weapons.isMeleeDrawn).toBe(true);

    // Second press swings it.
    h.step(1 / 60, { ...h.snapshot(), meleePressed: true });
    expect(h.weapons.meleeReport.swinging).toBe(true);

    // And the blow lands partway through the swing, not on its first frame.
    h.step(0.05);
    expect(h.zombies[0].taken).toBe(0);
    h.step(0.1);
    expect(h.zombies[0].taken).toBe(MELEE[DEFAULT_MELEE].damage);
  });

  it('applies damage once per swing however many frames it spans', () => {
    const h = controllerHarness();
    h.weapons.equipMelee();
    expect(h.weapons.tryMelee()).toBe(true);

    // Sixty frames across the whole swing, then a second of nothing: a swing that damaged
    // per frame would be the most obvious way for melee combat to be wrong.
    for (let frame = 0; frame < 60; frame += 1) h.step(1 / 60);
    h.step(1);
    expect(h.zombies[0].taken).toBe(MELEE[DEFAULT_MELEE].damage);
    expect(h.weapons.meleeReport.damage).toBe(MELEE[DEFAULT_MELEE].damage);
    expect(h.weapons.meleeReport.lastTarget).toBe(1);
  });

  it('gates a second swing behind the cooldown', () => {
    const h = controllerHarness();
    h.weapons.equipMelee();
    expect(h.weapons.tryMelee()).toBe(true);
    // Straight away: still swinging, and then still cooling down.
    expect(h.weapons.tryMelee()).toBe(false);
    const config = MELEE[DEFAULT_MELEE];
    for (let elapsed = 0; elapsed < config.cooldownSeconds - 0.1; elapsed += 1 / 60) h.step(1 / 60);
    expect(h.weapons.meleeReport.cooldown).toBeGreaterThan(0);
    // A cooldown-gated swing is refused rather than queued, so the damage stays spent.
    expect(h.weapons.tryMelee()).toBe(false);
    expect(h.zombies[0].taken).toBe(config.damage);
    for (let elapsed = 0; elapsed < 0.3; elapsed += 1 / 60) h.step(1 / 60);
    expect(h.weapons.tryMelee()).toBe(true);
    for (let frame = 0; frame < 60; frame += 1) h.step(1 / 60);
    // Second swing, second application: two, not one and not twenty.
    expect(h.zombies[0].taken).toBe(config.damage * 2);
  });

  it('refuses to swing a weapon that is not drawn', () => {
    const h = controllerHarness();
    expect(h.weapons.tryMelee()).toBe(false);
    expect(h.zombies[0].taken).toBe(0);
  });

  it('leaves the firearms exactly as they were', () => {
    const h = controllerHarness({ zombieDistance: 40 });
    // The pistol still fires with melee implemented, and the magazine still counts down.
    const before = h.weapons.snapshot.magazine;
    expect(h.weapons.tryFire()).not.toBeNull();
    expect(h.weapons.snapshot.magazine).toBe(before - 1);
    expect(h.weapons.meleeReport.damage).toBe(0);

    // With the melee weapon drawn the trigger swings instead of firing: the pistol cannot
    // be aimed while a bat is in hand, so a shot from it would be damage out of nowhere.
    h.weapons.equipMelee();
    const loaded = h.weapons.snapshot.magazine;
    h.step(1 / 60, { ...h.snapshot(), firePressed: true, firing: true });
    expect(h.weapons.snapshot.magazine).toBe(loaded);
    expect(h.weapons.meleeReport.swinging).toBe(true);

    // And switching back to a firearm holsters the melee weapon. The sidearm is slot 2 under
    // §14.1 — the key that owns the pistol is the one that puts it back in hand.
    expect(h.weapons.switchSlot(2)).toBe(true);
    expect(h.weapons.isMeleeDrawn).toBe(false);
    expect(h.weapons.tryMelee()).toBe(false);
  });

  it('resets to a firearm in hand with no swing in flight', () => {
    const h = controllerHarness();
    h.weapons.equipMelee();
    h.weapons.tryMelee();
    h.weapons.reset();
    expect(h.weapons.meleeReport).toEqual({
      equipped: null, swinging: false, cooldown: 0, lastTarget: null, damage: 0,
    });
  });
});

describe('melee weapon table', () => {
  it('covers the four melee meshes this pack ships', () => {
    for (const id of ['knife', 'axe', 'barbed-bat', 'spear'] as MeleeId[]) {
      expect(MELEE[id], id).toBeTruthy();
    }
    expect(MELEE[DEFAULT_MELEE]).toBeTruthy();
  });

  it('never collides with a firearm id', () => {
    // Both tables are keyed by id and reach the same loadout, so a shared id would let a
    // melee weapon occupy a firearm slot.
    const firearms = Object.keys(WEAPONS);
    for (const id of Object.keys(MELEE)) {
      expect(firearms, id).not.toContain(id);
    }
  });

  it('declares the fields the runtime reads, in ranges the game can run', () => {
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      const weapon = MELEE[id];
      expect(weapon.id, id).toBe(id);
      expect(weapon.name.length, id).toBeGreaterThan(0);
      expect(weapon.damage, id).toBeGreaterThan(0);
      // A zero arc would never hit anything in front; a half turn or more would hit
      // whatever the player is facing away from.
      expect(weapon.arc, id).toBeGreaterThan(0);
      expect(weapon.arc, id).toBeLessThan(Math.PI);
      expect(weapon.reach, id).toBeGreaterThan(1);
      expect(weapon.reach, id).toBeLessThan(4);
      expect(weapon.cooldownSeconds, id).toBeGreaterThan(0);
      expect(weapon.swingSeconds, id).toBeGreaterThan(0);
      // A swing longer than its own cooldown would leave the weapon in the air.
      expect(weapon.swingSeconds, id).toBeLessThanOrEqual(weapon.cooldownSeconds);
      expect(['Slash', 'Stab'], id).toContain(weapon.clip);
      expect(weapon.modelPath, id).toMatch(/^\/assets\/weapons\/[A-Za-z0-9_-]+\.gltf$/);
      expect(weapon.viewModel.scale, id).toBeGreaterThan(0);
      expect(weapon.viewModel.position.every((value) => Number.isFinite(value)), id).toBe(true);
    }
  });

  it('ships a glTF file for every melee weapon, with the mesh behind it', () => {
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      const name = MELEE[id].modelPath.split('/').pop() ?? '';
      const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
      expect(key, `${id} -> ${MELEE[id].modelPath} is missing`).toBeTruthy();
      if (!key) continue;
      const gltf = JSON.parse(WEAPON_FILES[key]) as {
        asset?: { version?: string };
        meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
      };
      expect(gltf.asset?.version, id).toBe('2.0');
      expect(gltf.meshes?.length ?? 0, id).toBeGreaterThan(0);
      expect(gltf.meshes?.[0]?.primitives?.[0]?.attributes?.POSITION, id).toBeTypeOf('number');
    }
  });

  it('gives each melee weapon its own view model placement', () => {
    const placements = new Set<string>();
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      const position = MELEE[id].viewModel.position;
      expect(placements.has(position.join(',')), id).toBe(false);
      placements.add(position.join(','));
    }
  });

  it('keeps the melee fallback weaker than the sidearm it falls back from', () => {
    // The design intent, not an accident: a melee weapon that outdamaged the pistol would
    // make shooting pointless at the range melee can reach.
    const pistolDps = WEAPONS.pistol.damage * WEAPONS.pistol.fireRate;
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      const weapon = MELEE[id];
      expect(weapon.damage / weapon.cooldownSeconds, id).toBeLessThan(pistolDps);
    }
  });

  it('names a swing clip the survivor rig actually ships', () => {
    // Every survivor file shares the pack's rig, and the third-person swing is only real
    // if the clip the table names is in the file the game loads.
    const files = Object.entries(SURVIVOR_FILES);
    expect(files.length).toBeGreaterThan(0);
    for (const [file, text] of files) {
      const gltf = JSON.parse(text) as { animations?: Array<{ name?: string }> };
      const clips = (gltf.animations ?? []).map((animation) => new AnimationClip(animation.name ?? '', 1, []));
      const names = clips.map((clip) => clip.name);
      expect(names, file).toContain('Slash');
      expect(names, file).toContain('Stab');
      // Resolved the way PlayerAvatar resolves it, so the test fails if the table names a
      // clip the resolver cannot find.
      for (const id of Object.keys(MELEE) as MeleeId[]) {
        const resolution = resolveByCandidates(clips, [[MELEE[id].clip]]);
        expect(resolution.matchedName, `${id} -> ${MELEE[id].clip}`).toBe(MELEE[id].clip);
      }
    }
  });

  it('is the same table a caller reaches through the firearm config', () => {
    // gameConfig re-exports the melee table so existing importers keep one import for
    // weapon data, and a second copy of the table is the failure that would cause.
    expect(MELEE_FROM_CONFIG).toBe(MELEE);
    expect(DEFAULT_FROM_CONFIG).toBe(DEFAULT_MELEE);
    // The melee table adds no firearm, so the firearm ids it was written against are still
    // the first four in table order. Later weapons are appended, never inserted ahead of
    // them: the starting sidearm has to stay the first entry the loadout walks.
    expect(Object.keys(WEAPONS).slice(0, 4)).toEqual(['pistol', 'rifle', 'smg', 'shotgun']);
  });
});
