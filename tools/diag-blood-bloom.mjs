// One-frame F6 proof plus an on/off F9 render-cost sample on the real client.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });
const browser = await launchChrome({ width: 900, height: 506 });
const page = await newPage();
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({ volume: 0, sensitivity: 1, quality: 'medium', shadows: false, flashEffects: true, debugOverlay: false })); } catch (e) {}` });
await open(page, process.env.GAME_URL || 'http://127.0.0.1:4173/', { waitMs: 1000 });
const booted = await page.evaluate(`(async () => { for(let i=0;i<900;i++){ if(window.deadDistrict) return true; await new Promise(r=>setTimeout(r,100)); } return false; })()`, { timeoutMs: 150000 });
// The boot wait returns false when the page never came up - a dead URL, no server on the port, or
// a failed build. Printing 'booted' regardless made a run against nothing report success and then
// fail much later on a null element, which reads as a broken feature rather than a broken setup.
if (!booted) {
  throw new Error('the game never booted - start a server first (PORT=4173 node tools/static-server.mjs &), '
    + 'and check the URL and the build before blaming the harness');
}
console.log('booted');;
await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 30000 });
const drive = async (n) => page.evaluate(`(() => { const g=window.deadDistrict; for(let i=0;i<${n};i++) g.debugTick(1/60,{render:false}); return true; })()`, { timeoutMs: 120000 });
let close = false;
for (let i=0; i<40 && !close; i++) {
  await drive(60);
  close = await page.evaluate(`(() => {const g=window.deadDistrict, p=g.debugInfo().playerPosition; return g.debugInfo().zombiePositions.some(z=>Math.hypot(z[0]-p[0],z[1]-p[1])<9);})()`, { timeoutMs: 30000 });
}
console.log('zombie within 9m:', close);
const shot = JSON.parse(await page.evaluate(`(() => {
 const g=window.deadDistrict;
 const initial=g.debugInfo(), me=initial.playerPosition;
 let nearest=null;
 for(const p of initial.zombiePositions){const d=Math.hypot(p[0]-me[0],p[1]-me[1]);if(!nearest||d<nearest.d)nearest={p,d};}
 // Keep the photograph close enough to judge the blood, while staying outside the model.
 if(nearest&&nearest.d>3){const dx=(me[0]-nearest.p[0])/nearest.d,dz=(me[1]-nearest.p[1])/nearest.d;g.debugTeleport(nearest.p[0]+dx*2.5,nearest.p[1]+dz*2.5);}
 g.debugToggleView();
 g.debugTick(1/60,{render:true});
 const before=g.debugFrameGrid(8);
 let report=null;
 for(let i=0;i<40 && !report;i++) { g.debugAimAtNearestZombie(); report=g.debugFireReport(); if(!report) g.debugTick(1/60,{render:false}); }
 // Let the brief muzzle flash clear while blood is still alive, then keep one frame.
 g.debugTick(0.1,{render:false});
 g.debugTick(1/60,{render:true});
 // Isolate the blood layer without advancing the simulation: same camera, same pose,
 // same frame, first hidden then visible. The grid difference is blood alone.
 const group=g.scene.getObjectByName('blood-effects');
 group.visible=false; g.bloom.render(g.scene,g.camera); const without=g.debugFrameGrid(32);
 group.visible=true; g.bloom.render(g.scene,g.camera); const withBlood=g.debugFrameGrid(32);
 const diff=without.grid.map((v,i)=>Math.abs(v-withBlood.grid[i]));
 const info=g.debugInfo(), sample=group.children.slice(0,3).map(m=>{const p=m.position.clone(),q=p.clone().project(g.camera);return {p:[p.x,p.y,p.z],clip:[q.x,q.y,q.z],visible:m.visible,color:m.material.color.getHexString(),opacity:m.material.opacity,scale:m.scale.x};});
 return JSON.stringify({report, activeBlood:info.activeBlood, bloodChildren:group.children.length, sample, bloodGridDiff:{max:Number(Math.max(...diff).toFixed(2)),changed:diff.filter(x=>x>0).length}, alive:info.playerAlive, phase:info.phase, view:info.viewMode, dataUrl:g.debugCaptureDataUrl()});
})()`, { timeoutMs: 120000 }));
console.log('blood shot:', JSON.stringify({...shot, dataUrl:`${String(shot.dataUrl).length} chars`}));
if (shot.dataUrl?.startsWith('data:image/png;base64,')) writeFileSync(join(SHOTS,'f6-blood-hit.png'),Buffer.from(shot.dataUrl.slice(22),'base64'));
const perf = JSON.parse(await page.evaluate(`(() => {
 const g=window.deadDistrict, out={};
 for(const enabled of [false,true]) {
  g.bloom?.setEnabled(enabled);
  g.bloom?.render(g.scene,g.camera); // warm programs and targets before sampling
  const samples=[]; let draws=0;
  for(let i=0;i<7;i++){const t=performance.now();g.bloom.render(g.scene,g.camera);samples.push(performance.now()-t);draws=g.renderer.info.render.calls;}
  samples.sort((a,b)=>a-b); out[enabled?'bloomOn':'bloomOff']={medianMs:Number(samples[3].toFixed(2)),minMs:Number(samples[0].toFixed(2)),maxMs:Number(samples[6].toFixed(2)),samplesMs:samples.map(x=>Number(x.toFixed(2))),drawCalls:draws};
 }
 return JSON.stringify(out);
})()`, { timeoutMs: 240000 }));
console.log('render-only benchmark (7 warmed frames/mode, browser wall ms):', JSON.stringify(perf));
browser.close();
process.exit(0);
