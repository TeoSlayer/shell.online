// Shared local-browser transports for the UI canaries.
//
// chrome: headless Chrome over CDP in a throwaway profile (emulated viewport,
//         DPR, and mobile flag via Emulation.setDeviceMetricsOverride).
// safari: a real /usr/bin/safaridriver session (isolated Safari) on an
//         ephemeral port. No emulation: real hardware DPR and real window
//         minimums, so callers must measure and log the actual viewport.
//
// Both expose the same surface:
//   evaluate(expression)  — awaitPromise + returnByValue semantics
//   navigate(url)
//   screenshot(clipExpr)  — chrome clips; safari captures the full viewport
//   setViewport({...})     — returns the effective { width, height, dpr }
//   close()
// The Safari transport only ever touches the session and driver it spawned.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const webdriver = (base, path, { method = 'GET', body } = {}) =>
  fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  }).then(async (res) => {
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = {}; }
    if (!res.ok) {
      // Synthetic local test only. Never print arbitrary driver/page messages.
      throw new Error(`Safari WebDriver ${method} failed`);
    }
    return payload;
  });

const closeDriver = (driver) => new Promise((resolve) => {
  if (driver.exitCode !== null) return resolve();
  let settled = false;
  const finish = () => { if (!settled) { settled = true; resolve(); } };
  const exited = new Promise((done) => { driver.once('exit', () => done()); });
  driver.once('error', finish);
  driver.kill('SIGTERM');
  void Promise.race([exited, delay(3000)]).then(() => {
    if (driver.exitCode === null) driver.kill('SIGKILL');
    void exited.then(finish);
    // A process that never started may fire neither 'exit' nor 'error'.
    void delay(500).then(finish);
  });
});

