// The trade post, proved with real points: open it, buy a weapon, watch the balance fall
// by exactly its price, and check the bought weapon actually reaches the player's hands.
//
// A store is easy to get plausibly wrong in ways no unit test sees. The purchase can
// succeed and not deduct, the same item can be charged for twice, a melee weapon can be
// sold without ever being drawn, and none of that shows up until someone plays. So the
// profile is seeded with a known balance before boot, each purchase is driven through the
// same debug hook the buy button uses, and the resulting balance and loadout are read back
// from the game. The run fails loudly (exit 1) on any mismatch, printing the numbers.
//
// Prices come from `src/economy/storeItems.ts`: bat 250, spear 300, axe 350, rifle 700.
// The seeded balance of 1000 buys the first three and is exactly 100 short of the rifle, so
// one run covers bought / already-owned / can't-afford / unknown-item.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePng, launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 900, height: 506 };
/** Seeded balance: enough for bat+spear+axe, deliberately short of the rifle's 700. */
const START_POINTS = Number(process.env.START_POINTS || 1000);

mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await launchChrome({ width: VIEWPORT.width, height: VIEWPORT.height });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    localStorage.setItem('dead-district:settings:v1', JSON.stringify({
      volume: 0, sensitivity: 1, quality: 'medium', shadows: true,
      flashEffects: true, debugOverlay: false }));
    localStorage.setItem('dead-district:profile:v1', JSON.stringify({
      version: 1, points: ${START_POINTS}, earnedTotal: ${START_POINTS},
      ownedFirearms: ['pistol'], ownedMelee: ['knife'],
      stats: { runs: 0, kills: 0, bestWave: 0 } }));
  } catch (e) {}`,
});

const save = async (name, timeoutMs = 180000) => {
  const file = await capturePng(page, join(SHOTS, `${name}.png`), { timeoutMs });
  console.log(`  saved ${file}`);
  return file;
};

const ev = async (expression, timeoutMs = 120000) => JSON.parse(
  await page.evaluate(expression, { timeoutMs }),
);

await open(page, URL_BASE, { waitMs: 1000 });
const booted = await page.evaluate(`(async () => {
  for (let i = 0; i < 900; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 150000 });
// The boot wait returns false when the page never came up - a dead URL, no server on the port, or
// a failed build. Printing 'booted' regardless made a run against nothing report success and then
// fail much later on a null element, which reads as a broken feature rather than a broken setup.
if (!booted) {
  throw new Error('the game never booted - start a server first (PORT=4173 node tools/static-server.mjs &), '
    + 'and check the URL and the build before blaming the harness');
}
console.log('booted');;

await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 30000 });
await page.evaluate(`(() => {
  const g = window.deadDistrict;
  for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
  return true;
})()`, { timeoutMs: 60000 });

const failures = [];

// The store lives on the pause phase (or a wave break); pausing is the cheapest way to
// reach it without waiting out a wave.
const opened = await ev(`(() => {
  const g = window.deadDistrict;
  if (!g.debugInfo().playerAlive) document.getElementById('btn-restart-pause').click();
  g.testHooks.state.set('paused');
  for (let i = 0; i < 5; i += 1) g.debugTick(1 / 60, { render: false });
  const openNow = g.debugToggleStore();
  const report = g.debugStoreReport();
  return JSON.stringify({ openNow, report });
})()`);
console.log('store open:', JSON.stringify(opened));
if (opened.openNow !== true) failures.push(`store did not open while paused (debugToggleStore returned ${opened.openNow})`);
if (opened.report.points !== START_POINTS) {
  failures.push(`the seeded balance did not reach the store (points=${opened.report.points}, expected ${START_POINTS})`);
}

await page.evaluate('window.deadDistrict.debugTick(1 / 60, { render: true })', { timeoutMs: 120000 });
await save('store-open');

// Buy the barbed bat: the cheapest item, and a melee, so it proves the purchase path also
// arms the player rather than only moving a number.
const bought = await ev(`(() => {
  const g = window.deadDistrict;
  const purchase = g.debugPurchase('barbed-bat');
  for (let i = 0; i < 20; i += 1) g.debugTick(1 / 60, { render: false });
  return JSON.stringify({
    purchase,
    points: g.debugPoints(),
    report: g.debugStoreReport(),
    meleeEquipped: g.debugMeleeReport().equipped,
  });
})()`);
await page.evaluate('window.deadDistrict.debugTick(1 / 60, { render: true })', { timeoutMs: 120000 });
await save('store-barbed-bat');
console.log('buy barbed-bat:', JSON.stringify(bought));

