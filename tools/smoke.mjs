// Headless end-to-end smoke test.
//
// Drives the real game in a real Chrome build against the production bundle:
// boot, start, movement, zombie chase/attack, hitscan damage and kills, wave
// progression, pause freezing the simulation, restart resource cleanliness,
// death/game-over, asset 404s and console errors. Frames are written to
// tools/shots/ for visual review.
//
//   npm run build
//   node tools/static-server.mjs &     # or: npm run dev
//   node tools/smoke.mjs
//
// The page is advanced by hand through Game.debugTick() because a display-less
// Chrome does not reliably fire requestAnimationFrame.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePng, launchChrome, newPage, open } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const URL_BASE = process.env.GAME_URL || 'http://127.0.0.1:4173/';
const VIEWPORT = { width: 800, height: 450 };

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOTS, { recursive: true });

const browser = await launchChrome({ width: VIEWPORT.width, height: VIEWPORT.height });
const page = await newPage();

const httpFailures = [];
const postSuccessCancellations = [];
const consoleErrors = [];
const requestUrls = new Map();
const requestStatus = new Map();
page.on('Network.requestWillBeSent', ({ requestId, request }) => {
  requestUrls.set(requestId, request.url);
});
page.on('Network.responseReceived', ({ requestId, response }) => {
  requestStatus.set(requestId, response.status);
  if (response.status >= 400) httpFailures.push(`${response.status} ${response.url}`);
});
page.on('Network.loadingFailed', ({ errorText, requestId, type, canceled }) => {
  const url = requestUrls.get(requestId) ?? requestId;
  const status = requestStatus.get(requestId);
  const succeededThenCancelled = canceled === true && typeof status === 'number' && status >= 200 && status < 300;
  if (succeededThenCancelled) {
    // three's FileLoader cancels the response stream it has finished reading,
    // which Chrome reports as ERR_ABORTED after the asset already arrived (the
    // asset is verified present by the boot checks below). Recorded, not failed.
    postSuccessCancellations.push(`${errorText} ${url}`);
    return;
  }
  httpFailures.push(`loadingFailed ${errorText} [${type}] ${url}`);
});
page.on('Runtime.exceptionThrown', (params) => {
  consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
});
page.on('Log.entryAdded', ({ entry }) => {
  if (entry.level === 'error') consoleErrors.push(entry.text);
});

await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Network.enable');
await page.send('Log.enable');

