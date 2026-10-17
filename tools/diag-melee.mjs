// Every melee weapon, drawn in the player's hands and swung at a zombie that is actually
// in reach, with the blow proved in the game rather than only in a unit test.
//
// A swing has three ways to be quietly broken and none of them shows up in the weapon's
// own stats: the cone can miss because the target is 46 m down the street (past every
// melee reach), the cooldown can fail to hold so one key press deals two blows, and the
// swing can resolve against the camera yaw instead of the player's facing so it looks
// right and damages nothing. So each weapon is equipped, the horde is filled, the player
// is teleported next to the nearest zombie (diag-weapons' lesson: the spawn ring is 24-52 m
// out, beyond every melee reach), photographed at rest and mid-swing, and then made to:
//
//   1. land one blow, proved by the swing reporting a zombie target with damage > 0 and by
//      the game's own hitsLanded counter going up by one;
//   2. refuse a second blow inside the cooldown, proved by the counter NOT moving when the
//      trigger is pulled again while the cooldown is still running;
//   3. still work in third person, where the weapon is not even on screen.
//
// The run fails loudly (exit 1) if any of those does not hold, printing the observed
// numbers rather than saying only "failed".
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePng, launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 900, height: 506 };
/**
 * The melee roster.
 *
 * The game exposes no melee-config hook (unlike debugWeaponConfig for firearms), so the
 * ids are named here — the same table `src/app/meleeConfig.ts` declares — and can be
 * overridden for a focused run. Every id is still validated in-game: the tool fails if
 * debugEquipMelee cannot actually put it in the player's hands.
 */
const MELEE = (process.env.MELEE_ONLY || 'knife,axe,barbed-bat,spear').split(',').filter(Boolean);
/** How far from the target's centre to stand. Inside every reach, outside most attacks. */
/**
 * Stand-off as a fraction of each weapon's reach. 0.55 leaves margin for a walker's own
 * radius and for the frames it moves between the approach and the blow landing.
 */
const STANDOFF_FRACTION = Number(process.env.STANDOFF_FRACTION || 0.55);
/** Extra walkers spawned per weapon so there is always something to swing at. */
const HORDE = Number(process.env.HORDE || 6);
/** Frames ticked into the swing before the mid-swing photo. */
const SWING_PHOTO_FRAMES = Number(process.env.SWING_PHOTO_FRAMES || 8);

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launchChrome({ width: VIEWPORT.width, height: VIEWPORT.height });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0, sensitivity: 1, quality: 'medium', shadows: true,
    flashEffects: true, debugOverlay: false })); } catch (e) {}`,
});

const save = async (name, timeoutMs = 180000) => {
  const file = await capturePng(page, join(SHOTS, `${name}.png`), { timeoutMs });
  console.log(`  saved ${file}`);
  return file;
};

/** Evaluates an expression that returns a JSON string, and parses it in Node. */
const ev = async (expression, timeoutMs = 180000) => JSON.parse(
  await page.evaluate(expression, { timeoutMs }),
);

await open(page, URL_BASE, { waitMs: 1000 });
await page.evaluate(`(async () => {
  for (let i = 0; i < 900; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 150000 });
console.log('booted');

await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 30000 });
await page.evaluate(`(() => {
  const g = window.deadDistrict;
  for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
  return true;
})()`, { timeoutMs: 60000 });

