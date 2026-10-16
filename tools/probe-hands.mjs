// Where did the first-person hands go?
//
// Prints the hands' mesh count, visibility and view-model position, plus the weapon's
// own placement, so "no hands in the frame" can be told apart from "hands behind the
// camera", "hands unbuilt" or "hands too small to see".
import { launchChrome, newPage, open } from './cdp.mjs';

const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const browser = await launchChrome({ width: 640, height: 360 });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await open(page, URL_BASE, { waitMs: 800 });
await page.evaluate(`(async () => {
  for (let i = 0; i < 600; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 120000 });

const report = JSON.parse(await page.evaluate(`(() => {
  const g = window.deadDistrict;
  document.getElementById('btn-start').click();
  for (let i = 0; i < 40; i += 1) g.debugTick(1 / 60, { render: false });
  const hands = g.debugHandsReport();
  const info = g.debugInfo();
  return JSON.stringify({
    hands, view: info.viewMode, weapon: info.weapon,
    viewModelVisible: info.weaponViewModelVisible,
    character: info.characterName, phase: info.phase,
  });
})()`, { timeoutMs: 120000 }));
console.log('probe:', JSON.stringify(report, null, 2));
browser.close();
process.exit(0);
