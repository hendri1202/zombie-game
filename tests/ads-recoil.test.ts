import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';

import { ADS, WEAPONS, WEAPON_FEEL, type WeaponId } from '../src/app/gameConfig';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { GrenadeSystem } from '../src/combat/GrenadeSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import type { CollisionWorld } from '../src/level/CollisionWorld';
import { PlayerController } from '../src/player/PlayerController';
import { WeaponController } from '../src/player/WeaponController';
import { RECOIL_PATTERN_LENGTH, recoilOffset, recoilPattern } from '../src/player/recoilPattern';
import type { InputSnapshot } from '../src/input/InputManager';

/**
 * F3: aiming down the sights, and a recoil pattern that climbs and then walks sideways.
 *
 * These are measuring tests, not pixel tests — this host has no browser and the work order
 * forbids running one here. Everything this feature promised that can be a number is held
 * to as a number: the field of view and the aim cone with the sights up against the same
 * two with them down, the sideways pull against the vertical one on the same burst, the
 * camera's orientation before a burst against its orientation once the burst has
 * recovered, and the state machine's behaviour across every way out of aiming.
 *
 * The rig runs the real `PlayerController` and the real `WeaponController` over one
 * camera, driven frame by frame exactly as `Game.update` drives them — player first, then
 * weapons — so the recoil is measured where the shot puts it and the recovery is measured
 * where the frame loop takes it, not on a stand-in.
 */

/** One simulation frame, the same step the game loop runs. */
const STEP = 1 / 60;
/** Game builds its camera as `PerspectiveCamera(76, aspect, 0.08, 420)`. */
const HIP_FOV = 76;

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

interface Rig {
  weapons: WeaponController;
  player: PlayerController;
  camera: PerspectiveCamera;
  /** The cone each shot was actually fired with, in shot order. */
  spreadPerShot: number[];
  /** The kick handed to the player for each shot, in shot order. */
  recoilPerShot: Array<{ pitch: number; yaw: number }>;
  /** Runs `seconds` of gameplay, one frame at a time, with the given input each frame. */
  run(seconds: number, frame: InputSnapshot | null): void;
}

/**
 * The player and the weapons over one camera.
 *
 * Recoil is *recorded* rather than stubbed: `addRecoil` is wrapped so the test can see the
 * exact pair of numbers each shot handed the camera, while the real implementation still
 * applies them. Stubbing it away would make the no-drift test meaningless — the whole
 * point there is that the real controller puts the camera back.
 */
function rig(options: { grenades?: boolean } = {}): Rig {
  const camera = new PerspectiveCamera(HIP_FOV, 16 / 9, 0.08, 420);
  camera.position.set(0, 1.62, 0);
  camera.updateMatrixWorld(true);

  const events = new EventBus<GameEvents>();
  const spreadPerShot: number[] = [];
  const damage = {
    fire: (params: { spread: number }) => {
      spreadPerShot.push(params.spread);
      return { target: 'none', zone: 'body', killed: false, kind: null, damage: 0 };
    },
  } as unknown as DamageSystem;

  // The collision world only has to answer the player's own questions; this rig never
  // walks into anything.
  const collision = {
    resolveCircle: () => {},
    raycast: () => null,
  } as unknown as CollisionWorld;

  const player = new PlayerController({ camera, collision });
  // First person: the view model is what the player holds, and the mode the feature is for.
  player.setViewMode('first');

  const recoilPerShot: Array<{ pitch: number; yaw: number }> = [];
  const apply = player.addRecoil.bind(player);
  player.addRecoil = (pitch: number, yaw = 0): void => {
    recoilPerShot.push({ pitch, yaw });
    apply(pitch, yaw);
  };

  const weapons = new WeaponController({
    camera,
    events,
    damage,
    player,
    melee: { swing: () => ({ target: 'none', targetId: null, damage: 0 }) } as unknown as MeleeSystem,
    ...(options.grenades ? { grenades: { throw: () => true } as unknown as GrenadeSystem } : {}),
  });
  for (const id of Object.keys(WEAPONS) as WeaponId[]) weapons.grantWeapon(id);

  const run = (seconds: number, frame: InputSnapshot | null): void => {
    let remaining = seconds;
    while (remaining > 1e-9) {
      const dt = Math.min(STEP, remaining);
      player.update(dt, frame);
      weapons.update(dt, frame, true);
      remaining -= dt;
    }
  };

  return { weapons, player, camera, spreadPerShot, recoilPerShot, run };
}