if (bought.purchase.ok !== true || bought.purchase.reason !== 'ok') {
  failures.push(`buying the barbed bat was refused (${JSON.stringify(bought.purchase)})`);
}
if (bought.points !== START_POINTS - 250) {
  failures.push(`barbed bat (250) left ${bought.points} points, expected ${START_POINTS - 250}`);
}
if (!bought.report.owned.includes('barbed-bat')) {
  failures.push(`the barbed bat is not owned after buying it (owned=${bought.report.owned.join(',')})`);
}
if (bought.meleeEquipped !== 'barbed-bat') {
  failures.push(`the bought barbed bat was not drawn (equipped=${bought.meleeEquipped})`);
}

// The rest of the ladder in one pass: owned re-buy, two more affordable buys, one too
// expensive, and an id the store does not sell.
const ladder = await ev(`(() => {
  const g = window.deadDistrict;
  const step = (id) => g.debugPurchase(id);
  const again = step('barbed-bat');
  const spear = step('spear');
  const axe = step('axe');
  const rifle = step('rifle');
  const unknown = step('wand');
  return JSON.stringify({
    again, spear, axe, rifle, unknown,
    points: g.debugPoints(),
    report: g.debugStoreReport(),
    meleeEquipped: g.debugMeleeReport().equipped,
  });
})()`);
console.log('purchase ladder:', JSON.stringify(ladder));

if (again.ok !== false || again.reason !== 'owned') {
  failures.push(`re-buying the barbed bat was not refused as owned (${JSON.stringify(again)})`);
}
if (again.points !== START_POINTS - 250) {
  failures.push(`the refused re-buy changed the balance to ${again.points}`);
}
if (spear.ok !== true || spear.points !== START_POINTS - 550) {
  failures.push(`buying the spear (300) left ${spear.points} points, expected ${START_POINTS - 550}`);
}
if (axe.ok !== true || axe.points !== START_POINTS - 900) {
  failures.push(`buying the axe (350) left ${axe.points} points, expected ${START_POINTS - 900}`);
}
if (rifle.ok !== false || rifle.reason !== 'poor') {
  failures.push(`the rifle (700) was not refused for lack of points with ${rifle.points} in hand (${JSON.stringify(rifle)})`);
}
if (rifle.points !== START_POINTS - 900) {
  failures.push(`the refused rifle purchase changed the balance to ${rifle.points}`);
}
if (unknown.ok !== false || unknown.reason !== 'unknown') {
  failures.push(`an unknown item id was not refused as unknown (${JSON.stringify(unknown)})`);
}
if (ladder.points !== START_POINTS - 900) {
  failures.push(`final balance is ${ladder.points}, expected ${START_POINTS - 900}`);
}
if (!ladder.report.owned.includes('axe') || !ladder.report.owned.includes('spear')) {
  failures.push(`owned list is missing a bought weapon (owned=${ladder.report.owned.join(',')})`);
}
if (ladder.meleeEquipped !== 'axe') {
  failures.push(`the last-bought melee (axe) is not drawn (equipped=${ladder.meleeEquipped})`);
}

// Close it again: the store must come off the screen.
const closed = await ev(`(() => {
  const g = window.deadDistrict;
  const openNow = g.debugToggleStore();
  return JSON.stringify({ openNow, report: g.debugStoreReport() });
})()`);
console.log('store close:', JSON.stringify(closed));
if (closed.openNow !== false || closed.report.open !== false) {
  failures.push(`the store did not close (openNow=${closed.openNow}, report.open=${closed.report.open})`);
}

console.log('\nstore report:', JSON.stringify({
  startPoints: START_POINTS,
  finalPoints: ladder.points,
  owned: ladder.report.owned,
  purchasable: ladder.report.purchasable,
}));
console.log('screenshots:', SHOTS);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
}
console.log(failures.length === 0 ? '\nSTORE_OK' : '\nSTORE_FAILED');
browser.close();
await sleep(200);
process.exit(failures.length === 0 ? 0 : 1);
