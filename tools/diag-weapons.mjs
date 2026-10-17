// Every weapon in the roster, photographed in the player's hands, and the shotgun's
// pellets proved in the game rather than only in a unit test.
//
// A weapon whose mesh failed to load still fires: the view model simply is not there, and
// no unit test sees it. So each weapon is equipped in turn, photographed twice (before and
// after a shot), and the run fails loudly if a model is missing, the view model is hidden,
// or the shot produces no flash, no tracer and no impact.
//
// The shotgun then gets its own pass: the horde is filled, the nearest zombie is aimed at,
// and one shell must apply more than a single pellet's damage while spending exactly one
// round of ammunition. That is the difference between eight pellets and eight shots.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePng, launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 900, height: 506 };
/** Effects are stretched for the capture: a screenshot here costs a whole frame. */
const STRETCH = Number(process.env.STRETCH || 60);
const WEAPONS = (process.env.WEAPONS_ONLY || 'pistol,rifle,smg,shotgun').split(',').filter(Boolean);

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
const drive = async (frames, render = false) => {
  let remaining = frames;
  while (remaining > 0) {
    const batch = Math.min(remaining, 120);
    await page.evaluate(`(() => { const g = window.deadDistrict;
      for (let i = 0; i < ${batch}; i += 1) g.debugTick(1 / 60, { render: ${render} });
      return true; })()`, { timeoutMs: 150000 });
    remaining -= batch;
  }
};

await open(page, URL_BASE, { waitMs: 1000 });
const booted = await page.evaluate(`(async () => {
  for (let i = 0; i < 900; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 150000 });
// The wait returns false when the page never booted - a dead URL, a stale server or a failed
// build - and this used to print 'booted' either way, so a run against nothing at all reported
// success and then failed 90 seconds later on a null element. Say what actually happened.
if (!booted) {
  throw new Error(`the game never booted at ${URL_BASE} - a server must already be listening `
    + `(PORT=4173 node tools/static-server.mjs &); check the URL and the build, not the harness`);
}
console.log('booted');

await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 30000 });
await drive(30);
await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugUnlockAllWeapons();
  g.debugToggleView();          // first person: the weapon sits in the camera
  g.debugSetLook(Math.PI, 0);   // straight down the street, before the horde arrives
  g.debugProlongShotEffects(${STRETCH});
  return true;
})()`, { timeoutMs: 60000 });

/** Rounds per tracer, read from the game so the check matches the weapon's configuration. */
const tracerEvery = JSON.parse(await page.evaluate(
  `JSON.stringify(Object.fromEntries(Object.entries(window.deadDistrict.debugWeaponConfig()).map(([id, w]) => [id, w.tracerEvery])))`,
  { timeoutMs: 60000 },
));
console.log('tracer cadence:', JSON.stringify(tracerEvery));

const rows = [];
const failures = [];
/** Pellet runs only: the photographs are already on disk and take a frame each. */
const PELLETS_ONLY = process.env.PELLETS_ONLY === '1';