// Page-side helpers, installed once. Each evaluate below is then a handful of lines and
// the geometry (find nearest, teleport next to it, tick a swing to its end) lives in one
// place instead of being re-derived per step.
await page.evaluate(`(() => {
  const g = window.deadDistrict;
  const report = () => g.debugMeleeReport();
  const info = () => g.debugInfo();
  const tick = (n, render) => {
    for (let i = 0; i < n; i += 1) g.debugTick(1 / 60, { render: render === true });
  };
  /**
   * The nearest zombie a swing could actually land on.
   *
   * Alive only. The melee cone skips a corpse (selectMeleeTargets filters on the alive flag), but
   * the director keeps a dead walker in its list for its death animation, sitting exactly
   * where it fell. Standing next to that corpse and aiming at it looked like a perfectly
   * aimed swing — 0.2 degrees off, 1.65 m away — while the only live walker was 20.8 m down
   * the street, so the blow landed on nothing and the harness blamed the weapon. The game's
   * own debugAimAtNearestZombie has always filtered on isAlive; this now matches it.
   */
  const nearest = () => {
    const state = info();
    const me = state.playerPosition;
    const positions = state.zombiePositions || [];
    const states = state.zombieStates || [];
    let best = Infinity;
    let pos = null;
    for (let i = 0; i < positions.length; i += 1) {
      const zombieState = String(states[i] || '').split(':')[1];
      if (zombieState === 'death' || zombieState === 'despawned') continue;
      const p = positions[i];
      const d = Math.hypot(p[0] - me[0], p[1] - me[1]);
      if (d < best) { best = d; pos = p; }
    }
    return { gap: best, pos };
  };
  /**
   * How far to stand from the target for this weapon.
   *
   * A fixed 2.0 m stand-off was the harness's own bug: the axe's reach is exactly 2.0 m, so
   * the blow had no margin and every swing measured "the weapon does nothing". The distance is
   * now a fraction of the weapon's reach, read from the game rather than hardcoded here.
   */
  const standoff = (id) => {
    const config = (g.debugMeleeConfig ? g.debugMeleeConfig() : {})[id];
    const reach = config && config.reach ? config.reach : 2;
    return Math.min(2.2, Math.max(0.9, reach * ${STANDOFF_FRACTION}));
  };
  const approach = (id) => {
    const n = nearest();
    if (n.pos) g.debugTeleport(n.pos[0], n.pos[1] + standoff(id));
    return n.pos ? Number(n.gap.toFixed(2)) : null;
  };
  /**
   * Distance and angular error to the nearest zombie, measured at the moment of the swing.
   *
   * The 180 degrees matter. This project keeps two yaws: playerYaw is the camera's, looking
   * down -Z, while the model and the melee cone use the facing angle, whose bearing is
   * atan2(dx, dz) and whose model faces +Z. Subtracting the two without accounting for that
   * reported a perfectly aimed knife as 179.7 degrees off — and that knife then landed 32
   * damage. The convention is applied here so the number can be trusted. No backticks in this
   * comment: the whole block is one template literal, and a backtick ends it early.
   */
  const aimReadout = () => {
    const state = info();
    const n = nearest();
    if (!n.pos) return { gap: null, angleErrorDeg: null };
    const bearing = Math.atan2(n.pos[0] - state.playerPosition[0], n.pos[1] - state.playerPosition[1]);
    // facingAngle equivalent of a camera yaw is yaw + PI; fold into (-PI, PI].
    let diff = (bearing - (state.playerYaw + Math.PI) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return {
      gap: Number(n.gap.toFixed(2)),
      angleErrorDeg: Number((Math.abs(diff) * 180 / Math.PI).toFixed(1)),
    };
  };
  const ensureAlive = () => {
    const state = info();
    if (state.playerAlive && state.phase === 'playing') return true;
    const button = document.getElementById('btn-restart-pause');
    if (button) button.click();
    tick(30);
    return info().playerAlive;
  };
  const assumeFirstPerson = () => {
    if (info().viewMode !== 'first') g.debugToggleView();
    return info().viewMode;
  };
  // Drives frames until the swing leaves the air. The hit lands at 35% of the swing, so
  // stopping here guarantees it had its chance; the swing is always shorter than the
  // cooldown, so the cooldown is still running for the probe that follows.
  const swingUntilDone = (cap) => {
    for (let i = 0; i < cap; i += 1) {
      g.debugTick(1 / 60, { render: false });
      if (!report().swinging) return i + 1;
    }
    return -1;
  };
  /**
   * Everything the swing cone can see, measured at the swing frame.
   *
   * Two numbers per zombie, not one, because the game and this harness have disagreed before
   * about what "in front" means: the angle is taken against the player's facing (the cone's
   * axis, camera yaw + PI) and against the camera's own forward direction, so a sign or a
   * half-turn cannot hide. The alive flag is reported because the cone skips corpses and a dead
   * walker still in the director's list sits exactly where it fell.
   */
  const probe = (id) => {
    const state = info();
    const me = state.playerPosition;
    const cfg = (g.debugMeleeConfig ? g.debugMeleeConfig() : {})[id] || {};
    const yaw = state.playerYaw;
    const camDir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const rows = [];
    const positions = state.zombiePositions || [];
    const states = state.zombieStates || [];
    for (let i = 0; i < positions.length; i += 1) {
      const x = positions[i][0];
      const z = positions[i][1];
      const parts = String(states[i] || '').split(':');
      const kindName = parts[0];
      const zombieState = parts[1];
      const health = parts[2];
      const dx = x - me[0];
      const dz = z - me[1];
      const distance = Math.hypot(dx, dz);
      const bearing = Math.atan2(dx, dz);
      // facingAngle of a camera yaw is yaw + PI; fold the difference into (-PI, PI].
      const facing = yaw + Math.PI;
      let relFacing = (bearing - facing + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      let relCamera = (bearing - Math.atan2(camDir.x, camDir.z) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      rows.push({
        i,
        kind: kindName,
        state: zombieState,
        health,
        alive: zombieState !== 'death' && zombieState !== 'despawned',
        x, z,
        d: Number(distance.toFixed(2)),
        angFacing: Number((Math.abs(relFacing) * 180 / Math.PI).toFixed(1)),
        angCamera: Number((Math.abs(relCamera) * 180 / Math.PI).toFixed(1)),
      });
    }
    rows.sort((a, b) => a.d - b.d);
    const rawNearest = rows[0] || null;
    const aliveNearest = rows.find((r) => r.alive) || null;
    return {
      id,
      reach: cfg.reach != null ? cfg.reach : null,
      arcDeg: cfg.arc != null ? Number((cfg.arc * 180 / Math.PI).toFixed(1)) : null,
      player: me,
      camera: state.cameraPosition,
      playerYaw: yaw,
      rawNearest,
      aliveNearest,
      zombies: rows.slice(0, 4),
    };
  };
  window.__mh = {
    report, info, tick, nearest, approach, standoff, aimReadout, probe,
    ensureAlive, assumeFirstPerson, swingUntilDone,
  };
  return true;
})()`, { timeoutMs: 60000 });