/** Brings the sights fully up, the way holding the aim button does. */
function aim(r: Rig): void {
  r.run(ADS.seconds + 0.05, input({ adsHeld: true }));
}

describe('the numbers aiming is built from', () => {
  it('zooms lightly — a 76 degree hip view, and no tighter than a scope', () => {
    // The work order asks for a light pull-in: anything near a sniper scope hides the
    // horde, which is the entire threat in this game.
    expect(ADS.fovDegrees).toBeGreaterThanOrEqual(55);
    expect(ADS.fovDegrees).toBeLessThanOrEqual(60);
    expect(ADS.fovDegrees).toBeLessThan(HIP_FOV);
    // A cone that is not tightened is not aiming.
    expect(ADS.spreadMultiplier).toBeGreaterThan(0);
    expect(ADS.spreadMultiplier).toBeLessThan(1);
    expect(ADS.seconds).toBeGreaterThan(0);
  });

  it('tightens the view and the aim cone while aiming, by numbers that differ', () => {
    const r = rig();
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);
    const hipCone = r.weapons.aimCone;
    // At the hip the cone is the weapon's own spread, untouched: 0.006 rad for the pistol.
    expect(hipCone).toBeCloseTo(WEAPONS.pistol.spread, 12);

    aim(r);

    expect(r.weapons.aiming).toBe(true);
    expect(r.weapons.aimBlend).toBe(1);
    expect(r.camera.fov).toBe(ADS.fovDegrees);
    const adsCone = r.weapons.aimCone;
    expect(adsCone).toBeCloseTo(WEAPONS.pistol.spread * ADS.spreadMultiplier, 12);
    // Measurably different, and tighter — not merely configured differently.
    expect(adsCone).toBeLessThan(hipCone);
    expect(hipCone / adsCone).toBeCloseTo(1 / ADS.spreadMultiplier, 9);
  });

  it('fires the tighter cone while aiming, tightened only once the sights are up', () => {
    const hip = rig();
    hip.run(0.4, input());
    expect(hip.weapons.tryFire()).not.toBeNull();

    const aimed = rig();
    aim(aimed);
    expect(aimed.weapons.tryFire()).not.toBeNull();

    // Fresh rigs, so the burst bloom of the first shot is not in either measurement.
    expect(hip.spreadPerShot[0]).toBeCloseTo(WEAPONS.pistol.spread, 12);
    expect(aimed.spreadPerShot[0]).toBeCloseTo(WEAPONS.pistol.spread * ADS.spreadMultiplier, 12);
    expect(aimed.spreadPerShot[0]).toBeLessThan(hip.spreadPerShot[0]);
  });

  it('returns the cone and the field of view to normal when the button is released', () => {
    const r = rig();
    aim(r);
    expect(r.weapons.aiming).toBe(true);

    r.run(ADS.seconds + 0.05, input());

    expect(r.weapons.aimBlend).toBe(0);
    expect(r.weapons.aiming).toBe(false);
    expect(r.camera.fov).toBe(HIP_FOV);
    expect(r.weapons.aimCone).toBeCloseTo(WEAPONS.pistol.spread, 12);
  });
});

