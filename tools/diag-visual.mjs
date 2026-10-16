// Visual verification: capture frames that actually show the characters.
//
// The gameplay smoke test captures whatever the camera happens to face, which is
// often a wall. This drives the run to a known state (zombies closing in) and
// captures the canvas from a fixed vantage so scale, orientation, ground contact
// and texturing can be judged on a real frame.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePng, launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 900, height: 506 };

mkdirSync(SHOTS, { recursive: true });

const browser = await launchChrome({ width: VIEWPORT.width, height: VIEWPORT.height });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0, sensitivity: 1, quality: 'medium', shadows: true,
    flashEffects: true, debugOverlay: true })); } catch (e) {}`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      for (let i = 0; i < ${batch}; i += 1) g.debugTick(1/60, { render: false }); return true; })()`, { timeoutMs: 90000 });
    remaining -= batch;
  }
};

const stats = async () => JSON.parse(await page.evaluate(
  'JSON.stringify(window.deadDistrict.debugFrameStats())', { timeoutMs: 60000 }));

const cam = async () => JSON.parse(await page.evaluate(
  'JSON.stringify(window.deadDistrict.debugCameraState())', { timeoutMs: 30000 }));

const save = async (name, { canvas = true, dom = false } = {}) => {
  const frame = await stats();
  const camera = await cam();
  const audit = JSON.parse(await page.evaluate(
    'JSON.stringify(window.deadDistrict.debugRenderAudit())', { timeoutMs: 60000 }));
  const offscreen = JSON.parse(await page.evaluate(
    'JSON.stringify(window.deadDistrict.debugOffscreenStats())', { timeoutMs: 120000 }));
  console.log(`  [${name}] frame mean=${frame.mean} contrast=${frame.contrast} max=${frame.max} bright=${frame.brightFraction}`);
  console.log(`      camera ${JSON.stringify(camera)}`);
  console.log(`      audit  ${JSON.stringify(audit)}`);
  console.log(`      offscreen ${JSON.stringify(offscreen)}`);
  const probeStats = JSON.parse(await page.evaluate(
    'JSON.stringify(window.deadDistrict.debugOverrideProbe())', { timeoutMs: 120000 }));
  console.log(`      override-probe ${JSON.stringify(probeStats)} (uniform magenta = geometry rasterises)`);
  if (canvas) {
    const dataUrl = await page.evaluate('window.deadDistrict.debugCaptureDataUrl()', { timeoutMs: 60000 });
    const buffer = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
    writeFileSync(join(SHOTS, `${name}.png`), buffer);
    console.log(`  ${name}.png ${buffer.length} bytes md5=${createHash('md5').update(buffer).digest('hex').slice(0, 10)}`);
  }
  if (dom) {
    await capturePng(page, join(SHOTS, `${name}-page.png`), VIEWPORT);
    console.log(`  ${name}-page.png (DOM overlay + canvas)`);
  }
};

// Title screen: the loop is not running under rAF-less headless Chrome, so the
// harness renders explicitly before each capture.
await page.evaluate('window.deadDistrict.debugTick(0.016, { render: true })', { timeoutMs: 60000 });
await save('visual-01-title', { canvas: true, dom: true });

await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 20000 });
await sleep(300);
await drive(60);

// Fixed vantage looking down the main street towards the crossing (yaw 0 = -Z).
await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugTeleport(0, 30);
  g.debugSetLook(0, -0.02);
  return true;
})()`, { timeoutMs: 30000 });
await drive(30);
await save('visual-02-street-wide', { canvas: true, dom: true });

// Side view across the block, to judge props and the perimeter.
await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugTeleport(-14, 0);
  g.debugSetLook(-Math.PI / 2, 0);
  return true;
})()`, { timeoutMs: 30000 });
await drive(30);
await save('visual-03-side-street', { canvas: true });

// Wait for the horde to close in, then frame the nearest zombie exactly.
let framed = false;
for (let round = 0; round < 45; round += 1) {
  await drive(60);
  const distance = await page.evaluate(`(() => {
    const info = window.deadDistrict.debugInfo();
    const me = info.playerPosition;
    let best = Infinity;
    for (const p of info.zombiePositions) best = Math.min(best, Math.hypot(p[0] - me[0], p[1] - me[1]));
    return best;
  })()`, { timeoutMs: 30000 });
  if (round % 6 === 0) console.log(`  closest zombie: ${Number.isFinite(distance) ? distance.toFixed(1) : '—'} m`);
  if (distance < 7) { framed = await page.evaluate('window.deadDistrict.debugAimAtNearestZombie()', { timeoutMs: 30000 }); break; }
}
console.log('  framed a zombie for capture:', framed);
await save('visual-04-zombie-closeup', { canvas: true, dom: true });

// A second angle at very close range: checks ground contact and facing head-on.
await drive(60);
await page.evaluate('window.deadDistrict.debugAimAtNearestZombie()', { timeoutMs: 30000 });
await save('visual-05-zombie-close', { canvas: true, dom: true });

