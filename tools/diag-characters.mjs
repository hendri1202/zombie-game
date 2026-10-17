// Survivor selection check: loads each of the four characters, audits what the
// avatar is made of (meshes, textures, shadows, anisotropy) and captures a frame
// of the title-screen showcase so the result can be looked at, not assumed.
import { capturePng, launchChrome, newPage, open } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
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
console.log('opening', URL_BASE);
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

// Let the showcase settle: it orbits, so the character has to be given a few frames.
/**
 * Advances the showcase and reports frame statistics.
 *
 * Statistics are the only thing that can tell a frame containing the character
 * apart from a flat surface, so every capture step is preceded by real numbers.
 */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate("(() => { window.deadDistrict.debugTick(1/12, { render: false }); return true; })()", { timeoutMs: 60000 });
  }
  return JSON.parse(await page.evaluate(
    'JSON.stringify(window.deadDistrict.debugFrameStats())', { timeoutMs: 60000 }));
};

/**
 * Canvas readback (no DOM) plus the real page, which is what the player sees.
 *
 * The page capture goes through the compositor, which is the slow path under
 * software rendering, so it is given a much longer budget than the default.
 */
const framing = async () => JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  const box = g.debugProjectAvatar();
  if (!box) return 'null';
  const [w, h] = box.viewport;
  const px = {
    x0: Math.max(0, (box.centreX - box.widthFraction / 2) * w),
    y0: Math.max(0, (box.centreY - box.heightFraction / 2) * h),
    x1: Math.min(w, (box.centreX + box.widthFraction / 2) * w),
    y1: Math.min(h, (box.centreY + box.heightFraction / 2) * h),
  };
  const region = g.debugRegionStats(px.x0, px.y0, px.x1, px.y1);
  return JSON.stringify({ box, region, px });
})()`, { timeoutMs: 120000 }));

const capture = async (name) => {
  const frame = await framing();
  if (frame && frame !== 'null') {
    console.log(`  framing ${name}: centreX=${frame.box.centreX} centreY=${frame.box.centreY} ` +
      `w=${frame.box.widthFraction} h=${frame.box.heightFraction} viewport=${frame.box.viewport}`);
    console.log(`  subject luminance: mean=${frame.region.mean} contrast=${frame.region.contrast} max=${frame.region.max}`);
  }
  // Canvas readback (no DOM) and the real page, which is what the player sees.
  const dataUrl = await page.evaluate('window.deadDistrict.debugCaptureDataUrl()', { timeoutMs: 120000 });
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
    writeFileSync(`${SHOTS}${name}.png`, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
  }
  await capturePng(page, `${SHOTS}${name}-page.png`, { ...VIEWPORT, timeoutMs: 240000 });
  return true;
};

const bootFrame = await settle();
console.log('title frame stats:', JSON.stringify(bootFrame));
const boot = JSON.parse(await page.evaluate(
  `JSON.stringify({ info: window.deadDistrict.debugInfo(), audit: window.deadDistrict.debugAvatarAudit() })`,
  { timeoutMs: 60000 }));
console.log('\nboot survivor:', boot.info.characterName, boot.info.characterFile,
  '| view:', boot.info.viewMode, '| avatar visible:', boot.info.avatarVisible,
  '| showcase:', boot.info.showcaseActive);
console.log('clips:', JSON.stringify(boot.info.avatarClips));
console.log('audit:', JSON.stringify(boot.audit));
console.log('avatar at:', JSON.stringify(boot.info.avatarPosition));
console.log(`hand bone at: ${JSON.stringify(boot.audit.handPosition)}  (avatar at ${JSON.stringify(boot.info.avatarPosition)})`);
console.log('avatar meshes (name, world size, verts, shown, world pos):');
for (const mesh of boot.audit.meshNames) {
  console.log(`  ${mesh.name.padEnd(16)} ${String(mesh.size.map((v) => v.toFixed(2)).join(' x ')).padEnd(19)} ` +
    `${String(mesh.vertices).padStart(6)}v ${mesh.visible ? 'SHOWN ' : 'hidden'} at ${JSON.stringify(mesh.position)}`);
}
console.log(`hidden bundled meshes (${boot.audit.hiddenMeshes.length}): ${boot.audit.hiddenMeshes.join(', ')}`);
console.log(`bones (${boot.audit.boneNames.length}): ${boot.audit.boneNames.join(', ')}`);
console.log('captured title:', await capture('character-00-lis-title'));

// TITLE_ONLY=1 skips the roster sweep, for iterating on the showcase composition.
const titleOnly = process.env.TITLE_ONLY === '1';
// CHARACTERS_ONLY=jack iterates a single character, which is what makes iterating on
// one silhouette affordable: every entry costs a multi-megabyte model load.
const only = process.env.CHARACTERS_ONLY;
const roster = titleOnly ? [] : (only ? only.split(',').map((id) => id.trim()) : ['lis', 'matt', 'sam', 'shaun', 'jack']);

const results = [];
for (const id of roster) {
  const ok = await page.evaluate(`window.deadDistrict.debugSelectCharacter('${id}')`, { timeoutMs: 180000 });
  await settle();
  const state = JSON.parse(await page.evaluate(
    `JSON.stringify({ info: window.deadDistrict.debugInfo(), audit: window.deadDistrict.debugAvatarAudit() })`,
    { timeoutMs: 60000 }));
  const shot = await capture(`character-${id}`);
  results.push({ id, loaded: ok, shot, state });
  console.log(`\n${id}: loaded=${ok} name=${state.info.characterName} file=${state.info.characterFile}`);
  console.log(`  clips: ${JSON.stringify(state.info.avatarClips)}`);
  console.log(`  health=${state.info.characterMaxHealth} visible=${state.info.avatarVisible}`);
  console.log(`  audit: meshes=${state.audit.meshes} skinned=${state.audit.skinnedMeshes} ` +
    `shadowCasters=${state.audit.shadowCasters} texturedMats=${state.audit.texturedMaterials}/${state.audit.materials} ` +
    `aniso=${state.audit.anisotropy} worldHeight=${state.audit.worldHeight}`);
  console.log(`  clip durations: ${JSON.stringify(state.audit.clipDurations)}`);
  console.log(`  gear attached: ${JSON.stringify(state.info.gearAttached)}`);
  if (state.info.gearSkipped.length > 0) console.log(`  gear SKIPPED: ${JSON.stringify(state.info.gearSkipped)}`);
  if (state.info.gearAttached.length > 0) {
    console.log(`  gear boxes: ${await page.evaluate(
      'JSON.stringify(window.deadDistrict.debugGearBoxes())', { timeoutMs: 30000 })}`);
    console.log(`  gear axes: ${await page.evaluate(
      'JSON.stringify(window.deadDistrict.debugGearAxes())', { timeoutMs: 30000 })}`);
  }
}

if (titleOnly) {
  browser.close();
  await sleep(200);
  process.exit(0);
}

// Walking: the character must cycle clips as the player moves.
await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 30000 });
await sleep(300);
const walk = JSON.parse(await page.evaluate(`(async () => {
  const g = window.deadDistrict;
  const before = g.debugInfo();
  const samples = [];
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  for (let i = 0; i < 90; i += 1) {
    g.debugTick(1 / 60, { render: false });
    if (i % 30 === 0) samples.push({ state: g.debugInfo().avatarState, pos: g.debugInfo().avatarPosition });
  }
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  for (let i = 0; i < 60; i += 1) g.debugTick(1 / 60, { render: false });
  const after = g.debugInfo();
  return JSON.stringify({
    viewMode: after.viewMode,
    avatarVisible: after.avatarVisible,
    weaponVisible: after.weaponViewModelVisible,
    showcase: after.showcaseActive,
    samples,
    stopped: after.avatarState,
    avatarPos: after.avatarPosition,
    playerPos: after.playerPosition,
  });
})()`, { timeoutMs: 120000 }));
console.log('\nwalking:', JSON.stringify(walk));
console.log('captured gameplay:', await capture('character-07-third-person-playing'));

// First person: the avatar hides and the view model returns.
const fp = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  const mode = g.debugToggleView();
  g.debugTick(1 / 60, { render: false });
  const info = g.debugInfo();
  return JSON.stringify({ mode, avatarVisible: info.avatarVisible, weaponVisible: info.weaponViewModelVisible,
    viewMode: info.viewMode });
})()`, { timeoutMs: 60000 }));
console.log('\nfirst person:', JSON.stringify(fp));
console.log('captured first person:', await capture('character-08-first-person'));

browser.close();
await sleep(200);
process.exit(0);