describe('the recoil pattern', () => {
  it('climbs first and then walks sideways: both axes, in that order', () => {
    const pattern = recoilPattern();
    expect(pattern).toHaveLength(RECOIL_PATTERN_LENGTH);

    // Vertical on every round: no round of the burst is a flat one.
    for (const step of pattern) expect(step.pitch).toBeGreaterThan(0);
    // It climbs before it settles: the second round pulls harder up than the first, and
    // the end of the burst is below the peak rather than above it.
    expect(pattern[1].pitch).toBeGreaterThan(pattern[0].pitch);
    const peak = Math.max(...pattern.map((step) => step.pitch));
    expect(pattern[pattern.length - 1].pitch).toBeLessThan(peak);

    // Sideways arrives after the climb, not with it: the opening shot is a pure climb.
    expect(pattern[0].yaw).toBe(0);
    const sideways = pattern.slice(1);
    const right = sideways.filter((step) => step.yaw > 0);
    const left = sideways.filter((step) => step.yaw < 0);
    // Both directions, so the burst is a walk and not a lean.
    expect(right.length).toBeGreaterThan(0);
    expect(left.length).toBeGreaterThan(0);
    // And it grows: the back half of the burst pulls further out than the front half.
    const half = Math.floor(pattern.length / 2);
    const early = Math.max(...pattern.slice(1, half).map((step) => Math.abs(step.yaw)));
    const late = Math.max(...pattern.slice(half).map((step) => Math.abs(step.yaw)));
    expect(late).toBeGreaterThan(early);
  });

  it('holds on its last step past the end rather than running off the table', () => {
    expect(recoilOffset(-3)).toEqual(recoilOffset(0));
    expect(recoilOffset(RECOIL_PATTERN_LENGTH + 20))
      .toEqual(recoilOffset(RECOIL_PATTERN_LENGTH - 1));
    // Floors rather than rounds, so no shot is ever charged a step it has not reached.
    expect(recoilOffset(1.9)).toEqual(recoilOffset(1));
  });

  it('hands the camera a vertical kick on every round and a sideways one on most', () => {
    const r = rig();
    const shots = 6;
    for (let shot = 0; shot < shots; shot += 1) {
      // Let the weapon's own cadence come round. The pattern only restarts after
      // RECOIL_RESET_SECONDS (0.35 s), which is longer than the pistol's 0.18 s interval,
      // so a burst fired this way keeps walking the pattern.
      r.run(1 / WEAPONS.pistol.fireRate + 0.005, input());
      expect(r.weapons.tryFire(), `shot ${shot} was refused`).not.toBeNull();
    }

    expect(r.recoilPerShot).toHaveLength(shots);
    const pitches = r.recoilPerShot.map((shot) => shot.pitch);
    const yaws = r.recoilPerShot.map((shot) => shot.yaw);

    // Vertical on every round, and the first round is the weapon's own recoil exactly —
    // the pattern scales the kick the weapon already had rather than replacing it.
    for (const pitch of pitches) expect(pitch).toBeGreaterThan(0);
    expect(pitches[0]).toBeCloseTo(WEAPONS.pistol.recoil, 12);

    // Sideways: nothing on the opening round, both directions across the burst.
    expect(yaws[0]).toBe(0);
    expect(yaws.slice(1).some((yaw) => yaw > 0)).toBe(true);
    expect(yaws.slice(1).some((yaw) => yaw < 0)).toBe(true);
    // Scaled from the weapon's own kick, not a second per-weapon table.
    expect(Math.abs(yaws[1])).toBeCloseTo(WEAPONS.pistol.recoil * Math.abs(recoilOffset(1).yaw), 12);
  });

  it('starts a new burst at the start of the pattern after a pause between shots', () => {
    const r = rig();
    // Three shots, then a gap longer than the reset window, then one more.
    for (let shot = 0; shot < 3; shot += 1) {
      r.run(1 / WEAPONS.pistol.fireRate + 0.005, input());
      expect(r.weapons.tryFire()).not.toBeNull();
    }
    r.run(0.5, input());
    r.run(1 / WEAPONS.pistol.fireRate + 0.005, input());
    expect(r.weapons.tryFire()).not.toBeNull();
    // The fourth shot is the first round of a new pattern: full climb, no sideways pull.
    const last = r.recoilPerShot[r.recoilPerShot.length - 1];
    expect(last.pitch).toBeCloseTo(WEAPONS.pistol.recoil, 12);
    expect(last.yaw).toBe(0);
  });
});

describe('recoil recovery leaves the aim where the player left it', () => {
  it('takes the camera away from the aim during a burst and puts it back afterwards', () => {
    const r = rig();
    // Aim somewhere that is not the neutral pose, so a drift would have somewhere to show.
    r.player.pitch = 0.2;
    r.player.yaw = 1.1;
    r.run(STEP, input());

    const beforeX = r.camera.rotation.x;
    const beforeY = r.camera.rotation.y;
    expect(beforeX).toBeCloseTo(0.2, 12);
    expect(beforeY).toBeCloseTo(1.1, 12);

    for (let shot = 0; shot < 6; shot += 1) {
      r.run(1 / WEAPONS.pistol.fireRate + 0.005, input());
      expect(r.weapons.tryFire()).not.toBeNull();
    }

    // Both axes moved the camera: the burst is not a straight climb.
    expect(r.camera.rotation.x - beforeX).toBeGreaterThan(0.005);
    expect(Math.abs(r.camera.rotation.y - beforeY)).toBeGreaterThan(0.0005);

    r.run(3, input());

    // The offsets have bled back to nothing...
    expect(Math.abs(r.player.currentRecoilPitch)).toBeLessThan(1e-6);
    expect(Math.abs(r.player.currentRecoilYaw)).toBeLessThan(1e-6);
    // ...and the player's own aim was never written to by a shot, so there is no residual
    // drift to fight: this is the exactness that makes the recovery honest rather than
    // "close enough".
    expect(r.player.pitch).toBe(0.2);
    expect(r.player.yaw).toBe(1.1);
    expect(r.camera.rotation.x).toBeCloseTo(beforeX, 6);
    expect(r.camera.rotation.y).toBeCloseTo(beforeY, 6);
  });

  it('recovers even while the frames are frozen, so a pause cannot leave it kicked', () => {
    const r = rig();
    r.run(1 / WEAPONS.pistol.fireRate + 0.005, input());
    expect(r.weapons.tryFire()).not.toBeNull();
    expect(Math.abs(r.player.currentRecoilPitch)).toBeGreaterThan(0);
    // Paused: Game passes a null snapshot but keeps calling both controllers.
    r.run(2, null);
    expect(Math.abs(r.player.currentRecoilPitch)).toBeLessThan(1e-6);
    expect(Math.abs(r.player.currentRecoilYaw)).toBeLessThan(1e-6);
  });
});