// Prove the impact feedback reaches the framebuffer: diff a coarse luminance
// grid taken with no flare against one taken right after a shot lands. Merely
// having an effect object in the scene graph is not evidence it rendered.
const flare = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugAimAtNearestZombie();
  for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
  const before = g.debugFrameGrid(8);
  let report = null;
  for (let i = 0; i < 40 && !report; i += 1) {
    g.debugAimAtNearestZombie();
    report = g.debugFireReport();
    if (!report) g.debugTick(1 / 60, { render: false });
  }
  g.debugTick(1 / 60, { render: false });
  const after = g.debugFrameGrid(8);
  const diff = before.grid.map((value, index) => Math.abs(value - after.grid[index]));
  const maxCellDiff = Math.max(...diff);
  return JSON.stringify({
    report,
    activeImpacts: g.debugInfo().activeImpacts,
    maxCellDiff: Number(maxCellDiff.toFixed(2)),
    cellsChanged: diff.filter((value) => value > 1).length,
    fps: g.debugInfo().fps,
  });
})()`, { timeoutMs: 120000 }));
console.log('  impact flare proof:', JSON.stringify(flare));
if (flare.maxCellDiff <= 1) {
  console.log('  NOTE: the flare did not change any luminance cell — it is not reaching the framebuffer.');
}

// Muzzle flash and tracer: same grid-diff proof, and this time the frame is captured in
// the same frame as the shot rather than three frames later, because the flash only
// lives 55 ms. The earlier hit-feedback capture happened to be pressed against a zombie
// with the flash already expired, which proved nothing about the flash either way.
const shotEffects = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  // 40x: a capture here costs a frame and a frame can be a second, so the real 55 ms
  // flash and 70 ms tracer would be gone before the screenshot composites. The proof
  // below is still measured at the real lifetime; only the kept frame is stretched.
  g.debugProlongShotEffects(40);
  g.debugAimAtNearestZombie();
  for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
  const before = g.debugFrameGrid(8);
  let report = null;
  for (let i = 0; i < 40 && !report; i += 1) {
    g.debugAimAtNearestZombie();
    report = g.debugFireReport();
    if (!report) g.debugTick(1 / 60, { render: false });
  }
  // One rendered frame, so the canvas the screenshot reads still holds the flash.
  g.debugTick(1 / 60, { render: true });
  const info = g.debugInfo();
  const after = g.debugFrameGrid(8);
  const diff = before.grid.map((value, index) => Math.abs(value - after.grid[index]));
  return JSON.stringify({
    fired: report !== null,
    flash: info.muzzleFlashActive, smoke: info.muzzleSmokeActive, tracers: info.tracersActive,
    maxCellDiff: Number(Math.max(...diff).toFixed(2)),
    cellsChanged: diff.filter((value) => value > 1).length,
  });
})()`, { timeoutMs: 120000 }));
console.log('  shot effect proof (frame stretched 40x for the capture):', JSON.stringify(shotEffects));
if (shotEffects.maxCellDiff <= 1) {
  console.log('  NOTE: the shot changed no luminance cell — check the flash is in front of the camera.');
}
await save('visual-08-muzzle-flash', { canvas: true, dom: true });

// Smoke outlives the flash: step past the flash life but stay inside the smoke's.
// Both are stretched, so this is a handful of frames rather than a fraction of one.
const smokeOnly = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  // Advance without rendering, then present exactly one frame. Rendering every step here
  // means 200 software frames at roughly a second each, which blew the CDP timeout and
  // took the whole visual stage down with it.
  for (let i = 0; i < 200; i += 1) g.debugTick(1 / 60, { render: false });
  g.debugTick(1 / 60, { render: true });
  const info = g.debugInfo();
  return JSON.stringify({ flash: info.muzzleFlashActive, smoke: info.muzzleSmokeActive });
})()`, { timeoutMs: 120000 }));
console.log('  smoke-only frame (flash must be 0 here, smoke alive):', JSON.stringify(smokeOnly));
await save('visual-09-muzzle-smoke', { canvas: true, dom: true });
// Back to real lifetimes for everything that follows.
await page.evaluate('window.deadDistrict.debugProlongShotEffects(1)', { timeoutMs: 30000 });

// First person. The weapon view model floats with no hands: a known gap, captured so
// the frame is on record rather than described.
await page.evaluate('window.deadDistrict.debugToggleView()', { timeoutMs: 30000 });
await drive(30);
await save('visual-07-first-person', { canvas: true, dom: true });
await page.evaluate('window.deadDistrict.debugToggleView()', { timeoutMs: 30000 });
await drive(10);

// Hit feedback: fire and capture 3 frames later, while the impact flare is alive
// (it lives 0.26 s), so the frame shows what a landed shot looks like.
const hit = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  let report = null;
  for (let i = 0; i < 40 && !report; i += 1) {
    g.debugAimAtNearestZombie();
    report = g.debugFireReport();
    if (!report) g.debugTick(1 / 60, { render: false });
  }
  for (let i = 0; i < 3; i += 1) g.debugTick(1 / 60, { render: false });
  return JSON.stringify({ report, activeImpacts: g.debugInfo().activeImpacts });
})()`, { timeoutMs: 90000 }));
console.log('  landed shot:', JSON.stringify(hit));
await save('visual-06-hit-feedback', { canvas: true, dom: true });

const info = JSON.parse(await page.evaluate('JSON.stringify(window.deadDistrict.debugInfo())', { timeoutMs: 30000 }));
console.log('\nstate at capture time:', JSON.stringify({
  wave: info.wave,
  activeZombies: info.activeZombies,
  states: info.zombieStates,
  hitboxes: info.hitboxReport.slice(0, 3),
  drawCalls: info.drawCalls,
  triangles: info.triangles,
  playerHealth: info.playerHealth,
}, null, 2));

browser.close();
await sleep(200);
process.exit(0);