const rows = [];
const failures = [];

for (const id of MELEE) {
  // Equip, get a target in reach, and photograph the weapon at rest.
  const setup = await ev(`(() => {
    const g = window.deadDistrict; const mh = window.__mh;
    const alive = mh.ensureAlive();
    g.debugUnlockAllWeapons();
    const view = mh.assumeFirstPerson();
    g.debugSetLook(Math.PI, 0);
    const equipped = g.debugEquipMelee('${id}');
    mh.tick(30);
    const spawned = g.debugFillHorde(${HORDE});
    mh.tick(6);
    const gap = mh.approach('${id}');
    // A short settle only: the walker chases at ~1.9 m/s, so the longer this waits the
    // closer it gets, and at 2 m the player is outside a walker's 1.75 m attack range.
    mh.tick(3);
    const aimed = g.debugAimAtNearestZombie();
    mh.tick(1);
    const state = mh.info();
    return JSON.stringify({
      alive, view, spawned, equipped, aimed, gap,
      reportEquipped: mh.report().equipped,
      before: mh.report(),
      playerAlive: state.playerAlive, zombies: state.activeZombies,
    });
  })()`);
  if (!setup.alive) failures.push(`${id}: the player could not be put into a live run`);
  if (setup.equipped !== id) failures.push(`${id}: debugEquipMelee(${id}) reported ${setup.equipped}`);
  if (setup.reportEquipped !== id) failures.push(`${id}: the melee report shows ${setup.reportEquipped} in hand`);
  if (setup.gap === null) failures.push(`${id}: no zombie was available to swing at (activeZombies=${setup.zombies})`);
  console.log(`${id}: setup ${JSON.stringify({
    view: setup.view, spawned: setup.spawned, gap: setup.gap, zombies: setup.zombies, before: setup.before,
  })}`);

  await page.evaluate('window.deadDistrict.debugTick(1 / 60, { render: true })', { timeoutMs: 120000 });
  await save(`melee-${id}-held`);

  // Start one swing and photograph it mid-arc.
  const start = await ev(`(() => {
    const g = window.deadDistrict; const mh = window.__mh;
    // The previous weapon's swing may still be cooling down, and a refused swing reads as
    // "melee does not damage" — an artefact of the harness, not a finding. Wait it out first.
    let waitedFrames = 0;
    for (let i = 0; i < 120 && mh.report().cooldown > 0; i += 1) {
      g.debugTick(1 / 60, { render: false });
      waitedFrames += 1;
    }
    mh.tick(2);
    // Aim until the measurement says the blow will be on target. Swinging straight after the
    // aim call produced 115.7 and 56.5 degree misses on one run and landed nothing, while the
    // two weapons whose aim happened to have settled read 0.3 and 0 degrees and both connected.
    // The melee cone was never the problem; the aim was.
    let aimFrames = 0;
    for (let i = 0; i < 40; i += 1) {
      const readout = mh.aimReadout();
      if (readout.angleErrorDeg !== null && readout.angleErrorDeg < 8) break;
      g.debugAimAtNearestZombie();
      g.debugTick(1 / 60, { render: false });
      aimFrames += 1;
    }
    const measured = mh.aimReadout();
    const probeBefore = mh.probe('${id}');
    const hitsBefore = mh.info().hitsLanded;
    const started = g.debugSwingMelee();
    mh.tick(${SWING_PHOTO_FRAMES});
    g.debugTick(1 / 60, { render: true });
    return JSON.stringify({
      started, hitsBefore, waitedFrames, aimFrames, measured, probeBefore,
      swinging: mh.report().swinging, cooldown: mh.report().cooldown,
    });
  })()`);
  await save(`melee-${id}-swung`);
  if (!start.started) failures.push(`${id}: debugSwingMelee() refused to start a swing`);
  if (!start.swinging) failures.push(`${id}: the swing was already over before it could be photographed`);

  // Let the swing play out; it must land one blow on a zombie.
  const hit = await ev(`(() => {
    const g = window.deadDistrict; const mh = window.__mh;
    const frames = mh.swingUntilDone(40);
    const report = mh.report();
    const state = mh.info();
    return JSON.stringify({
      frames, damage: report.damage, lastTarget: report.lastTarget, swinging: report.swinging,
      cooldown: report.cooldown, hitsDelta: state.hitsLanded - ${start.hitsBefore},
      playerAlive: state.playerAlive,
    });
  })()`);
  console.log(`${id}: swing ${JSON.stringify(hit)}`);
  if (hit.damage <= 0) {
    failures.push(`${id}: one swing landed ${hit.damage} damage on a zombie`
      + ` (gap ${start.measured?.gap} m, angular error ${start.measured?.angleErrorDeg} deg)`);
  }
  if (hit.lastTarget === null) failures.push(`${id}: the swing reported no target (damage=${hit.damage})`);
  if (hit.hitsDelta < 1) failures.push(`${id}: hitsLanded did not move after a landed swing (delta=${hit.hitsDelta})`);

  // Pull the trigger again inside the cooldown: it must be refused and must not damage.
  const cooldown = await ev(`(() => {
    const g = window.deadDistrict; const mh = window.__mh;

    // A screenshot costs about a second and the knife's whole swing plus cooldown is 0.42 s, so
    // photographing a swing and probing its cooldown cannot be done on the same swing: the photo
    // consumes the cooldown, and an extra swing started for the probe lands its own hit and
    // inflates the damage delta. So this step owns its swing outright, with no frame between the
    // two calls, and asserts only what that can isolate: a second swing starts nothing, a
    // cooldown is running when it is refused, and no damage moves while it is refused.
    for (let i = 0; i < 120 && mh.report().cooldown > 0; i += 1) g.debugTick(1 / 60, { render: false });
    const hitsBefore = mh.info().hitsLanded;
    const damageBefore = mh.report().damage;
    const first = g.debugSwingMelee();
    const cooldownObserved = mh.report().cooldown;
    const refused = g.debugSwingMelee();
    // Read the counters before any frame runs, so nothing the first swing does can be attributed
    // to the refused one.
    const hitsAtRefusal = mh.info().hitsLanded;
    const damageAtRefusal = mh.report().damage;
    mh.tick(6);
    const after = mh.report();
    const hitsAfter = mh.info().hitsLanded;
    return JSON.stringify({
      first, refused, cooldownObserved, swingingAfter: after.swinging,
      damageBefore, damageAtRefusal,
      hitsDeltaImmediate: hitsAtRefusal - hitsBefore,
      damageDeltaImmediate: damageAtRefusal - damageBefore,
      // Kept for the record: this one includes the first swing's own hit and cannot distinguish it.
      hitsDeltaAfterFrames: hitsAfter - hitsBefore,
    });
  })()`);
  console.log(`${id}: cooldown ${JSON.stringify(cooldown)}`);
  // If this still reads zero the harness could not get a cooldown running at all, which is a
  // different problem from a refused swing and is reported as such.
  if (cooldown.first !== true) failures.push(`${id}: the probe's own swing would not start`);
  if (!(cooldown.cooldownObserved > 0)) {
    failures.push(`${id}: no cooldown was running when the second swing was tried (cooldown=${cooldown.cooldownObserved})`);
  }
  if (cooldown.refused !== false) failures.push(`${id}: a second swing started while the cooldown was running`);
  if (cooldown.hitsDeltaImmediate !== 0) {
    failures.push(`${id}: the refused swing moved the hit counter (+${cooldown.hitsDeltaImmediate})`);
  }
  if (cooldown.damageDeltaImmediate !== 0) {
    failures.push(`${id}: damage moved on a refused swing (+${cooldown.damageDeltaImmediate})`);
  }

  // Third person: the weapon is not on screen, but the swing must still land.
  const third = await ev(`(() => {
    const g = window.deadDistrict; const mh = window.__mh;
    for (let i = 0; i < 90 && mh.report().cooldown > 0; i += 1) g.debugTick(1 / 60, { render: false });
    const cooldownAfterWait = mh.report().cooldown;
    const alive = mh.ensureAlive();
    g.debugEquipMelee('${id}');
    mh.tick(30);
    let mode = mh.info().viewMode;
    for (let i = 0; i < 2 && mode !== 'third'; i += 1) mode = g.debugToggleView();
    g.debugFillHorde(${HORDE});
    mh.tick(6);
    const gap = mh.approach('${id}');
    mh.tick(3);
    let aimFrames = 0;
    for (let i = 0; i < 40; i += 1) {
      const readout = mh.aimReadout();
      if (readout.angleErrorDeg !== null && readout.angleErrorDeg < 8) break;
      g.debugAimAtNearestZombie();
      g.debugTick(1 / 60, { render: false });
      aimFrames += 1;
    }
    const measured = mh.aimReadout();
    const probeBefore = mh.probe('${id}');
    const hitsBefore = mh.info().hitsLanded;
    const started = g.debugSwingMelee();
    const frames = mh.swingUntilDone(40);
    const report = mh.report();
    const state = mh.info();
    return JSON.stringify({
      alive, mode, cooldownAfterWait, gap, aimFrames, measured, probeBefore, started, frames,
      damage: report.damage, lastTarget: report.lastTarget,
      hitsDelta: state.hitsLanded - hitsBefore, playerAlive: state.playerAlive,
    });
  })()`);
  console.log(`${id}: third person ${JSON.stringify(third)}`);
  // A photograph of the third-person swing: the melee mesh is attached to the character's hand
  // now, and "attached" in the scene graph is not the same claim as "visible in the frame".
  await page.evaluate('window.deadDistrict.debugTick(1 / 60, { render: true })', { timeoutMs: 120000 });
  await save(`melee-${id}-third-person`);
  if (third.mode !== 'third') failures.push(`${id}: could not switch to third person (view=${third.mode})`);
  if (third.started !== true) failures.push(`${id}: the swing did not start in third person`);
  if (third.damage <= 0) failures.push(`${id}: the third-person swing landed ${third.damage} damage`);
  if (third.lastTarget === null) failures.push(`${id}: the third-person swing reported no target`);
  if (third.hitsDelta < 1) failures.push(`${id}: hitsLanded did not move in third person (delta=${third.hitsDelta})`);

  rows.push({
    id,
    equipped: setup.equipped,
    gap: setup.gap,
    swing: { damage: hit.damage, target: hit.lastTarget, frames: hit.frames },
    cooldown: { running: cooldown.cooldownObserved, started: cooldown.started, hitsDelta: cooldown.hitsDelta },
    thirdPerson: { damage: third.damage, target: third.lastTarget, hitsDelta: third.hitsDelta },
  });
}

console.log('\nmelee report:');
for (const row of rows) console.log(`  ${row.id}: ${JSON.stringify(row)}`);
console.log('screenshots:', SHOTS);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
}
console.log(failures.length === 0 ? '\nMELEE_OK' : '\nMELEE_FAILED');
browser.close();
await sleep(200);
process.exit(failures.length === 0 ? 0 : 1);