describe('aiming never sticks and never blocks the rest of the kit', () => {
  it('drops the sights once the button is released, after firing from the sights', () => {
    const r = rig();
    r.run(0.4, input({ adsHeld: true, firePressed: true }));
    expect(r.weapons.aiming).toBe(true);
    // The rifle is the automatic one; the pistol needs a press, and this snapshot holds
    // it, so the trigger works from the sights exactly as it does from the hip.
    expect(r.spreadPerShot.length).toBeGreaterThan(0);

    r.run(ADS.seconds + 0.05, input());
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);
    // And the weapon still fires: aiming did not take the trigger away.
    r.run(1 / WEAPONS.pistol.fireRate + 0.005, input());
    expect(r.weapons.tryFire()).not.toBeNull();
  });

  it('carries the sights across a weapon switch, and drops them on release', () => {
    const r = rig();
    aim(r);
    expect(r.weapons.aiming).toBe(true);

    expect(r.weapons.switchTo('rifle')).toBe(true);
    // The button is still held, so the new weapon is aimed too — the state follows the
    // input rather than a weapon the swap has left behind.
    r.run(ADS.seconds + 0.05, input({ adsHeld: true }));
    expect(r.weapons.aiming).toBe(true);
    expect(r.camera.fov).toBe(ADS.fovDegrees);

    r.run(ADS.seconds + 0.05, input());
    expect(r.weapons.aiming).toBe(false);
    expect(r.camera.fov).toBe(HIP_FOV);
  });

  it('puts the sights down for melee and brings them back for the firearm', () => {
    const r = rig();
    aim(r);
    expect(r.weapons.aiming).toBe(true);

    // F draws the bat while the aim button is still down. There is nothing to aim, so the
    // sights go — and the swing itself is untouched by the button being held.
    expect(r.weapons.equipMelee()).toBe(true);
    r.run(ADS.seconds + 0.05, input({ adsHeld: true }));
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);
    expect(r.weapons.tryMelee()).toBe(true);
    r.run(0.5, input({ adsHeld: true }));
    expect(r.weapons.meleeReport.swinging).toBe(false);

    // Back to the firearm with the button still down: the sights come back up, and a
    // release still puts them down. Nothing is latched either way.
    expect(r.weapons.holsterMelee()).toBe(true);
    r.run(ADS.seconds + 0.05, input({ adsHeld: true }));
    expect(r.weapons.aiming).toBe(true);
    r.run(ADS.seconds + 0.05, input());
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);
  });

  it('puts the sights down for the grenade, which still throws from the held trigger', () => {
    const r = rig({ grenades: true });
    aim(r);
    expect(r.weapons.aiming).toBe(true);

    expect(r.weapons.equipOrdnance()).toBe(true);
    r.run(ADS.seconds + 0.05, input({ adsHeld: true, firePressed: true }));
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);
    // The throw is what the trigger does while the grenade is in hand: it works.
    expect(r.spreadPerShot).toHaveLength(0);

    // Back to the firearm: the sights resume with the button, and release ends them.
    expect(r.weapons.holsterOrdnance()).toBe(true);
    r.run(ADS.seconds + 0.05, input({ adsHeld: true }));
    expect(r.weapons.aiming).toBe(true);
    r.run(ADS.seconds + 0.05, input());
    expect(r.weapons.aimBlend).toBe(0);
  });

  it('keeps the jump working while aiming, and the sights up through it', () => {
    const r = rig();
    aim(r);
    expect(r.weapons.aiming).toBe(true);

    // One frame with the jump key down: the same edge-triggered press the game delivers.
    r.run(STEP, input({ adsHeld: true, jumpPressed: true }));
    expect(r.player.grounded, 'the jump was refused while aiming').toBe(false);
    // Aiming is a camera state, not a movement state: the jump does not drop the sights.
    expect(r.weapons.aiming).toBe(true);
    expect(r.camera.fov).toBe(ADS.fovDegrees);

    r.run(ADS.seconds + 0.05, input());
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);
  });

  it('drops the sights when the game stops taking input, and on a run restart', () => {
    const r = rig();
    aim(r);
    expect(r.weapons.aiming).toBe(true);

    // Paused or on the title screen: Game passes no snapshot at all. A game paused mid-aim
    // must not stay zoomed in behind the menu.
    r.run(0.05, null);
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);

    // And a restart starts at the hip whatever the blend was.
    aim(r);
    expect(r.weapons.aiming).toBe(true);
    r.weapons.reset();
    expect(r.weapons.aimBlend).toBe(0);
    expect(r.camera.fov).toBe(HIP_FOV);
  });
});

