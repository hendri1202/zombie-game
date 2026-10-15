// Animation quality measurement: does the walk/run cycle keep up with movement?
//
// Prints, per zombie kind, the measured motion of each clip (root travel per
// loop, cadence, duration) and the foot-slide factor at the speed the AI
// actually moves the entity: 1.00 means the stride matches the ground speed,
// 0.3 means the feet skate at three times the speed the animation suggests.
import { launchChrome, newPage, open } from './cdp.mjs';

const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const browser = await launchChrome({ width: 640, height: 360 });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0, sensitivity: 1, quality: 'low', shadows: false,
    flashEffects: true, debugOverlay: false })); } catch (e) {}`,
});

await open(page, URL_BASE, { waitMs: 1000 });
await page.evaluate(`(async () => {
  for (let i = 0; i < 900; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 150000 });
console.log('booted\n');

const report = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  const info = g.debugInfo();
  return JSON.stringify(info.clipInventory.map((entry) => ({
    kind: entry.kind,
    mapping: entry.mapping,
    borrowed: entry.borrowed,
    clips: entry.motion
      .filter((m) => /idle|walk|run|punch|death|hit/i.test(m.name))
      .map((m) => ({
        name: m.name.split('|').pop(),
        dur: Number(m.duration.toFixed(2)),
        travel: Number(m.horizontalTravel.toFixed(3)),
        vert: Number(m.verticalRange.toFixed(3)),
        cadence: Number(m.cadence.toFixed(2)),
      })),
  })));
})()`, { timeoutMs: 60000 }));

for (const entry of report) {
  console.log(`== ${entry.kind}  (mapping: ${JSON.stringify(entry.mapping)})`);
  if (entry.borrowed && entry.borrowed.length > 0) {
    for (const borrow of entry.borrowed) {
      console.log(`   borrowed ${borrow.state} <- ${borrow.clipName} from ${borrow.fromKind} ` +
        `(binding ${(borrow.compatibility * 100).toFixed(1)}%)`);
    }
  }
  for (const clip of entry.clips) {
    const animatedSpeed = clip.travel > 0.02 ? clip.travel * clip.cadence : 0;
    console.log(`   ${clip.name.padEnd(14)} dur=${String(clip.dur).padStart(5)}s  ` +
      `rootTravel=${String(clip.travel).padStart(6)}m  vertRange=${String(clip.vert).padStart(5)}m  ` +
      `cadence=${String(clip.cadence).padStart(5)}/s  ` +
      `animatedSpeed=${animatedSpeed > 0 ? animatedSpeed.toFixed(2) + ' m/s' : 'in place'}`);
  }
  console.log('');
}

console.log('--- console (anim binding decisions) ---');
for (const message of page.consoleMessages) {
  if (/anim|borrow|clip/i.test(message.text)) console.log(`[${message.level}] ${message.text.slice(0, 260)}`);
}

browser.close();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
