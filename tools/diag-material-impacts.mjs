// Capture one real frame with four material-specific impact profiles.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, newPage, open } from './cdp.mjs';
const HERE=dirname(fileURLToPath(import.meta.url)), SHOTS=join(HERE,'shots');
mkdirSync(SHOTS,{recursive:true});
const browser=await launchChrome({width:900,height:506});
try{
 const page=await newPage(); await page.send('Page.enable'); await page.send('Runtime.enable');
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`try{localStorage.setItem('dead-district:settings:v1',JSON.stringify({volume:0,sensitivity:1,quality:'low',shadows:false,flashEffects:true,debugOverlay:false}));}catch(e){}`});
 await open(page,process.env.GAME_URL||'http://127.0.0.1:4173/',{waitMs:1000});
 await page.evaluate(`(async()=>{for(let i=0;i<900;i++){if(window.deadDistrict)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`,{timeoutMs:150000});
 await page.evaluate("document.getElementById('btn-start').click()",{timeoutMs:30000});
 const result=JSON.parse(await page.evaluate(`(()=>{
  const g=window.deadDistrict;g.debugToggleView();
  const camera=g.camera, direction=camera.getWorldDirection(new (g.camera.position.constructor)()), right=new (g.camera.position.constructor)(1,0,0).applyQuaternion(camera.quaternion);
  const origin=camera.position.clone().addScaledVector(direction,4), offsets=[-0.9,-0.3,0.3,0.9];
  const tags=['prop:vehicle','building','prop:wooden_crate','prop:window'];
  const names=['metal','concrete','wood','glass'];
  for(let i=0;i<tags.length;i++){
   const p=origin.clone().addScaledVector(right,offsets[i]);
   g.impacts.spawn(p.x,p.y,p.z,0,tags[i]);
  }
  g.impacts.update(0.001,camera.position);
  const group=g.scene.getObjectByName('impact-effects');
  group.visible=false;g.renderer.render(g.scene,camera);const without=g.debugFrameGrid(32);
  group.visible=true;g.renderer.render(g.scene,camera);const withImpacts=g.debugFrameGrid(32);
  const diff=without.grid.map((v,i)=>Math.abs(v-withImpacts.grid[i]));
  const dataUrl=g.debugCaptureDataUrl();
  return JSON.stringify({names,active:group.children.filter(x=>x.visible).length,gridDiff:{max:Number(Math.max(...diff).toFixed(2)),changed:diff.filter(x=>x>0).length},drawCalls:g.renderer.info.render.calls,dataUrl});
 })()`,{timeoutMs:180000}));
 console.log('four material impacts:',JSON.stringify({...result,dataUrl:`${result.dataUrl.length} chars`}));
 if(result.dataUrl?.startsWith('data:image/png;base64,'))writeFileSync(join(SHOTS,'f5-material-impacts.png'),Buffer.from(result.dataUrl.slice(22),'base64'));
 if(!result.gridDiff.changed)throw new Error('Material effects did not change the captured frame');
}finally{browser.close();}
