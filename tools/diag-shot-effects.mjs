// Muzzle flash and tracer, photographed on purpose.
//
// The gameplay harness aims at whatever zombie is nearest, which can be under the
// player's feet, and a frame full of tarmac says nothing about the flash it was meant to
// show. This drives a clean setup instead: first person, view pointed straight down the
// street before the horde arrives, so the only thing in the frame is the weapon and what
// the weapon does.
//
// Two frames are kept: one fired and one not, from the same camera. Their luminance
// grids are diffed, because "the effect object exists" and "the effect rendered" are
// different claims.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePng, launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 900, height: 506 };
/** How long effects are stretched for the capture. A screenshot costs a frame here. */
const STRETCH = Number(process.env.STRETCH || 60);

mkdirSync(SHOTS, { recursive: true });

const browser = await launchChrome({ width: VIEWPORT.width, height: VIEWPORT.height });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0, sensitivity: 1, quality: 'medium', shadows: true,
    flashEffects: true, debugOverlay: false })); } catch (e) {}`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * One screenshot per frame, into one file.
 *
 * `capturePng(page, file, opts)` takes a path, and the compositor needs a generous
 * timeout here: with shadows on a software rasteriser can take tens of seconds to hand
 * over a frame, and the 30 s default was not enough. The screenshot is of the whole
 * page, so the HUD and the canvas both come along.
 */
const save = async (name, timeoutMs = 180000) => {
  const file = await capturePng(page, join(SHOTS, `${name}.png`), { timeoutMs });
  console.log(`  saved ${file}`);
  return file;
};

await open(page, URL_BASE, { waitMs: 1000 });
await page.evaluate(`(async () => {
  for (let i = 0; i < 900; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 150000 });
console.log('booted');

const drive = async (frames) => {
  let remaining = frames;
  while (remaining > 0) {
    const batch = Math.min(remaining, 200);
    await page.evaluate(`(() => { const g = window.deadDistrict;
      for (let i = 0; i < ${batch}; i += 1) g.debugTick(1 / 60, { render: false });
      return true; })()`, { timeoutMs: 120000 });
    remaining -= batch;
  }
};

// Start the run and shoot before the horde closes in: a clean street, no zombie in the
// lens, and a full magazine.
await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 30000 });
await drive(30);
const session = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugToggleView();           // first person: the weapon sits right in the camera
  g.debugSetLook(Math.PI, 0);    // straight down the street
  g.debugProlongShotEffects(${STRETCH});
  for (let i = 0; i < 20; i += 1) g.debugTick(1 / 60, { render: true });
  return JSON.stringify({ info: g.debugInfo(), camera: g.debugCameraState() });
})()`, { timeoutMs: 60000 }));
console.log('setup:', JSON.stringify({
  view: session.info.viewMode, weapon: session.info.weapon,
  magazine: session.info.magazine, alive: session.info.playerAlive,
}));

// Control frame: same camera, no shot.
await drive(4);
await save('shot-01-before');

// Fired frame, measured and kept.
const fired = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  const before = g.debugFrameGrid(8);
  const report = g.debugFireReport();
  g.debugTick(1 / 60, { render: true });
  const info = g.debugInfo();
  const after = g.debugFrameGrid(8);
  const diff = before.grid.map((value, index) => Math.abs(value - after.grid[index]));
  return JSON.stringify({
    report, flash: info.muzzleFlashActive, smoke: info.muzzleSmokeActive,
    tracers: info.tracersActive,
    maxCellDiff: Number(Math.max(...diff).toFixed(2)),
    cellsChanged: diff.filter((value) => value > 1).length,
  });
})()`, { timeoutMs: 60000 }));
console.log('fired:', JSON.stringify(fired));
await save('shot-02-muzzle-flash');

console.log('screenshots:', SHOTS);
browser.close();
await sleep(200);
process.exit(0);
