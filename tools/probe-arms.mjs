// Per-arm measurement for every weapon.
//
// Written because the shotgun's support hand is not visible and "off screen" and "behind
// the weapon" need opposite fixes. Prints, per weapon, each arm's normalised device
// coordinates — (-1..1) is on screen — and whatever the camera ray hits first that is not
// the arm itself.
import { launchChrome, newPage, open } from './cdp.mjs';

const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const browser = await launchChrome({ width: 900, height: 506 });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0, sensitivity: 1, quality: 'low', shadows: false,
    flashEffects: false, debugOverlay: false })); } catch (e) {}`,
});
await open(page, URL_BASE, { waitMs: 1000 });
await page.evaluate(`(async () => {
  for (let i = 0; i < 900; i += 1) {
    if (window.deadDistrict) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
})()`, { timeoutMs: 150000 });

await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 30000 });
const report = await page.evaluate(`(() => {
  const g = window.deadDistrict;
  g.debugUnlockAllWeapons();
  g.debugToggleView();          // first person
  g.debugSetLook(Math.PI, 0);
  for (let i = 0; i < 20; i += 1) g.debugTick(1 / 60, { render: false });
  const rows = [];
  for (const id of ['pistol', 'rifle', 'smg', 'shotgun']) {
    g.debugSelectWeapon(id);
    g.debugTick(1 / 60, { render: false });
    const hands = g.debugHandsReport();
    rows.push({ id, parts: hands.parts, visible: hands.visible, arms: hands.arms });
  }
  return JSON.stringify(rows);
})()`, { timeoutMs: 120000 });

for (const row of JSON.parse(report)) {
  console.log(`\n${row.id}: parts=${row.parts} viewModelVisible=${row.visible}`);
  for (const arm of row.arms) {
    const [minX, minY, maxX, maxY] = arm.handBox;
    const onScreen = maxX >= -1 && minX <= 1 && maxY >= -1 && minY <= 1;
    console.log(`   ${arm.name.padEnd(11)} hold=[${arm.handScreen}]`
      + ` handBox x[${minX}, ${maxX}] y[${minY}, ${maxY}]`
      + ` ${onScreen ? 'HAND ON SCREEN' : 'HAND OFF SCREEN'}`
      + `${arm.occludedBy ? ` OCCLUDED BY ${arm.occludedBy}` : ' clear'}`);
  }
}
browser.close();
process.exit(0);
