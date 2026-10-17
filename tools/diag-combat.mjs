// Focused combat diagnostic: what does each shot actually hit, and why?
import { launchChrome, newPage, open } from './cdp.mjs';

const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const browser = await launchChrome({ width: 640, height: 360 });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Log.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0, sensitivity: 1, quality: 'low', shadows: false,
    flashEffects: true, debugOverlay: false })); } catch (e) {}`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const drive = async (frames) => {
  let remaining = frames;
  while (remaining > 0) {
    const batch = Math.min(remaining, 300);
    await page.evaluate(`(() => { const g = window.deadDistrict;
      for (let i = 0; i < ${batch}; i += 1) g.debugTick(1/60, { render: false }); return true; })()`, { timeoutMs: 90000 });
    remaining -= batch;
  }
};

await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 20000 });
await sleep(200);

let close = false;
for (let round = 0; round < 30 && !close; round += 1) {
  await drive(120);
  close = await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const me = g.debugInfo().playerPosition;
    return g.debugInfo().zombiePositions.some((p) => Math.hypot(p[0] - me[0], p[1] - me[1]) < 7);
  })()`, { timeoutMs: 30000 });
}
console.log('a zombie is within 7 m:', close);

const result = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  const shots = [];
  for (let shot = 0; shot < 6; shot += 1) {
    const info = g.debugInfo();
    const me = info.playerPosition;
    // Independent geometry: what the aim SHOULD be for the nearest zombie.
    let nearest = null;
    for (const entry of info.hitboxReport) {
      if (!entry.alive) continue;
      const z = info.zombiePositions[info.hitboxReport.indexOf(entry)];
      const d = Math.hypot(z[0] - me[0], z[1] - me[1]);
      if (!nearest || d < nearest.distance) nearest = { distance: d, x: z[0], z: z[1], headY: entry.headY, hitboxes: entry.hitboxes };
    }
    const aimed = g.debugAimAtNearestZombie();
    const afterAim = g.debugInfo();
    const report = g.debugFireReport();
    shots.push({ aimed, nearest, yaw: afterAim.playerYaw, pitch: afterAim.playerPitch, report });
    for (let i = 0; i < 20; i += 1) g.debugTick(1 / 60, { render: false });
  }
  return JSON.stringify({ shots, after: g.debugInfo() });
})()`, { timeoutMs: 120000 }));

for (const [index, shot] of result.shots.entries()) {
  console.log(`shot ${index + 1}:`, JSON.stringify(shot));
}
console.log('hits:', result.after.hitsLanded, 'kills:', result.after.kills, 'health:', result.after.playerHealth);
console.log('hitbox report:', JSON.stringify(result.after.hitboxReport.slice(0, 4)));
console.log('zombie states:', JSON.stringify(result.after.zombieStates.slice(0, 4)));

browser.close();
await sleep(200);
process.exit(0);