export async function launchChromeTransport({ profile }) {
  const chrome = spawn(process.env.SHELL_CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const pending = new Map();
  let nextId = 0;
  let socket;
  const waitFor = async (check, label) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (await check()) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const stopChrome = async () => {
    for (const handler of pending.values()) handler.reject(new Error('Browser canary stopped'));
    pending.clear();
    socket?.close();
    if (chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await exited; }
    }
  };
  let launchError;
  chrome.on('error', (error) => { launchError = error; });
  try {
    let debuggingPort;
    await waitFor(async () => {
      if (launchError) throw new Error('Chrome could not start');
      try {
        debuggingPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        return debuggingPort > 0;
      } catch { return false; }
    }, 'Chrome startup');
    const pages = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
    socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
    socket.onmessage = ({ data }) => {
      const value = JSON.parse(data);
      const handler = pending.get(value.id);
      if (!handler) return;
      pending.delete(value.id);
      if (value.error) handler.reject(new Error('CDP command failed'));
      else handler.resolve(value.result);
    };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  } catch (error) {
    await stopChrome();
    throw error;
  }
  const evaluate = async (expression) => {
    const value = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) {
      // Synthetic local test only. Never print arbitrary page exception strings.
      const name = value.exceptionDetails.exception?.className ?? 'unknown';
      throw new Error(`Browser assertion setup failed (${name}, line ${value.exceptionDetails.lineNumber})`);
    }
    return value.result.value;
  };
  return {
    name: 'chrome',
    evaluate,
    // Pass values through CDP's argument channel, never interpolate them into
    // JavaScript. fn must be a locally defined fixture function.
    call: async (fn, ...args) => {
      const global = await request('Runtime.evaluate', { expression: 'globalThis' });
      const objectId = global.result.objectId;
      try {
        const value = await request('Runtime.callFunctionOn', {
          objectId, functionDeclaration: fn.toString(),
          arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true,
        });
        if (value.exceptionDetails) throw new Error('Browser fixture call failed');
        return value.result.value;
      } finally {
        await request('Runtime.releaseObject', { objectId });
      }
    },
    navigate: (url) => request('Page.navigate', { url }),
    screenshot: async (clipExpression) => {
      const clip = clipExpression ? await evaluate(clipExpression) : undefined;
      const { data } = await request('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
      return data;
    },
    setViewport: async ({ width, height, dpr, mobile }) => {
      await request('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
      await request('Emulation.setTouchEmulationEnabled', { enabled: Boolean(mobile) });
      return { width, height, dpr };
    },
    // Trusted touch input, as a phone's finger produces it. type is
    // touchStart, touchMove, touchEnd or touchCancel; points are CSS pixels.
    enableTouch: () => request('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }),
    touch: (type, points) => request('Input.dispatchTouchEvent', {
      type, touchPoints: points.map(({ x, y }) => ({ x, y })),
    }),
    // A whole finger drag at a real speed (px/s), which one touch event per
    // round trip is far too slow to produce. yDistance > 0 drags downwards.
    flick: ({ x, y, yDistance, speed }) => request('Input.synthesizeScrollGesture', {
      x, y, yDistance, speed, gestureSourceType: 'touch', preventFling: false,
    }),
    // Trusted browser input, not a scripted scrollTop change. Only available
    // in Chrome; Safari still checks real native layout/scroll reachability.
    swipe: async ({ x, y, deltaY }) => {
      await request('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) {
        await request('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + deltaY * step / 8 }] });
        await delay(35);
      }
      await request('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await delay(250);
    },
    setEmulatedTheme: (theme) => request('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }],
    }),
    close: stopChrome,
  };
}

// Safari's WebDriver takes a function body, not an expression: the driver
// wraps it in a function and calls it with a trailing `done` callback for
// async scripts. The fixture expression is embedded directly in the body —
// no eval or new Function, so the app's CSP (no 'unsafe-eval') is untouched.
// Callers must pass a single expression, never a statement list.
const safariEvalBody = (expression) => `
  const done = arguments[arguments.length - 1];
  const fixedName = (e) => {
    const n = e && e.name;
    return (n === 'TypeError' || n === 'ReferenceError' || n === 'EvalError' ||
      n === 'SecurityError' || n === 'SyntaxError' || n === 'Error') ? n : 'Error';
  };
  Promise.resolve().then(() => (${expression}))
    .then((value) => done({ ok: true, value: value ?? null }), (e) => done({ ok: false, name: fixedName(e) }));
`;

// Safari's screenshot pipeline applies display color management (observed on
// this host: #00FF00 captured as (3,255,0), in-page canvas readback stays
// (0,255,0)). For Safari only, the exact-green paint check therefore allows a
// documented <=4/channel tolerance around RGB(0,255,0) with alpha 255,
// counted within the fixture element's ROI of the full-viewport screenshot.
// Chrome keeps the exact-RGB assertion on its clipped capture.
export const safariGreenPaintCheck = (elementId, base64Png) => `(() => (async () => {
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('png decode')); img.src = 'data:image/png;base64,' + ${JSON.stringify(base64Png)}; });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const r = document.getElementById(${JSON.stringify(elementId)}).getBoundingClientRect();
  const scale = img.naturalWidth / innerWidth;
  const x0 = Math.max(0, Math.floor(r.x * scale));
  const y0 = Math.max(0, Math.floor(r.y * scale));
  const x1 = Math.min(canvas.width, Math.ceil((r.x + r.width) * scale));
  const y1 = Math.min(canvas.height, Math.ceil((r.y + r.height) * scale));
  const px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let count = 0;
  const seen = new Map();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] !== 255) continue;
    if (px[i] <= 4 && px[i + 1] >= 251 && px[i + 2] <= 4) {
      count++;
      const key = px[i] + ',' + px[i + 1] + ',' + px[i + 2];
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return { count, observed: [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) };
})())()`;

const safariSession = ({ base, sessionId, driver }) => {
  const path = `/session/${sessionId}`;
  const evaluate = async (expression) => {
    const payload = await webdriver(base, `${path}/execute/async`, {
      method: 'POST',
      body: { script: safariEvalBody(expression), args: [] },
    });
    const envelope = payload.value;
    if (!envelope || envelope.ok !== true) {
      // Fixed allowlisted error name only — never a raw page message or stack.
      const name = envelope && typeof envelope.name === 'string' ? envelope.name : 'Error';
      throw new Error(`Browser assertion setup failed (${name}, line 0)`);
    }
    return envelope.value;
  };
  const measured = () => evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })');
  return {
    name: 'safari',
    evaluate,
    // WebDriver keeps argument data separate from the fixed function source.
    call: async (fn, ...args) => {
      const payload = await webdriver(base, `${path}/execute/async`, {
        method: 'POST',
        body: {
          script: `const done = arguments[arguments.length - 1];
            const args = Array.from(arguments).slice(0, -1);
            Promise.resolve().then(() => (${fn.toString()})(...args))
              .then(value => done({ok:true,value:value ?? null}), () => done({ok:false}));`,
          args,
        },
      });
      if (payload.value?.ok !== true) throw new Error('Browser fixture call failed');
      return payload.value.value;
    },
    navigate: (url) => webdriver(base, `${path}/url`, { method: 'POST', body: { url } }),
    screenshot: async () => (await webdriver(base, `${path}/screenshot`)).value,
    setViewport: async ({ width, height }) => {
      await webdriver(base, `${path}/window/rect`, { method: 'POST', body: { width, height } });
      await delay(300);
      return measured();
    },
    // The isolated session has no media emulation; use the page's own stored
    // theme preference (set on the origin before the app script runs).
    setStorageTheme: async (origin, theme) => {
      await webdriver(base, `${path}/url`, { method: 'POST', body: { url: `${origin}/` } });
      await evaluate(`(() => { localStorage.setItem('shell-online-terminal-theme', ${JSON.stringify(theme)}); return true; })()`);
    },
    close: async () => {
      try { await webdriver(base, path, { method: 'DELETE' }); } catch { /* session already gone */ }
      await closeDriver(driver);
    },
  };
};

export async function launchSafariTransport({ retries = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const driver = spawn('/usr/bin/safaridriver', ['--port', String(port)], { stdio: 'ignore' });
    let driverError;
    driver.on('error', (error) => { driverError = error; });
    try {
      const end = Date.now() + 20000;
      let up = false;
      while (Date.now() < end && !up) {
        if (driverError) throw new Error('safaridriver could not start');
        if (driver.exitCode !== null) throw new Error('safaridriver exited during startup');
        try { up = (await fetch(base + '/status', { signal: AbortSignal.timeout(2000) })).ok; } catch { /* not up yet */ }
        if (!up) await delay(250);
      }
      if (!up) throw new Error('safaridriver /status never came up');
      const created = await webdriver(base, '/session', {
        method: 'POST',
        body: { capabilities: { alwaysMatch: { browserName: 'safari' } } },
      });
      const sessionId = created.value?.sessionId;
      if (!sessionId) throw new Error('Safari session has no id');
      return safariSession({ base, sessionId, driver });
    } catch (error) {
      lastError = error;
      await closeDriver(driver);
      if (attempt < retries) await delay(1000);
    }
  }
  throw new Error(`Safari driver setup failed after ${retries} attempts: ${lastError?.message ?? lastError}`);
}