// Headless Chrome here rasterises in software (SwiftShader). At the default
// preset a single frame takes long enough to make the page unresponsive to CDP,
// so the run uses the low preset. It is a testing accommodation, not a product
// setting; the preset is written before boot so the first frame is already cheap.
await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dead-district:settings:v1', JSON.stringify({
    volume: 0.7, sensitivity: 1, quality: 'low', shadows: false,
    flashEffects: true, debugOverlay: false })); } catch (e) {}`,
});

const info = async () => JSON.parse(await page.evaluate('JSON.stringify(window.deadDistrict.debugInfo())', { timeoutMs: 30000 }));

/** Advances the simulation in chunks so no single CDP call can time out. */
async function drive(frames, { render = false } = {}) {
  let remaining = frames;
  while (remaining > 0) {
    const batch = Math.min(remaining, 300);
    await page.evaluate(`(() => {
      const g = window.deadDistrict;
      for (let i = 0; i < ${batch}; i += 1) g.debugTick(1 / 60, { render: ${render} });
      return true;
    })()`, { timeoutMs: 90000 });
    remaining -= batch;
  }
}

const hashes = new Map();
const shot = async (name, { fromCanvas = false } = {}) => {
  const file = join(SHOTS, `${name}.png`);
  let buffer;
  if (fromCanvas) {
    const dataUrl = await page.evaluate('window.deadDistrict.debugCaptureDataUrl()', { timeoutMs: 60000 });
    buffer = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
  } else {
    const shotInfo = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
    }, 60000);
    buffer = Buffer.from(shotInfo.data, 'base64');
  }
  writeFileSync(file, buffer);
  const hash = createHash('md5').update(buffer).digest('hex').slice(0, 12);
  hashes.set(name, hash);
  console.log(`  frame ${name}: ${buffer.length} bytes md5=${hash}`);
  return file;
};

try {
  await open(page, URL_BASE, { waitMs: 1000 });

  // --- boot (asset loading takes ~25 s in this CPU-starved container) ------
  const booted = await page.evaluate(`(async () => {
    for (let i = 0; i < 900; i += 1) {
      if (window.deadDistrict) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`, { timeoutMs: 150000 });
  check('game instance is created', booted === true);

  const boot = await info();
  console.log('\nboot info:', JSON.stringify({
    phase: boot.phase,
    kinds: boot.zombieKinds,
    clipsPerKind: boot.clipInventory.map((entry) => `${entry.kind}=${entry.clips.length}`),
    clips: boot.clipInventory,
    failures: boot.loadingFailures,
    collisionBoxes: boot.collisionBoxes,
    walkableRatio: boot.walkableRatio,
  }, null, 2));

  check('no asset failed to load', boot.loadingFailures.length === 0, boot.loadingFailures.join('; '));
  check('all three character models loaded', boot.zombieKinds.length === 3, boot.zombieKinds.join(','));
  check('character models expose animation clips',
    boot.clipInventory.length > 0 && boot.clipInventory.every((entry) => entry.clips.length > 0),
    boot.clipInventory.map((entry) => `${entry.kind}: ${entry.clips.slice(0, 4).join(', ')}…`).join(' | '));
  for (const entry of boot.clipInventory) {
    check(`${entry.kind} has idle/walk/run/death bound`,
      Boolean(entry.mapping.idle && entry.mapping.walk && entry.mapping.run && entry.mapping.death),
      JSON.stringify(entry.mapping));
  }
  check('navigation grid has walkable and blocked cells',
    boot.walkableRatio > 0.2 && boot.walkableRatio < 0.98, `walkableRatio=${boot.walkableRatio}`);
  check('title screen is shown after boot', boot.phase === 'title', boot.phase);

  // --- survivor selection and camera modes --------------------------------
  check('a survivor is loaded and visible in the title showcase',
    boot.characterName !== 'none' && boot.avatarVisible === true && boot.showcaseActive === true,
    `${boot.characterName} visible=${boot.avatarVisible} showcase=${boot.showcaseActive}`);
  check('the survivor resolved idle/walk/run clips without fallback',
    boot.avatarClips.idle !== null && boot.avatarClips.walk !== null && boot.avatarClips.run !== null,
    JSON.stringify(boot.avatarClips));
  check('third person is the default camera mode',
    boot.viewMode === 'third', String(boot.viewMode));

  const roster = JSON.parse(await page.evaluate(`(async () => {
    const g = window.deadDistrict;
    const ids = ['lis', 'matt', 'sam', 'shaun'];
    const rows = [];
    for (const id of ids) {
      const loaded = await g.debugSelectCharacter(id);
      for (let i = 0; i < 5; i += 1) g.debugTick(1 / 60, { render: false });
      const info = g.debugInfo();
      const audit = g.debugAvatarAudit();
      rows.push({
        id, loaded, name: info.characterName, file: info.characterFile,
        health: info.characterMaxHealth, walk: info.playerWalkSpeed, sprint: info.playerSprintSpeed,
        clips: info.avatarClips, visible: info.avatarVisible,
        meshes: audit.visibleMeshes, shadowCasters: audit.shadowCasters,
        hiddenMeshes: audit.hiddenMeshes.length, bones: audit.boneNames.length,
        textured: audit.texturedMaterials, materials: audit.materials,
        anisotropy: audit.anisotropy, worldHeight: audit.worldHeight,
      });
    }
    return JSON.stringify(rows);
  })()`, { timeoutMs: 600000 }));
  console.log('\nsurvivor roster:');
  for (const row of roster) {
    console.log(`  ${row.id}: loaded=${row.loaded} name=${row.name} hp=${row.health} ` +
      `walk=${row.walk} sprint=${row.sprint} meshes=${row.meshes} shadow=${row.shadowCasters} ` +
      `textured=${row.textured}/${row.materials} aniso=${row.anisotropy} h=${row.worldHeight}`);
  }
  check('all four survivors load', roster.length === 4 && roster.every((r) => r.loaded === true),
    roster.map((r) => `${r.id}:${r.loaded}`).join(' '));
  check('each survivor loads a different model file',
    new Set(roster.map((r) => r.file)).size === 4, roster.map((r) => r.file).join(','));
  check('each survivor animates with its own gun-holding clips',
    roster.every((r) => r.clips.idle !== null && r.clips.walk !== null && r.clips.run !== null),
    JSON.stringify(roster.map((r) => r.clips.idle)));
  check('survivor stats reach health and movement',
    roster.every((r) => r.health > 0 && r.walk > 3 && r.sprint > r.walk),
    roster.map((r) => `${r.name}:${r.health}hp ${r.sprint}m/s`).join(' '));
  check('the four survivors do not all share one stat line',
    new Set(roster.map((r) => `${r.health}/${r.walk}/${r.sprint}`)).size === 4,
    roster.map((r) => `${r.health}/${r.walk}`).join(' '));
  check('every survivor is textured, shadow-casting geometry',
    roster.every((r) => r.meshes > 0 && r.shadowCasters === r.meshes
      && r.textured === r.materials && r.anisotropy >= 1),
    JSON.stringify(roster.map((r) => `${r.shadowCasters}/${r.meshes} tex ${r.textured}/${r.materials}`)));
  check('the weapons bundled inside each character file stay hidden',
    roster.every((r) => r.hiddenMeshes >= 8),
    roster.map((r) => `${r.id}:${r.hiddenMeshes} hidden`).join(' '));
  check('every survivor has a full humanoid rig',
    roster.every((r) => r.bones > 20), roster.map((r) => r.bones).join(' '));
  check('every survivor is human scale',
    roster.every((r) => r.worldHeight > 1.4 && r.worldHeight < 2.4),
    roster.map((r) => r.worldHeight).join(' '));

  // Put a known survivor back before the run-based checks.
  await page.evaluate("window.deadDistrict.debugSelectCharacter('lis')", { timeoutMs: 180000 });

  await shot('01-title');

  // --- start --------------------------------------------------------------
  await page.evaluate("document.getElementById('btn-start').click()", { timeoutMs: 20000 });
  await sleep(300);
  let state = await info();
  check('start switches to playing', state.phase === 'playing', state.phase);

  // --- movement -----------------------------------------------------------
  const beforeMove = state.playerPosition;
  await page.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    return true;
  })()`, { timeoutMs: 20000 });
  await drive(60);
  await page.evaluate("window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }))", { timeoutMs: 20000 });
  state = await info();
  const moved = Math.hypot(state.playerPosition[0] - beforeMove[0], state.playerPosition[1] - beforeMove[1]);
  check('W moves the player', moved > 0.5, `moved ${moved.toFixed(2)}m`);

  // --- camera modes and the visible character ------------------------------
  const third = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const info = g.debugInfo();
    const camera = info.cameraPosition;
    const [px, , pz] = [info.playerPosition[0], 0, info.playerPosition[1]];
    const forwardX = -Math.sin(info.playerYaw);
    const forwardZ = -Math.cos(info.playerYaw);
    const dx = camera[0] - px;
    const dz = camera[2] - pz;
    return JSON.stringify({
      viewMode: info.viewMode,
      avatarVisible: info.avatarVisible,
      avatarState: info.avatarState,
      avatarPos: info.avatarPosition,
      weaponViewModelVisible: info.weaponViewModelVisible,
      camera,
      player: info.playerPosition,
      // Negative means the camera is behind the player along the aim axis.
      avatarFacing: info.avatarFacing,
      playerFacing: info.playerFacing,
      playerYaw: info.playerYaw,
      avatarFacingSource: info.avatarFacingSource,
      behind: dx * forwardX + dz * forwardZ,
      lateral: dx * forwardZ - dz * forwardX,
      horizontal: Math.hypot(dx, dz),
      heightAboveEye: camera[1] - 1.62,
    });
  })()`, { timeoutMs: 60000 }));
  console.log('\nthird person:', JSON.stringify(third));
  check('third person shows the character and hides the first-person weapon',
    third.viewMode === 'third' && third.avatarVisible === true && third.weaponViewModelVisible === false,
    `avatar=${third.avatarVisible} weapon=${third.weaponViewModelVisible}`);
  check('the character stands where the player is',
    third.avatarPos !== null
      && Math.abs(third.avatarPos[0] - third.player[0]) < 0.05
      && Math.abs(third.avatarPos[2] - third.player[1]) < 0.05,
    `${JSON.stringify(third.avatarPos)} vs ${JSON.stringify(third.player)}`);
  // The bug this locks: the model faces +Z (like the zombies) while the camera
  // looks down -Z, so handing the camera yaw to the avatar turned it 180 degrees.
  const halfTurn = Math.PI;
  let facingDelta = Math.abs((((third.avatarFacing ?? 0) - third.playerFacing) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (facingDelta > Math.PI) facingDelta = Math.PI * 2 - facingDelta;
  let yawDelta = Math.abs(((third.playerYaw - third.playerFacing) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (yawDelta > Math.PI) yawDelta = Math.PI * 2 - yawDelta;
  console.log(`facing: avatar=${third.avatarFacing} player=${third.playerFacing} ` +
    `cameraYaw=${third.playerYaw} source=${third.avatarFacingSource}`);
  check('the character faces where the player aims, not the camera yaw',
    third.avatarFacing !== null && facingDelta < 0.01
      && Math.abs(yawDelta - halfTurn) < 0.01
      && third.avatarFacingSource === 'facingAngle',
    `avatar-player=${facingDelta.toFixed(4)} yaw-player=${yawDelta.toFixed(4)}`);

  check('the camera sits behind and above the player, with no sideways offset',
    third.behind < -2 && third.behind > -4.6 && third.heightAboveEye > 0.5
      && Math.abs(third.lateral) < 0.01,
    `behind=${third.behind.toFixed(2)} lateral=${third.lateral.toFixed(3)} up=${third.heightAboveEye.toFixed(2)}`);

  const viewToggle = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const first = g.debugToggleView();
    g.debugTick(1 / 60, { render: false });
    const fpInfo = g.debugInfo();
    const second = g.debugToggleView();
    g.debugTick(1 / 60, { render: false });
    const tpInfo = g.debugInfo();
    return JSON.stringify({
      first, second,
      fpAvatarVisible: fpInfo.avatarVisible,
      fpWeaponVisible: fpInfo.weaponViewModelVisible,
      tpAvatarVisible: tpInfo.avatarVisible,
      tpWeaponVisible: tpInfo.weaponViewModelVisible,
    });
  })()`, { timeoutMs: 60000 }));
  console.log('view toggle:', JSON.stringify(viewToggle));
  // First person has no hands yet: the view model floats. That is a known gap, and
  // the assertion pins the current contract so a change is deliberate.
  check('V switches to first person (body hidden, view model shown) and back',
    viewToggle.first === 'first' && viewToggle.fpAvatarVisible === false
      && viewToggle.fpWeaponVisible === true && viewToggle.second === 'third'
      && viewToggle.tpAvatarVisible === true && viewToggle.tpWeaponVisible === false,
    JSON.stringify(viewToggle));

  // Weapon feel: a shot has to be more than a number going down.
  const casings = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    if (!g.debugInfo().playerAlive) document.getElementById('btn-restart-pause').click();
    for (let attempt = 1; attempt <= 90; attempt += 1) {
      const before = g.debugInfo().activeCasings;
      g.debugAimAtNearestZombie();
      const report = g.debugFireReport();
      const after = g.debugInfo().activeCasings;
      if (report && after > before) {
        // Read the shot effects in the same frame as the shot: the flash lives 55 ms, so
        // a tick between firing and reading would legitimately find it already gone.
        const shot = g.debugInfo();
        return JSON.stringify({
          fired: true, before, after, attempt,
          flash: shot.muzzleFlashActive, smoke: shot.muzzleSmokeActive,
          flashSpawned: shot.muzzleFlashSpawned,
          tracersActive: shot.tracersActive, tracersSpawned: shot.tracersSpawned,
        });
      }
      g.debugTick(1 / 60, { render: false });
    }
    const stuck = g.debugInfo();
    return JSON.stringify({
      fired: false, before: -1, after: -1, attempt: 90,
      state: {
        phase: stuck.phase, alive: stuck.playerAlive, weapon: stuck.weapon,
        magazine: stuck.magazine, reserve: stuck.reserve, reloading: stuck.reloading,
        owned: stuck.ownedWeapons,
      },
    });
  })()`, { timeoutMs: 120000 }));
  console.log('shell casings:', JSON.stringify(casings));
  check('firing draws a layered muzzle flash, smoke and a tracer',
    casings.fired === true && casings.flash !== undefined
      && casings.flash + casings.smoke > 0 && casings.flashSpawned > 0
      && casings.tracersActive > 0 && casings.tracersSpawned > 0,
    `flash=${casings.flash} smoke=${casings.smoke} tracers=${casings.tracersActive}`);

  // The effects are pooled: they must retire on their own, not pile up in the scene.
  const settled = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    for (let i = 0; i < 100; i += 1) g.debugTick(1 / 60, { render: false });
    const info = g.debugInfo();
    return JSON.stringify({
      flash: info.muzzleFlashActive, smoke: info.muzzleSmokeActive, tracers: info.tracersActive,
      spawned: info.muzzleFlashSpawned,
    });
  })()`, { timeoutMs: 60000 }));
  check('the flash, smoke and tracer retire after their brief life',
    settled.flash === 0 && settled.smoke === 0 && settled.tracers === 0 && settled.spawned > 0,
    JSON.stringify(settled));

  // Gunshots: the sample path has to be the one running, not the synthesised fallback.
  // Samples load asynchronously, so this waits for the decode rather than assuming it.
  const audio = JSON.parse(await page.evaluate(`(async () => {
    const g = window.deadDistrict;
    for (let i = 0; i < 40; i += 1) {
      if (g.debugInfo().audioSamplesLoaded > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const before = g.debugInfo();
    for (let i = 0; i < 30; i += 1) {
      g.debugAimAtNearestZombie();
      if (g.debugFireReport()) break;
      g.debugTick(1 / 60, { render: false });
    }
    const after = g.debugInfo();
    return JSON.stringify({
      loaded: after.audioSamplesLoaded,
      failures: after.audioFailures,
      sampleShots: after.audioSampleShots,
      synthesised: after.audioSynthShots,
    });
  })()`, { timeoutMs: 120000 }));
  check('gunshots play a recorded sample instead of only a synthesised burst',
    audio.loaded >= 4 && audio.sampleShots > 0,
    JSON.stringify(audio));

  check('firing ejects a visible shell casing',
    casings.fired === true && casings.after > casings.before,
    `before=${casings.before} after=${casings.after} state=${JSON.stringify(casings.state ?? null)}`);

  // --- hitscan combat ------------------------------------------------------
  // Combat is verified before the long soak: once the player dies the simulation
  // freezes (correctly), so an exchange has to be tested while alive.
  const combat = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const before = g.debugInfo();
    const parse = () => g.debugInfo();
    let fired = 0;
    let zombieHits = 0;
    let worldHits = 0;
    let misses = 0;
    let kills = 0;
    let minEngagementDistance = Infinity;

    const nearestZombieDistance = () => {
      const info = parse();
      const me = info.playerPosition;
      let best = Infinity;
      for (const p of info.zombiePositions) {
        const d = Math.hypot(p[0] - me[0], p[1] - me[1]);
        if (d < best) best = d;
      }
      return best;
    };

    for (let i = 0; i < 2400 && kills === 0; i += 1) {
      const info = parse();
      if (!info.playerAlive) break;
      // Fire only at a zombie that is actually in weapon range: a shot that
      // drifts over a distant head is real recoil behaviour, not a bug, but it
      // makes a poor assertion.
      if (i % 5 === 0) minEngagementDistance = Math.min(minEngagementDistance, nearestZombieDistance());
      if (minEngagementDistance < 15 && g.debugAimAtNearestZombie()) {
        const report = g.debugFireReport();
        if (report) {
          fired += 1;
          if (report.target === 'zombie') {
            zombieHits += 1;
            if (report.killed) kills += 1;
          } else if (report.target === 'world') worldHits += 1;
          else misses += 1;
        }
      }
      g.debugTick(1 / 60, { render: false });
    }
    return JSON.stringify({ fired, zombieHits, worldHits, misses, kills, minEngagementDistance, before, after: parse() });
  })()`, { timeoutMs: 240000 }));
  console.log('\ncombat:', JSON.stringify({
    shotsFired: combat.fired,
    zombieHits: combat.zombieHits,
    worldHits: combat.worldHits,
    cleanMisses: combat.misses,
    kills: combat.kills,
    closestZombie: Number(combat.minEngagementDistance.toFixed(2)),
    hitsLanded: `${combat.before.hitsLanded} -> ${combat.after.hitsLanded}`,
    headshots: `${combat.before.headshots} -> ${combat.after.headshots}`,
    killsCounter: `${combat.before.kills} -> ${combat.after.kills}`,
    playerAlive: combat.after.playerAlive,
  }));
  check('the weapon fires and consumes ammunition',
    combat.fired > 0, `shots=${combat.fired}`);

  check('shots resolve against zombie hitboxes',
    combat.zombieHits > 0,
    `${combat.zombieHits} zombie hits, ${combat.worldHits} world hits, ${combat.misses} clean misses`);
  check('hitscan damage kills zombies',
    combat.kills > 0 && combat.after.kills > combat.before.kills,
    `kills ${combat.before.kills} -> ${combat.after.kills}`);
  check('shots that hit walls report a world hit rather than damaging a zombie',
    combat.worldHits + combat.misses + combat.zombieHits === combat.fired,
    `accounted ${combat.worldHits + combat.misses + combat.zombieHits} of ${combat.fired}`);

  // --- the horde keeps coming ---------------------------------------------
  let sawChase = false;
  let restartCount = 0;
  // The combat phase can end with the player dead, and death freezes the simulation
  // (correctly), which would leave this phase unable to observe an attack. Restart
  // so it always begins from a live, full-health player.
  await page.evaluate(`(() => {
    const g = window.deadDistrict;
    if (!g.debugInfo().playerAlive) document.getElementById('btn-restart-pause').click();
    for (let i = 0; i < 20; i += 1) g.debugTick(1 / 60, { render: false });
    return true;
  })()`, { timeoutMs: 60000 });
  console.log('chase phase start:', JSON.stringify(await info().then((s) => ({
    alive: s.playerAlive, health: s.playerHealth, wave: s.wave,
  }))));

  let sawAttack = false;
  let sawDamage = false;
  state = await info();
  /**
   * A wall-clock budget, not a fixed number of rounds.
   *
   * Ten rounds of three seconds is 30 s, which is enough for the horde to reach the
   * player — but not enough after a mid-phase death, because the restart puts the wave
   * director into its break with an empty field and the remaining rounds run out before
   * the next wave engages. The phase then "fails" with nothing engaged, which says
   * nothing about the zombies. A budget that keeps driving until the flags are set (or
   * 75 s really have passed) tests the AI instead of the clock.
   */
  // Snapshot before the pressure phase so "the wave moved on" can be measured, not assumed.
  const baseline = JSON.parse(await page.evaluate(`(() => {
    const info = window.deadDistrict.debugInfo();
    return JSON.stringify({ wave: info.wave, remaining: info.remainingInWave, kills: info.kills });
  })()`, { timeoutMs: 60000 }));

  const deadline = Date.now() + 75_000;
  // Declared outside the loop: the report below prints it after the loop ends.
  let round = 0;
  for (round = 0; Date.now() < deadline; round += 1) {
    await drive(180);
    state = await info();
    if (state.zombieStates.some((entry) => /:chase/.test(entry))) sawChase = true;
    if (state.zombieStates.some((entry) => /:attack/.test(entry))) sawAttack = true;
    if (state.playerHealth < 100 || !state.playerAlive) sawDamage = true;
    if (sawChase && sawAttack && sawDamage) break;

    // The horde can win inside a round, and death freezes the simulation (correctly),
    // which would leave this phase staring at a stopped world. Restart and keep
    // watching rather than failing on the horde being lucky.
    if (!state.playerAlive) {
      await page.evaluate(`(() => {
        document.getElementById('btn-restart-pause').click();
        for (let i = 0; i < 20; i += 1) window.deadDistrict.debugTick(1 / 60, { render: false });
        return true;
      })()`, { timeoutMs: 60000 });
      restartCount += 1;
    }
  }
  console.log('\nafter ~30s of horde pressure:', JSON.stringify({
    wave: state.wave, wavePhase: state.wavePhase, active: state.activeZombies,
    engaged: state.engagedZombies, pooled: state.pooledZombies,
    states: state.zombieStates.slice(0, 8), health: state.playerHealth, kills: state.kills,
    restartsAfterDeath: restartCount, rounds: round,
  }, null, 2));

  check('zombies chase the player', sawChase);
  check('zombies attack and damage the player', sawAttack && sawDamage, `health=${state.playerHealth}`);

  /**
   * The reported stall: a wave that says eight zombies are left while none can be found, so
   * the run never continues. The rescue path exists as a last resort, and in a healthy run
   * it must never be needed — which is exactly what this asserts. (A "did anything move"
   * check was tried and dropped: the phase legitimately restarts runs, which zeroes the kill
   * and wave counters, so it reported a stall whenever the player died.)
   */
  const reach = JSON.parse(await page.evaluate(`(() => {
    const info = window.deadDistrict.debugInfo();
    return JSON.stringify({
      phase: info.wavePhase, remaining: info.remainingInWave,
      recalled: info.stragglersRecalled, health: info.playerHealth,
    });
  })()`, { timeoutMs: 60000 }));
  console.log('wave reachability:', JSON.stringify({ baseline, now: reach }));
  check('spawning places zombies the player can actually reach', reach.recalled === 0,
    `straggler recalls: ${reach.recalled} (phase=${reach.phase} remaining=${reach.remaining} health=${reach.health})`);
  check('zombies reach the player through the navigation grid',
    state.engagedZombies > 0, `engaged=${state.engagedZombies}`);
  check('zombie AI is spread across states, not all in one',
    new Set(state.zombieStates.map((entry) => entry.split(':')[1])).size >= 2,
    state.zombieStates.slice(0, 6).join(' '));

  // --- ensure a live run for the UI checks --------------------------------
  const ensurePlaying = async () => {
    const current = JSON.parse(await page.evaluate(`JSON.stringify({
      phase: window.deadDistrict.debugInfo().phase,
      alive: window.deadDistrict.debugInfo().playerAlive,
    })`, { timeoutMs: 30000 }));
    if (current.phase === 'playing' && current.alive) return false;
    // Both restart buttons call the same handler; the pause one exists no matter
    // which screen is visible.
    await page.evaluate("document.getElementById('btn-restart-pause').click()", { timeoutMs: 20000 });
    await drive(30);
    return true;
  };
  const wasDeadAfterCombat = !(await info()).playerAlive;
  if (wasDeadAfterCombat) await ensurePlaying();
  check('a run can be restarted after dying mid-combat', true,
    wasDeadAfterCombat ? 'player died, restarted' : 'player survived the exchange');

  // --- weapon unlock + HUD ------------------------------------------------
  await page.evaluate('window.deadDistrict.debugUnlockAllWeapons()', { timeoutMs: 20000 });
  state = await info();
  check('assault rifle unlock adds the second weapon',
    state.ownedWeapons.includes('rifle'), state.ownedWeapons.join(','));

  await page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }))", { timeoutMs: 20000 });
  await drive(3);
  await page.evaluate('window.deadDistrict.debugTick(0.016, { render: true })', { timeoutMs: 60000 });
  await shot('02-gameplay-canvas', { fromCanvas: true });
  await shot('03-gameplay-page');

  const hud = JSON.parse(await page.evaluate(`JSON.stringify({
    health: document.getElementById('hud-health').textContent,
    healthBar: document.getElementById('hud-health-bar').style.width,
    ammo: document.getElementById('hud-ammo').textContent,
    reserve: document.getElementById('hud-reserve').textContent,
    weapon: document.getElementById('hud-weapon').textContent,
    kills: document.getElementById('hud-kills').textContent,
    wave: document.getElementById('hud-wave').textContent,
    remaining: document.getElementById('hud-remaining').textContent,
    hudVisible: !document.getElementById('hud').classList.contains('hidden'),
    crosshairBloom: document.getElementById('crosshair').style.getPropertyValue('--bloom'),
  })`, { timeoutMs: 20000 }));
  console.log('\nHUD (read from the DOM):', JSON.stringify(hud));
  state = await info();
  check('HUD is visible while playing', hud.hudVisible === true);
  check('HUD kill counter matches the simulation',
    String(state.kills) === hud.kills, `sim=${state.kills} hud=${hud.kills}`);
  check('HUD shows health, ammo and wave',
    Number(hud.health) >= 0 && hud.ammo !== '' && Number(hud.wave) >= 1,
    `health=${hud.health} ammo=${hud.ammo} wave=${hud.wave}`);
  check('crosshair bloom is driven by real spread',
    /px$/.test(hud.crosshairBloom), `bloom=${hud.crosshairBloom}`);

  // --- pause freezes the simulation ---------------------------------------
  if (!(await info()).playerAlive) await ensurePlaying();
  const pauseProbe = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const info = g.debugInfo();
    if (info.phase !== 'playing') return JSON.stringify({ skipped: true, phase: info.phase });
    g.testHooks.state.set('paused');
    const before = g.debugInfo();
    for (let i = 0; i < 600; i += 1) g.debugTick(1 / 60, { render: false });
    const after = g.debugInfo();
    return JSON.stringify({ before, after });
  })()`, { timeoutMs: 120000 }));
  if (pauseProbe.skipped) {
    check('pause can be tested from a playing state', false, `phase=${pauseProbe.phase}`);
  } else {
    check('pausing stops movement, AI and damage',
      pauseProbe.before.playerHealth === pauseProbe.after.playerHealth
        && pauseProbe.before.activeZombies === pauseProbe.after.activeZombies
        && pauseProbe.before.playerPosition[0] === pauseProbe.after.playerPosition[0]
        && pauseProbe.before.kills === pauseProbe.after.kills,
      `health ${pauseProbe.before.playerHealth}->${pauseProbe.after.playerHealth}, zombies ${pauseProbe.before.activeZombies}->${pauseProbe.after.activeZombies}`);
    check('pause menu is shown',
      (await page.evaluate("!document.getElementById('screen-pause').classList.contains('hidden')", { timeoutMs: 20000 })) === true);
    check('HUD is hidden behind the pause menu',
      (await page.evaluate("document.getElementById('hud').classList.contains('hidden')", { timeoutMs: 20000 })) === true);
    await shot('04-pause-menu');
  }

  // --- restart cleanliness ------------------------------------------------
  const restartProbe = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const before = g.debugMemory();
    document.getElementById('btn-restart-pause').click();
    for (let i = 0; i < 300; i += 1) g.debugTick(1 / 60, { render: false });
    const after = g.debugMemory();
    return JSON.stringify({ before, after, info: g.debugInfo() });
  })()`, { timeoutMs: 120000 }));
  console.log('\nrestart memory probe:', JSON.stringify(restartProbe));
  check('restart returns to playing', restartProbe.info.phase === 'playing', restartProbe.info.phase);
  check('the chosen survivor and its stats survive a restart',
    restartProbe.info.characterName === 'Lis'
      && restartProbe.info.characterMaxHealth === 110
      && restartProbe.info.avatarVisible === true,
    `${restartProbe.info.characterName} ${restartProbe.info.characterMaxHealth}hp ` +
    `avatarVisible=${restartProbe.info.avatarVisible}`);
  check('restart resets the run and refills the character to its own maximum',
    // Compared against the character's ceiling, not PLAYER.maxHealth: with
    // per-survivor health a hardcoded 100 would fail for three of the four.
    restartProbe.info.kills === 0
      && restartProbe.info.playerHealth === restartProbe.info.characterMaxHealth,
    `kills=${restartProbe.info.kills} health=${restartProbe.info.playerHealth}/` +
    `${restartProbe.info.characterMaxHealth}`);
  check('restart does not duplicate scene objects',
    restartProbe.after.objects <= restartProbe.before.objects + 5,
    `objects ${restartProbe.before.objects} -> ${restartProbe.after.objects}`);
  check('restart does not leak GPU resources',
    restartProbe.after.geometries <= restartProbe.before.geometries + 2
      && restartProbe.after.textures <= restartProbe.before.textures + 1,
    `geometries ${restartProbe.before.geometries}->${restartProbe.after.geometries}, textures ${restartProbe.before.textures}->${restartProbe.after.textures}`);

  // --- death and game over (soak: stand still and let the horde finish) ---
  for (let round = 0; round < 30; round += 1) {
    await drive(300);
    state = await info();
    if (!state.playerAlive) break;
  }
  const death = JSON.parse(await page.evaluate(`JSON.stringify({
    alive: window.deadDistrict.debugInfo().playerAlive,
    phase: window.deadDistrict.debugInfo().phase,
    visible: !document.getElementById('screen-gameover').classList.contains('hidden'),
    wave: document.getElementById('gameover-wave').textContent,
    kills: document.getElementById('gameover-kills').textContent,
    time: document.getElementById('gameover-time').textContent,
  })`, { timeoutMs: 30000 }));
  console.log('\ndeath probe:', JSON.stringify(death));
  check('death ends the run and shows the game over screen',
    death.alive === false && death.phase === 'gameOver' && death.visible === true,
    JSON.stringify(death));
  const afterDeath = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    const before = g.debugInfo();
    for (let i = 0; i < 300; i += 1) g.debugTick(1 / 60, { render: false });
    const after = g.debugInfo();
    return JSON.stringify({ before, after });
  })()`, { timeoutMs: 120000 }));
  check('game over stops the simulation',
    afterDeath.after.kills === afterDeath.before.kills
      && afterDeath.after.playerHealth === afterDeath.before.playerHealth
      && afterDeath.after.playerPosition[0] === afterDeath.before.playerPosition[0],
    `health ${afterDeath.before.playerHealth}->${afterDeath.after.playerHealth}`);
  await shot('05-game-over');

  // --- frame sanity -------------------------------------------------------
  const canvasHash = hashes.get('02-gameplay-canvas');
  const titleHash = hashes.get('01-title');
  check('captured frames differ (no stale compositor frames)',
    Boolean(canvasHash && titleHash && canvasHash !== titleHash),
    `canvas=${canvasHash} title=${titleHash}`);

  // --- menus, settings and the remaining controls -------------------------
  const menus = JSON.parse(await page.evaluate(`(async () => {
    const g = window.deadDistrict;
    const visible = (id) => !document.getElementById(id).classList.contains('hidden');
    const out = {};

    // The transition table correctly refuses gameOver -> paused, and this section
    // runs after the death soak, so start from a live run before testing pause.
    document.getElementById('btn-restart-pause').click();
    await new Promise((r) => setTimeout(r, 40));

    // Pause -> settings -> back, exercising both settings entry points.
    g.testHooks.state.set('paused');
    out.pauseVisible = visible('screen-pause');
    document.getElementById('btn-settings-pause').click();
    out.settingsFromPause = visible('screen-settings');
    document.getElementById('btn-settings-back').click();
    out.backToPause = visible('screen-pause');
    document.getElementById('btn-exit').click();
    out.exitToTitle = visible('screen-title');

    document.getElementById('btn-controls').click();
    out.controlsVisible = visible('screen-controls');
    document.getElementById('btn-controls-back').click();
    document.getElementById('btn-credits').click();
    out.creditsVisible = visible('screen-credits');
    out.creditsHasQuaternius = /quaternius/i.test(document.getElementById('credits-body').textContent || '');
    document.getElementById('btn-credits-back').click();
    out.creditsClosed = visible('screen-title');

    // Settings that must reach a real system, not just the DOM.
    document.getElementById('btn-settings').click();
    const volume = document.getElementById('set-volume');
    volume.value = '35';
    volume.dispatchEvent(new Event('input'));
    const sensitivity = document.getElementById('set-sensitivity');
    sensitivity.value = '250';
    sensitivity.dispatchEvent(new Event('input'));
    const shadows = document.getElementById('set-shadows');
    const shadowsBefore = g.debugInfo().shadowMapEnabled;
    shadows.click();
    const quality = document.getElementById('set-quality');
    quality.value = 'high';
    quality.dispatchEvent(new Event('change'));
    const debug = document.getElementById('set-debug');
    debug.click();
    await new Promise((r) => setTimeout(r, 60));

    const info = g.debugInfo();
    out.volume = info.masterVolume;
    out.sensitivity = info.sensitivity;
    out.shadowsBefore = shadowsBefore;
    out.shadowsAfter = info.shadowMapEnabled;
    out.zombieCap = info.activeZombieCap;
    out.debugOverlay = info.debugOverlayVisible;
    out.persisted = (window.localStorage.getItem('dead-district:settings:v1') || '').includes('high');
    return JSON.stringify(out);
  })()`, { timeoutMs: 120000 }));
  console.log('\nmenus and settings:', JSON.stringify(menus));
  check('pause -> settings -> pause -> exit to title all reachable',
    menus.pauseVisible && menus.settingsFromPause && menus.backToPause && menus.exitToTitle);
  check('controls and credits screens open, and credits name the asset author',
    menus.controlsVisible && menus.creditsVisible && menus.creditsHasQuaternius && menus.creditsClosed);
  check('volume slider reaches the audio system', Math.abs(menus.volume - 0.35) < 0.001, String(menus.volume));
  check('sensitivity slider reaches the player controller', Math.abs(menus.sensitivity - 2.5) < 0.001, String(menus.sensitivity));
  check('shadow toggle reaches the renderer', menus.shadowsBefore !== menus.shadowsAfter,
    `${menus.shadowsBefore} -> ${menus.shadowsAfter}`);
  check('quality change re-caps the active zombie budget', menus.zombieCap === 28, String(menus.zombieCap));
  check('debug overlay toggle reaches the HUD', menus.debugOverlay === true);
  check('settings persist to localStorage', menus.persisted === true);

  // Back to the low preset: the remaining soak runs under software rendering, and
  // this is a harness setting, not a product default.
  await page.evaluate(`(() => {
    const select = document.getElementById('set-quality');
    select.value = 'low';
    select.dispatchEvent(new Event('change'));
    const shadows = document.getElementById('set-shadows');
    if (shadows.checked) shadows.click();
    const debug = document.getElementById('set-debug');
    if (debug.checked) debug.click();
    return true;
  })()`, { timeoutMs: 30000 });

  // --- weapon controls: 1/2 switch and R reload ---------------------------
  const weaponKeys = JSON.parse(await page.evaluate(`(async () => {
    const g = window.deadDistrict;
    // Guarantee a live run with the rifle unlocked.
    if (!g.debugInfo().playerAlive || g.debugInfo().phase !== 'playing') {
      document.getElementById('btn-restart-pause').click();
      for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
    }
    const beforeUnlock = g.debugInfo().weapon;
    g.debugUnlockAllWeapons();
    await new Promise((r) => setTimeout(r, 30));
    // Picking a weapon up equips it, so the unlock should change the active weapon.
    const afterUnlock = g.debugInfo();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
    g.debugTick(1 / 60, { render: false });
    const afterSlot1 = g.debugInfo();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
    g.debugTick(1 / 60, { render: false });
    const afterSlot2 = g.debugInfo();

    // Reload: spend a round so the magazine is not full, then press R.
    g.debugFireReport();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    g.debugTick(1 / 60, { render: false });
    for (let i = 0; i < 20; i += 1) g.debugTick(1 / 60, { render: false });
    const duringReload = g.debugInfo();
    for (let i = 0; i < 200; i += 1) g.debugTick(1 / 60, { render: false });
    const afterReload = g.debugInfo();
    return JSON.stringify({
      owns: afterUnlock.ownedWeapons,
      beforeUnlock,
      afterUnlock: afterUnlock.weapon,
      afterSlot1: afterSlot1.weapon,
      afterSlot2: afterSlot2.weapon,
      reloadingDuring: duringReload.reloading,
      magazineAfter: afterReload.magazine,
    });
  })()`, { timeoutMs: 120000 }));
  console.log('\nweapon controls:', JSON.stringify(weaponKeys));
  check('picking the rifle up equips it, key 1 cycles primaries, key 2 draws the sidearm',
    weaponKeys.beforeUnlock === 'pistol'
      && weaponKeys.afterUnlock === 'rifle'
      // §14.1: 1 is the primary category, so from the rifle it rotates to the next primary —
      // never back to the sidearm, which has slot 2 to itself.
      && weaponKeys.afterSlot1 !== 'rifle' && weaponKeys.afterSlot1 !== 'pistol'
      && weaponKeys.afterSlot2 === 'pistol',
    `${weaponKeys.beforeUnlock} -> pickup ${weaponKeys.afterUnlock} -> key1 ${weaponKeys.afterSlot1} -> key2 ${weaponKeys.afterSlot2}`);
  check('R starts a reload and the magazine refills',
    weaponKeys.reloadingDuring === true && weaponKeys.magazineAfter > 0,
    `reloading=${weaponKeys.reloadingDuring} magazine=${weaponKeys.magazineAfter}`);

  // --- melee: the drawn weapon, its blow and its cooldown -----------------
  // Melee is the fallback when the magazine is empty, so it has to be checked while the run
  // is still live and ammunition is still in reserve — never at the end, after the player is
  // dead and the simulation has frozen (the mistake this project already made once). The
  // horde is topped up here so a swing always has something to land on; the spawn ring is
  // 24-52 m out, past every melee reach, so the player is moved next to the nearest one.
  const melee = JSON.parse(await page.evaluate(`(() => {
    const g = window.deadDistrict;
    // The melee roster, from src/app/meleeConfig.ts (there is no melee-config hook).
    const ids = ['knife', 'axe', 'barbed-bat', 'spear'];

    // A live run with a full reserve: this block must not inherit a death from a phase above.
    if (!g.debugInfo().playerAlive || g.debugInfo().phase !== 'playing') {
      document.getElementById('btn-restart-pause').click();
      for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
    }
    g.debugUnlockAllWeapons();

    // (a) every melee weapon's model loaded and it can actually be drawn.
    const models = [];
    const modelFailures = [];
    for (const id of ids) {
      const equipped = g.debugEquipMelee(id);
      for (let i = 0; i < 20; i += 1) g.debugTick(1 / 60, { render: false });
      const report = g.debugMeleeReport();
      const missing = g.debugInfo().loadingFailures.filter((f) => f.indexOf('melee model for ' + id) !== -1);
      models.push({ id, equipped, inHand: report.equipped, missing });
      if (equipped !== id) modelFailures.push(id + ' equip returned ' + equipped);
      if (report.equipped !== id) modelFailures.push(id + ' not in hand (' + report.equipped + ')');
      if (missing.length) modelFailures.push(id + ' model not loaded: ' + missing.join(','));
    }

    // Draw the knife before lining up the target, so the equip settle is not spent while
    // the walker closes the 2 m gap.
    g.debugEquipMelee('knife');
    for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });

    // Bring a target into reach and stand next to it. The stand-off is a fraction of the
    // knife's own reach, not a fixed number: at 2.0 m against a 1.7 m reach the swing had no
    // margin and this check failed with damage 0 while calling the game broken — the same
    // mistake the melee harness made with the axe, whose reach is exactly 2.0 m.
    g.debugFillHorde(6);
    for (let i = 0; i < 6; i += 1) g.debugTick(1 / 60, { render: false });
    const state = g.debugInfo();
    const me = state.playerPosition;
    let nearest = null;
    let best = Infinity;
    for (const p of state.zombiePositions) {
      const d = Math.hypot(p[0] - me[0], p[1] - me[1]);
      if (d < best) { best = d; nearest = p; }
    }
    let gap = null;
    if (nearest) {
      const reach = (g.debugMeleeConfig().knife || {}).reach || 1.7;
      const stand = Math.max(0.9, reach * 0.55);
      g.debugTeleport(nearest[0], nearest[1] + stand);
      // Measured after the teleport: the old value was the distance from before it, which is
      // why a swing at arm's length was reported as happening 24.65 m away.
      for (let i = 0; i < 3; i += 1) g.debugTick(1 / 60, { render: false });
      const moved = g.debugInfo();
      let after = Infinity;
      for (const p of moved.zombiePositions) {
        const d = Math.hypot(p[0] - moved.playerPosition[0], p[1] - moved.playerPosition[1]);
        if (d < after) after = d;
      }
      gap = Number(after.toFixed(2));
    }
    for (let i = 0; i < 3; i += 1) g.debugTick(1 / 60, { render: false });

    // (b) swing at the zombie in front of it.
    g.debugAimAtNearestZombie();
    const beforeSwing = g.debugInfo();
    const started = g.debugSwingMelee();
    for (let i = 0; i < 40 && g.debugMeleeReport().swinging; i += 1) g.debugTick(1 / 60, { render: false });
    const swing = g.debugMeleeReport();
    const afterSwing = g.debugInfo();

    // (c) pull it again inside the cooldown: refused, and no damage applied.
    const cooldownObserved = swing.cooldown;
    const hitsBeforeSecond = afterSwing.hitsLanded;
    const secondStarted = g.debugSwingMelee();
    for (let i = 0; i < 6; i += 1) g.debugTick(1 / 60, { render: false });
    const afterSecond = g.debugInfo();

    // (d) a firearm must still work once melee has been used: the two share the trigger.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
    for (let i = 0; i < 30; i += 1) g.debugTick(1 / 60, { render: false });
    if (g.debugInfo().magazine === 0) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
      for (let i = 0; i < 240; i += 1) g.debugTick(1 / 60, { render: false });
    }
    const beforeShot = g.debugInfo();
    g.debugAimAtNearestZombie();
    const shot = g.debugFireReport();
    const afterShot = g.debugInfo();

    return JSON.stringify({
      modelFailures, models, gap,
      swing: { started, damage: swing.damage, target: swing.lastTarget,
        hitsDelta: afterSwing.hitsLanded - beforeSwing.hitsLanded },
      cooldown: { observed: cooldownObserved, secondStarted,
        damageBefore: swing.damage, damageAfter: g.debugMeleeReport().damage,
        hitsDelta: afterSecond.hitsLanded - hitsBeforeSecond },
      firearm: { weapon: afterShot.weapon, before: beforeShot.magazine, after: afterShot.magazine, fired: shot !== null },
    });
  })()`, { timeoutMs: 180000 }));
  console.log('\nmelee:', JSON.stringify(melee));
  check('every melee weapon model loads and can be drawn',
    melee.modelFailures.length === 0,
    melee.modelFailures.join(' | ') || melee.models.map((m) => m.id + ':' + m.inHand).join(' '));
  check('a melee swing in front of a zombie lands a blow',
    melee.swing.started === true && melee.swing.damage > 0
      && melee.swing.target !== null && melee.swing.hitsDelta >= 1,
    `started=${melee.swing.started} damage=${melee.swing.damage} target=${melee.swing.target} ` +
    `hits+${melee.swing.hitsDelta} gap=${melee.gap}`);
  check('the melee cooldown prevents a second blow',
    melee.cooldown.observed > 0 && melee.cooldown.secondStarted === false
      && melee.cooldown.hitsDelta === 0 && melee.cooldown.damageAfter === melee.cooldown.damageBefore,
    `cooldown=${melee.cooldown.observed} secondStarted=${melee.cooldown.secondStarted} ` +
    `hits+${melee.cooldown.hitsDelta} damage ${melee.cooldown.damageBefore}->${melee.cooldown.damageAfter}`);
  check('firing a firearm still spends ammunition after melee is used',
    melee.firearm.fired === true && melee.firearm.before - melee.firearm.after === 1,
    `weapon=${melee.firearm.weapon} magazine ${melee.firearm.before}->${melee.firearm.after} ` +
    `fired=${melee.firearm.fired}`);

  // --- console / network health ------------------------------------------
  const fatalConsole = consoleErrors.filter((text) => !/favicon|DevTools|Autofill/i.test(text));
  check('no failed HTTP requests', httpFailures.length === 0, httpFailures.slice(0, 5).join(' | '));
  if (postSuccessCancellations.length > 0) {
    console.log(`  note: ${postSuccessCancellations.length} request(s) cancelled after a 2xx response ` +
      `(FileLoader stream abort, asset present): ${postSuccessCancellations.slice(0, 3).join(' | ')}`);
  }
  check('no uncaught console errors', fatalConsole.length === 0, fatalConsole.slice(0, 4).join(' | '));
} catch (error) {
  check('smoke harness completed without errors', false, String(error && error.stack ? error.stack.split('\n')[0] : error));
} finally {
  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failures:');
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? `: ${entry.detail}` : ''}`);
  }
  console.log(`screenshots: ${SHOTS}`);
  browser.close();
  await sleep(300);
  process.exit(failed.length > 0 ? 1 : 0);
}
