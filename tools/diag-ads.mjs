// Capture one ADS frame from the real production client.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, newPage, open } from './cdp.mjs';
const HERE=dirname(fileURLToPath(import.meta.url));
mkdirSync(join(HERE,'shots'),{recursive:true});
const browser=await launchChrome({width:900,height:506});
try {
 const page=await newPage();
 await page.send('Page.enable'); await page.send('Runtime.enable');
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`try{localStorage.setItem('dead-district:settings:v1',JSON.stringify({volume:0,sensitivity:1,quality:'low',shadows:false,flashEffects:true,debugOverlay:false}));}catch(e){}`});
 await open(page,process.env.GAME_URL||'http://127.0.0.1:4173/',{waitMs:1000});
 await page.evaluate(`(async()=>{for(let i=0;i<900;i++){if(window.deadDistrict)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`,{timeoutMs:150000});
 await page.evaluate("document.getElementById('btn-start').click()",{timeoutMs:30000});
 const result=JSON.parse(await page.evaluate(`(()=>{const g=window.deadDistrict;g.debugToggleView();g.input.adsHeld=true;for(let i=0;i<45;i++)g.debugTick(1/60,{render:false});const ads=g.weapons.adsBlend;const fov=g.camera.fov;const shot=g.debugCaptureDataUrl();return JSON.stringify({ads,fov,view:g.debugInfo().viewMode,shot});})()`,{timeoutMs:120000}));
 console.log('ADS live state:',JSON.stringify({...result,shot:`${result.shot.length} chars`}));
 if(result.shot?.startsWith('data:image/png;base64,'))writeFileSync(join(HERE,'shots','f3-ads.png'),Buffer.from(result.shot.slice(22),'base64'));
 if(result.ads<0.99||result.fov>60)throw new Error(`ADS did not reach its target: blend=${result.ads}, fov=${result.fov}`);
} finally { browser.close(); }