for (const id of WEAPONS) {
  if (PELLETS_ONLY) break;
  if (process.env.WEAPONS_ONLY && !WEAPONS.includes(id)) continue;
  const setup = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const selected = g.debugSelectWeapon('${id}');
    for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
    g.debugTick(1 / 60, { render: true });
    const info = g.debugInfo();
    return JSON.stringify({
      selected, weapon: info.weapon, magazine: info.magazine, reserve: info.reserve,
      visible: info.weaponViewModelVisible, failures: info.loadingFailures,
      hands: g.debugHandsReport(),
    });
  })()`, { timeoutMs: 120000 }));
  // switchTo returns false when the weapon is already in hand, which is success here.
  if (!setup.selected && setup.weapon !== id) failures.push(`${id}: could not be equipped`);
  if (setup.weapon !== id) failures.push(`${id}: equipping it left ${setup.weapon} in hand`);
  if (!setup.visible) failures.push(`${id}: the view model is not visible in first person`);
  for (const failure of setup.failures) failures.push(`${id}: asset failed to load — ${failure}`);

  await save(`weapon-${id}-held`);

  const fired = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const report = g.debugFireReport();
    g.debugTick(1 / 60, { render: true });
    const info = g.debugInfo();
    return JSON.stringify({
      report, magazine: info.magazine,
      flash: info.muzzleFlashActive, tracers: info.tracersActive,
      casings: info.activeCasings, impacts: info.activeImpacts,
    });
  })()`, { timeoutMs: 120000 }));
  await save(`weapon-${id}-fired`);

  const spent = setup.magazine - fired.magazine;
  if (!fired.report) failures.push(`${id}: the trigger produced no shot`);
  if (spent !== 1) failures.push(`${id}: one trigger pull spent ${spent} rounds`);
  if (fired.flash === 0) failures.push(`${id}: the shot produced no muzzle flash`);
  // A tracer is drawn every Nth round, so a weapon configured that way shows none on its
  // first shot: requiring one here asserted the tool's assumption, not the game's behaviour.
  if (tracerEvery[id] === 1 && fired.tracers === 0) failures.push(`${id}: the shot produced no tracer`);
  rows.push({ id, magazine: setup.magazine, spent, report: fired.report, flash: fired.flash, tracers: fired.tracers, casings: fired.casings });
  console.log(`${id}: ${JSON.stringify(rows[rows.length - 1])}`);
}

// The shotgun's pellets, in the game: one shell, more than one pellet's damage.
const pellets = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugSelectWeapon('shotgun');
  const spawned = g.debugFillHorde(4);
  for (let i = 0; i < 90; i += 1) g.debugTick(1 / 60, { render: false });

  // Close the distance first. Down the street the targets sit about 46 m away, which is
  // past the shotgun's 40 m range, so every pellet fell short and the run reported zero
  // damage for the weapon rather than for the measurement.
  const positions = g.debugInfo().zombiePositions || [];
  const player = g.debugInfo().playerPosition;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const position of positions) {
    const dx = position[0] - player[0];
    const dz = position[1] - player[1];
    const distance = Math.hypot(dx, dz);
    if (distance < nearestDistance) { nearestDistance = distance; nearest = position; }
  }
  let teleported = false;
  if (nearest) {
    g.debugTeleport(nearest[0], nearest[1] + 7);
    teleported = true;
    for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
  }

  let damage = 0;
  let magazineBefore = 0;
  let magazineAfter = 0;
  let zone = '';
  let target = '';
  let attempts = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    attempts = attempt + 1;
    g.debugAimAtNearestZombie();
    for (let i = 0; i < 10; i += 1) g.debugTick(1 / 60, { render: false });
    const before = g.debugInfo();
    const report = g.debugFireReport();
    const after = g.debugInfo();
    if (report && report.target === 'zombie') {
      damage = report.damage; zone = report.zone; target = report.target;
      magazineBefore = before.magazine; magazineAfter = after.magazine;
      break;
    }
    if (report) target = report.target;
  }
  return JSON.stringify({
    spawned, teleported, nearestDistance: Number(nearestDistance.toFixed(1)),
    damage, zone, target, attempts, magazineBefore, magazineAfter,
  });
})()`, { timeoutMs: 240000 }));
console.log('shotgun pellets:', JSON.stringify(pellets));
if (pellets.damage <= 12) {
  failures.push(`shotgun: one shell applied ${pellets.damage} damage, which is not more than a single pellet`);
}
if (pellets.magazineBefore - pellets.magazineAfter !== 1) {
  failures.push(`shotgun: one shell spent ${pellets.magazineBefore - pellets.magazineAfter} rounds`);
}

console.log('\nweapon report:');
for (const row of rows) console.log(`  ${row.id}: ${JSON.stringify(row)}`);
console.log('screenshots:', SHOTS);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
}
console.log(failures.length === 0 ? '\nWEAPONS_OK' : '\nWEAPONS_FAILED');
browser.close();
await sleep(200);
process.exit(failures.length === 0 ? 0 : 1);