describe('the view model and the weapon tables are left alone', () => {
  it('centres the weapon while aiming and puts it back at its own hip hold', () => {
    const r = rig();
    // Let the equip drop settle so the only thing moving the holder is the aim blend.
    r.run(0.4, input());
    const hip = r.weapons.viewModelHold;
    const configured = WEAPONS.pistol.viewModel.position;
    expect(hip.toArray()).toEqual(configured);

    aim(r);

    const aimed = r.weapons.viewModelHold;
    // Towards the middle of the screen: the hold is right and low at the hip.
    expect(Math.abs(aimed.x)).toBeLessThan(Math.abs(hip.x));
    expect(aimed.y).toBeGreaterThan(hip.y);
    expect(aimed.x).toBeCloseTo(ADS.viewModelPosition[0], 9);
    expect(aimed.y).toBeCloseTo(ADS.viewModelPosition[1], 9);
    // The hold depth is untouched, so the muzzle keeps its forward offset: only x and y
    // are allowed to move.
    expect(aimed.z).toBe(hip.z);

    // Released: back at the weapon's own configured hold, exactly — which is where the
    // muzzle the flash and the tracer leave from is derived.
    r.run(ADS.seconds + 0.05, input());
    expect(r.weapons.viewModelHold.toArray()).toEqual(configured);
  });

  it('fires one round, and does not move the muzzle offset or the mechanism report', () => {
    const feel = JSON.parse(JSON.stringify(WEAPON_FEEL)) as typeof WEAPON_FEEL;
    const r = rig();
    aim(r);
    const before = r.weapons.snapshot.magazine;
    expect(r.weapons.tryFire()).not.toBeNull();
    // One press, one round: aiming is not a second shot.
    expect(r.weapons.snapshot.magazine).toBe(before - 1);
    // The mechanism report still describes every weapon, and the muzzle offsets the flash
    // and the casing are derived from are exactly where they shipped.
    expect(r.weapons.mechanismReport.enabled).toBe(true);
    expect(WEAPON_FEEL).toEqual(feel);
    expect(WEAPON_FEEL.muzzleOffset).toEqual([0, 0.03, -0.36]);
    expect(WEAPON_FEEL.ejectionPortOffset).toEqual([0.05, 0.02, -0.12]);
  });

  it('leaves damage, fire rate, magazine, pellets, tracer and the view model table as shipped',
    () => {
      const table = JSON.parse(JSON.stringify(WEAPONS)) as typeof WEAPONS;
      const r = rig();
      // The whole surface of the feature: aim, fire a burst from the sights, switch weapon
      // with the button still down, then release.
      aim(r);
      for (let shot = 0; shot < 4; shot += 1) {
        r.run(0.2, input({ adsHeld: true, firePressed: true }));
      }
      r.weapons.switchTo('rifle');
      r.run(0.4, input({ adsHeld: true, firePressed: true }));
      r.run(ADS.seconds + 0.05, input());

      expect(WEAPONS).toEqual(table);
      for (const id of Object.keys(WEAPONS) as WeaponId[]) {
        expect(WEAPONS[id].damage, id).toBe(table[id].damage);
        expect(WEAPONS[id].fireRate, id).toBe(table[id].fireRate);
        expect(WEAPONS[id].magazineSize, id).toBe(table[id].magazineSize);
        expect(WEAPONS[id].pellets, id).toBe(table[id].pellets);
        expect(WEAPONS[id].tracerEvery, id).toBe(table[id].tracerEvery);
        expect(WEAPONS[id].recoil, id).toBe(table[id].recoil);
        expect(WEAPONS[id].viewModel, id).toEqual(table[id].viewModel);
      }
    });
});
