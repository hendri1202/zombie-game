// Isolation A/B: which object is actually in the title-screen frame?
//
// Three passes — everything, avatar hidden, weapon view model hidden — so a mesh
// that appears in the shot can be attributed to a known owner instead of being
// guessed at from a description.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 1280, height: 800 };
mkdirSync(SHOTS, { recursive: true });

const browser = await launchChrome({ width: VIEWPORT.width, height: VIEWPORT.height });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0, sensitivity: 1, quality: 'high', shadows: true,
    flashEffects: true, debugOverlay: true, characterId: 'lis', viewMode: 'third' })); } catch (e) {}`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await open(page, URL_BASE, { waitMs: 1000 });
const booted = await page.evaluate(`(async () => {
  for (let i = 0; i < 1800; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 220000 });
// The boot wait returns false when the page never came up - a dead URL, no server on the port, or
// a failed build. Printing 'booted' regardless made a run against nothing report success and then
// fail much later on a null element, which reads as a broken feature rather than a broken setup.
if (!booted) {
  throw new Error('the game never booted - start a server first (PORT=4173 node tools/static-server.mjs &), '
    + 'and check the URL and the build before blaming the harness');
}
console.log('booted');;

for (let i = 0; i < 8; i += 1) {
  await page.evaluate("(() => { window.deadDistrict.debugTick(1/12, { render: false }); return true; })()", { timeoutMs: 60000 });
}

const sample = async (label, mutate) => {
  // No tick between the mutation and the read: the title showcase re-shows the
  // avatar on every update, so ticking here would silently undo the isolation and
  // every pass would look identical.
  const state = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    ${mutate}
    const box = g.debugProjectAvatar();
    const info = g.debugInfo();
    const region = box
      ? g.debugRegionStats(
          Math.max(0, (box.centreX - box.widthFraction / 2) * box.viewport[0]),
          Math.max(0, (box.centreY - box.heightFraction / 2) * box.viewport[1]),
          Math.min(box.viewport[0], (box.centreX + box.widthFraction / 2) * box.viewport[0]),
          Math.min(box.viewport[1], (box.centreY + box.heightFraction / 2) * box.viewport[1]),
        )
      : null;
    return JSON.stringify({
      avatarVisible: info.avatarVisible,
      weaponModelVisible: info.weaponViewModelVisible,
      box,
      region,
    });
  })()`, { timeoutMs: 120000 }));
  const dataUrl = await page.evaluate('window.deadDistrict.debugCaptureDataUrl()', { timeoutMs: 120000 });
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
    writeFileSync(join(SHOTS, `isolate-${label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  const hash = createHash('md5').update(String(dataUrl)).digest('hex').slice(0, 10);
  console.log(`\n${label}: avatarVisible=${state.avatarVisible} weaponVisible=${state.weaponModelVisible} ` +
    `frame md5=${hash}`);
  console.log(`  avatar box: centre=(${state.box.centreX},${state.box.centreY}) size=${state.box.widthFraction}x${state.box.heightFraction}`);
  console.log(`  region luminance: mean=${state.region.mean} contrast=${state.region.contrast} max=${state.region.max}`);
  return state;
};

// 1. As the menus left it.
await sample('a-everything', '');

// 2. Avatar hidden: anything still crossing the frame is not the character.
await sample('b-no-avatar', 'g.debugSetAvatarVisible(false);');
await sample('c-avatar-only', 'g.debugSetAvatarVisible(true); g.debugSetWeaponModelVisible(false);');
await sample('d-neither', 'g.debugSetAvatarVisible(false); g.debugSetWeaponModelVisible(false);');

browser.close();
await sleep(200);
process.exit(0);
