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
const NEAR_OFFSET = Number(process.env.NEAR_OFFSET || 2);
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
  const nearest = () => {
    const state = info();
    const me = state.playerPosition;
    let best = Infinity;
    let pos = null;
    for (const p of state.zombiePositions) {
      const d = Math.hypot(p[0] - me[0], p[1] - me[1]);
      if (d < best) { best = d; pos = p; }
    }
    return { gap: best, pos };
  };
  const approach = () => {
    const n = nearest();
    if (n.pos) g.debugTeleport(n.pos[0], n.pos[1] + ${NEAR_OFFSET});
    return n.pos ? Number(n.gap.toFixed(2)) : null;
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
  window.__mh = { report, info, tick, nearest, approach, ensureAlive, assumeFirstPerson, swingUntilDone };
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
    const gap = mh.approach();
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
    g.debugAimAtNearestZombie();
    const hitsBefore = mh.info().hitsLanded;
    const started = g.debugSwingMelee();
    mh.tick(${SWING_PHOTO_FRAMES});
    g.debugTick(1 / 60, { render: true });
    return JSON.stringify({
      started, hitsBefore, swinging: mh.report().swinging, cooldown: mh.report().cooldown,
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
  if (hit.damage <= 0) failures.push(`${id}: one swing landed ${hit.damage} damage on a zombie`);
  if (hit.lastTarget === null) failures.push(`${id}: the swing reported no target (damage=${hit.damage})`);
  if (hit.hitsDelta < 1) failures.push(`${id}: hitsLanded did not move after a landed swing (delta=${hit.hitsDelta})`);

  // Pull the trigger again inside the cooldown: it must be refused and must not damage.
  const cooldown = await ev(`(() => {
    const g = window.deadDistrict; const mh = window.__mh;
    const before = mh.report();
    const hitsBefore = mh.info().hitsLanded;
    const started = g.debugSwingMelee();
    mh.tick(6);
    const after = mh.report();
    const hitsAfter = mh.info().hitsLanded;
    return JSON.stringify({
      cooldownObserved: before.cooldown, started, swingingAfter: after.swinging,
      damageBefore: before.damage, damageAfter: after.damage,
      hitsDelta: hitsAfter - hitsBefore,
    });
  })()`);
  console.log(`${id}: cooldown ${JSON.stringify(cooldown)}`);
  if (!(cooldown.cooldownObserved > 0)) {
    failures.push(`${id}: no cooldown was running when the second swing was tried (cooldown=${cooldown.cooldownObserved})`);
  }
  if (cooldown.started !== false) failures.push(`${id}: a second swing started while the cooldown was running`);
  if (cooldown.hitsDelta !== 0) failures.push(`${id}: the refused swing still applied damage (hitsLanded +${cooldown.hitsDelta})`);
  if (cooldown.damageAfter !== cooldown.damageBefore) {
    failures.push(`${id}: damage moved on a refused swing (${cooldown.damageBefore} -> ${cooldown.damageAfter})`);
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
    const gap = mh.approach();
    mh.tick(3);
    g.debugAimAtNearestZombie();
    const hitsBefore = mh.info().hitsLanded;
    const started = g.debugSwingMelee();
    const frames = mh.swingUntilDone(40);
    const report = mh.report();
    const state = mh.info();
    return JSON.stringify({
      alive, mode, cooldownAfterWait, gap, started, frames,
      damage: report.damage, lastTarget: report.lastTarget,
      hitsDelta: state.hitsLanded - hitsBefore, playerAlive: state.playerAlive,
    });
  })()`);
  console.log(`${id}: third person ${JSON.stringify(third)}`);
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
