// Minimal Chrome DevTools Protocol driver.
//
// Why hand-rolled: this sandbox has no browser automation library installed and
// no pip/apt rights. Node ships a global WebSocket client (Node 22+), which is
// everything CDP needs. Used for headless smoke tests, WebGL frame capture and
// fetching pages that are behind a bot wall for plain curl.
//
// Usage:
//   node tools/cdp.mjs dom    <url>                  # print outerHTML
//   node tools/cdp.mjs eval   <url> <js-expression>  # print evaluated result
//   node tools/cdp.mjs shot   <url> <out.png> [waitMs] [width] [height]
//   node tools/cdp.mjs fetch  <url> <out-file>       # download via the browser
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || join(HERE, 'chrome', 'chrome-linux64', 'chrome');
const PROFILE = join(HERE, '.chrome-profile');
const PORT = Number(process.env.CDP_PORT || 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kills any browser still holding this profile.
 *
 * If the driver itself is killed (a `timeout` wrapper, a Ctrl-C, a crashed run),
 * its `finally` never runs and Chrome's renderer/GPU children survive. A handful
 * of those exhausts a 1 GiB memory cgroup and makes every later run look like a
 * hung page, so cleanup happens before launch rather than only after.
 */
function killLeftoverBrowsers() {
  let killed = 0;
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        if (cmdline.includes(PROFILE)) {
          process.kill(Number(entry), 'SIGKILL');
          killed += 1;
        }
      } catch { /* process exited or is not ours */ }
    }
  } catch { /* no /proc: not Linux */ }
  return killed;
}

export async function launchChrome({ width = 1280, height = 720, extraArgs = [] } = {}) {
  if (!existsSync(CHROME)) throw new Error(`chrome not found at ${CHROME}`);
  const leftovers = killLeftoverBrowsers();
  if (leftovers > 0) console.log(`[cdp] cleaned up ${leftovers} leftover browser process(es) from a previous run`);
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=Translate,BackForwardCache',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`,
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
    ...extraArgs,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: SIGKILL on the group is the only reliable way to stop
    // the renderer/GPU children too. Letting them survive exhausts this
    // container's 1 GiB memory cgroup and starves the next run.
    detached: true,
  });

  const logs = [];
  proc.stderr.on('data', (d) => logs.push(String(d)));

  let version = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* not up yet */ }
    await sleep(150);
  }
  if (!version) {
    proc.kill('SIGKILL');
    throw new Error(`chrome did not expose CDP.\n${logs.join('')}`);
  }
  const close = () => {
    try {
      // Negative pid = the whole process group.
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  };
  return { proc, version, close };
}

export async function newPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' });
  const target = await res.json();
  return await connect(target.webSocketDebuggerUrl);
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  const consoleMessages = [];
  const pageErrors = [];
  let nextId = 1;

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push({
        level: msg.params.type,
        text: (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '),
      });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description
        || msg.params.exceptionDetails?.text || 'unknown exception');
    }
    const fns = listeners.get(msg.method) || [];
    for (const fn of fns) fn(msg.params);
  });

  const send = (method, params = {}, timeoutMs = 30000) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); res(v); },
      reject: (e) => { clearTimeout(timer); rej(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  return {
    send, on, consoleMessages, pageErrors,
    close: () => ws.close(),
    async evaluate(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
      const r = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise,
      }, timeoutMs);
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    },
  };
}

export async function open(page, url, { waitMs = 1500, waitForLoadEvent = true } = {}) {
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  const loaded = new Promise((res) => page.on('Page.loadEventFired', res));
  await page.send('Page.navigate', { url });
  if (waitForLoadEvent) {
    await Promise.race([loaded, sleep(20000)]);
  }
  await sleep(waitMs);
}

async function withBrowser(fn, opts = {}) {
  const { proc, close } = await launchChrome(opts);
  try {
    const page = await newPage();
    return await fn(page);
  } finally {
    close();
    await sleep(200);
  }
}

export async function capturePng(page, file, { width, height, timeoutMs = 30000 } = {}) {
  if (width && height) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  }
  // A software rasteriser can take far longer than the default to hand the
  // compositor a frame once shadows and MSAA are on, so this is caller-tunable.
  const shot = await page.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    timeoutMs,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

// Only act as a CLI when executed directly (`node tools/cdp.mjs ...`); the smoke
// test imports this file and must not trigger the CLI branch.
const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const [, , cmd, ...args] = isEntryPoint ? process.argv : [];

if (cmd) {
  const run = async () => {
    if (cmd === 'dom') {
      await withBrowser(async (page) => {
        await open(page, args[0]);
        console.log(await page.evaluate('document.documentElement.outerHTML'));
        if (page.consoleMessages.length) {
          console.error('--- console ---');
          for (const m of page.consoleMessages) console.error(`[${m.level}] ${m.text}`);
        }
      });
    } else if (cmd === 'eval') {
      await withBrowser(async (page) => {
        await open(page, args[0], { waitMs: Number(process.env.WAIT_MS || 2500) });
        const out = await page.evaluate(args[1], { awaitPromise: true, timeoutMs: 60000 });
        console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      });
    } else if (cmd === 'shot') {
      await withBrowser(async (page) => {
        await open(page, args[0], { waitMs: Number(args[2 + 1] || 2500) });
        const file = await capturePng(page, resolve(args[1]), { width: Number(args[3]) || undefined, height: Number(args[4]) || undefined });
        console.log(file);
        for (const m of page.consoleMessages) console.error(`[${m.level}] ${m.text}`);
      });
    } else if (cmd === 'fetch') {
      await withBrowser(async (page) => {
        await open(page, args[0], { waitMs: 3000 });
        const b64 = await page.evaluate(`fetch(${JSON.stringify(args[0])}).then(r => r.arrayBuffer()).then(b => btoa(String.fromCharCode(...new Uint8Array(b))))`, { timeoutMs: 120000 });
        mkdirSync(dirname(resolve(args[1])), { recursive: true });
        writeFileSync(resolve(args[1]), Buffer.from(b64, 'base64'));
        console.log(`${args[1]} ${readFileSync(resolve(args[1])).length} bytes`);
      });
    } else {
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
    }
  };
  run().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
