// Performance measurement.
//
// FPS is meaningless here (software rasteriser), so this measures what does
// transfer to real hardware: the CPU cost of one simulation step with a full
// horde, and the draw-call/triangle load each quality tier asks the GPU for.
import { launchChrome, newPage, open } from './cdp.mjs';

const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 1280, height: 720 };
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
await open(page, URL_BASE, { waitMs: 1000 });
await page.evaluate(`(async () => {
  for (let i = 0; i < 900; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 150000 });
console.log('booted\n');

const drive = async (frames) => {
  let remaining = frames;
  while (remaining > 0) {
    const batch = Math.min(remaining, 200);
    await page.evaluate(`(() => { const g = window.deadDistrict;
      for (let i = 0; i < ${batch}; i += 1) g.debugTick(1/60, { render: false }); return true; })()`, { timeoutMs: 90000 });
    remaining -= batch;
  }
};

await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 20000 });
await sleep(300);

// Sweep the zombie count and time the simulation at each level. This is the
// number the PRD asks to tune from profiling rather than from a guess.
await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugSetActiveCap(48);
  g.testHooks.state.set('playing');
  return true;
})()`, { timeoutMs: 30000 });

const sweep = [];
for (const target of [8, 16, 24, 32, 40, 48]) {
  await page.evaluate(`(() => {
    const g = window.deadDistrict;
    g.debugFillHorde(${target});
    return true;
  })()`, { timeoutMs: 90000 });

  const measured = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const result = g.debugBenchmarkDirector(600);
    return JSON.stringify(result);
  })()`, { timeoutMs: 240000 }));
  sweep.push(measured);
  console.log(`  ${String(measured.zombies).padStart(2)} zombies (${String(measured.engaged).padStart(2)} engaged): ` +
    `${measured.msPerStep.toFixed(2)} ms/step  ` +
    `(${((1000 / 60) / Math.max(measured.msPerStep, 0.001)).toFixed(1)}x the 60 Hz budget)`);
}

const peak = sweep[sweep.length - 1];
console.log(`\npeak measured: ${peak.zombies} zombies at ${peak.msPerStep.toFixed(2)} ms/step ` +
  `(60 Hz budget is 16.67 ms) — ${((1000 / 60) / Math.max(peak.msPerStep, 0.001)).toFixed(1)}x headroom\n`);

const tiers = {};
for (const tier of ['low', 'medium', 'high']) {
  const render = JSON.parse(await page.evaluate(`(async () => {
    const select = document.getElementById('set-quality');
    select.value = '${tier}';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 60));
    const g = window.deadDistrict;
    g.debugTick(1 / 60, { render: false });
    g.debugRenderFrame();
    const info = g.debugInfo();
    document.getElementById('set-quality').value = '${tier}';
    return JSON.stringify({
      tier: '${tier}',
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      geometries: info.geometries,
      textures: info.textures,
      zombies: info.activeZombies,
    });
  })()`, { timeoutMs: 180000 }));
  tiers[tier] = render;
  console.log(`  ${tier.padEnd(7)} draw calls=${String(render.drawCalls).padStart(4)}  ` +
    `triangles=${String(render.triangles).padStart(7)}  geometries=${render.geometries}  textures=${render.textures}`);
}

browser.close();
await sleep(200);
process.exit(0);
