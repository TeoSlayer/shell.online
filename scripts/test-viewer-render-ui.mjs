// Local browser canary: the standalone /s/<id> viewer must render the real
// index.html + web/main.ts — synthetic plaintext WebSocket, real CSS, real
// xterm — fitting the session grid into the viewport across desktop/narrow,
// DPR 1/2, light/dark, a viewport resize, and a recovery snapshot+output.
// No relay, server, or auth.
// SHELL_BROWSER=safari runs the same fixtures through a real safaridriver
// session (no DPR/mobile emulation; the actual measured viewport is logged).
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport, launchSafariTransport, safariGreenPaintCheck } from './lib/browser-transport.mjs';

const browser = process.env.SHELL_BROWSER === 'safari' ? 'safari' : 'chrome';
const profile = browser === 'chrome' ? await mkdtemp(join(tmpdir(), 'shell-viewer-render-')) : null;
// Screenshots live outside the Chrome profile, which is cleaned up below.
const shots = await mkdtemp(join(browser === 'safari' ? '/tmp' : tmpdir(), 'shell-viewer-render-shots-'));
const SESSION_ID = 'viewer-canary-'.padEnd(32, '0');
const BOOTSTRAP_ID = 'virtual:viewer-bootstrap';
// The real index.html loads /web/main.ts; swap that entry for a bootstrap that
// captures the xterm instance and installs a synthetic socket before main.ts
// runs. Bare imports are rewritten by Vite to the same optimized-dep URLs the
// page uses, so the bootstrap and web/main.ts share one @xterm/xterm instance.
const bootstrapPlugin = {
  name: 'viewer-bootstrap',
  transformIndexHtml(html) {
    return html.replace(
      /<script type="module" src="\/web\/main\.ts"><\/script>/,
      `<script type="module" src="/@id/__x00__${BOOTSTRAP_ID}.js"></script>`,
    );
  },
  resolveId(id) {
    return id === BOOTSTRAP_ID ? `\0${BOOTSTRAP_ID}.js` : null;
  },
  load(id) {
    if (id !== `\0${BOOTSTRAP_ID}.js`) return null;
    return `
      import { Terminal } from '@xterm/xterm';
      globalThis.viewerTest = { sockets: [], term: null };
      class FakeSocket extends EventTarget {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = 0;
        binaryType = '';
        sent = [];
        constructor(url) {
          super();
          this.url = String(url);
          globalThis.viewerTest.sockets.push(this);
          queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
        }
        send(data) { this.sent.push(data); }
        close(code) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code: code ?? 1000 })); }
        emitText(text) { this.dispatchEvent(new MessageEvent('message', { data: text })); }
        emitBinary(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
      }
      globalThis.WebSocket = FakeSocket;
      const originalOpen = Terminal.prototype.open;
      Terminal.prototype.open = function (node) {
        globalThis.viewerTest.term = this;
        return originalOpen.call(this, node);
      };
      await import('/web/main.ts');
    `;
  },
};
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [bootstrapPlugin],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent',
});
let transport;
const waitFor = async (check, label) => {
  const end = Date.now() + 20000;
  let lastError;
  while (Date.now() < end) {
    try { if (await check()) return; lastError = null; }
    catch (error) { lastError = error; /* transient state (e.g. mid-navigation); retry */ }
    await delay(50);
  }
  // lastError messages are fixed-format from the transport, never raw page text.
  throw new Error(lastError ? `Timed out: ${label} (${lastError.message})` : `Timed out: ${label}`);
};
const evaluate = (expression) => transport.evaluate(expression);
async function screenshot(name) {
  // Chrome clips to the terminal; Safari captures the full viewport (the
  // on-screen visibility check above already proved the terminal is inside it).
  const clip = `(() => {
    const r = document.getElementById('terminal').getBoundingClientRect();
    const x = Math.max(0, r.x - 8), y = Math.max(0, r.y - 8);
    return { x, y, width: Math.min(innerWidth - x, r.width + 16), height: Math.min(innerHeight - y, r.height + 16), scale: 1 };
  })()`;
  const data = await transport.screenshot(browser === 'chrome' ? clip : undefined);
  const path = join(shots, name);
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(`screenshot: ${path}`);
  if (browser === 'safari') {
    // Documented Safari-only accommodation: <=4/channel tolerance around
    // RGB(0,255,0), alpha 255, inside the terminal ROI (screenshot color
    // management, not a proven product defect).
    const green = await evaluate(safariGreenPaintCheck('terminal', data));
    console.log(`${name}: green paint ${green.count}px in terminal ROI, observed ${JSON.stringify(green.observed)}`);
    assert.ok(green.count >= 50, `${name}: ${green.count} green-tolerant pixels, expected >= 50 from the synthetic truecolor block`);
    return;
  }
  const green = await evaluate(`(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('png decode')); img.src = 'data:image/png;base64,' + ${JSON.stringify(data)}; });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] === 0 && px[i + 1] === 255 && px[i + 2] === 0) n++;
    return n;
  })()`);
  assert.ok(green >= 50, `${name}: ${green} exact green pixels, expected >= 50 from the synthetic truecolor block`);
}
// `cols` x `rows` grid: corner markers, explicit black background blocks
// (ESC[40m), and a 40-space truecolor green block (ESC[48;2;0;255;0m). When
// `trail` is set every line ends with CRLF, leaving the cursor on the next line.
const ESC = String.fromCharCode(27);
const CRLF = String.fromCharCode(13, 10);
function gridScript({ cols, rows, trail, corners, black, green }) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = ' '.repeat(cols);
    const put = (c, ch) => { line = line.slice(0, c) + ch + line.slice(c + 1); };
    for (const [cr, cc, ch] of corners) if (cr === r) put(cc, ch);
    const block = black.find(([br]) => br === r);
    if (block) line = line.slice(0, block[1]) + ESC + '[40m' + ' '.repeat(block[2]) + ESC + '[0m' + line.slice(block[1] + block[2]);
    if (green && green[0] === r) line = line.slice(0, green[1]) + ESC + '[48;2;0;255;0m' + ' '.repeat(40) + ESC + '[0m' + line.slice(green[1] + 40);
    lines.push(line + (trail ? CRLF : ''));
  }
  return lines.join(trail ? '' : CRLF);
}
function frameScript(opcode, text) {
  return `(() => {
    const payload = new TextEncoder().encode(${JSON.stringify(text)});
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = ${opcode};
    frame.set(payload, 1);
    viewerTest.sockets[0].emitBinary(frame.buffer);
    return true;
  })()`;
}
const cornersAt = (marks) => `(() => {
  const b = viewerTest.term.buffer.active;
  const at = (r, c) => (b.getLine(r) && b.getLine(r).getCell(c) ? b.getLine(r).getCell(c).getChars() : '');
  return ${marks.map(([r, c, ch]) => `at(${r}, ${c}) === '${ch}'`).join(' && ')};
})()`;
const FIT = `(() => {
  const term = viewerTest.term;
  const s = term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const p = document.getElementById('terminal').getBoundingClientRect();
  return s.width <= p.width + 1 && s.height <= p.height + 1 &&
    s.x >= p.x - 1 && s.y >= p.y - 1 && s.x + s.width <= p.x + p.width + 1 && s.y + s.height <= p.y + p.height + 1;
})()`;
const ONSCREEN = `(() => {
  const c = document.getElementById('terminal');
  const r = c.getBoundingClientRect();
  if (r.x < 0 || r.y < 0 || r.x + r.width > innerWidth || r.y + r.height > innerHeight) return false;
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return top !== null && c.contains(top);
})()`;
const GEOMETRY = `(() => {
  const term = viewerTest.term;
  const s = term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const p = document.getElementById('terminal').getBoundingClientRect();
  return { fontSize: term.options.fontSize, cols: term.cols, rows: term.rows, screen: Math.round(s.width) + 'x' + Math.round(s.height), box: Math.round(p.width) + 'x' + Math.round(p.height) };
})()`;
// The relay picks the grid per device: landscape 120x36, portrait 80x40.
const VIEWS = {
  desktop: { width: 1280, height: 800, mobile: false, cols: 120, rows: 36, resize: { width: 1024, height: 700 } },
  narrow: { width: 480, height: 900, mobile: true, cols: 80, rows: 40, resize: { width: 414, height: 832 } },
};
const SCENARIOS = [];
if (browser === 'safari') {
  // Real hardware DPR and window minimums: no dpr/mobile emulation, and the
  // grid follows the actually measured viewport orientation.
  for (const viewport of ['desktop', 'narrow']) for (const theme of ['light', 'dark']) {
    SCENARIOS.push({ viewport, theme });
  }
} else {
  for (const dpr of [1, 2]) for (const viewport of ['desktop', 'narrow']) for (const theme of ['light', 'dark']) {
    SCENARIOS.push({ dpr, viewport, theme });
  }
}
const label = (s) => (s.dpr ? `dpr${s.dpr}-${s.viewport}-${s.theme}` : `${s.viewport}-${s.theme}`);
const selected = process.argv[2]
  ? SCENARIOS.filter((s) => label(s) === process.argv[2])
  : SCENARIOS;
assert.ok(selected.length > 0, `unknown scenario: ${process.argv[2]}`);
try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = browser === 'safari'
    ? await launchSafariTransport()
    : await launchChromeTransport({ profile });

  for (let i = 0; i < selected.length; i++) {
    const scenario = selected[i];
    const { theme } = scenario;
    const view = VIEWS[scenario.viewport];
    const lbl = label(scenario);
    console.log(`scenario: ${lbl}`);
    let measured;
    if (browser === 'safari') {
      measured = await transport.setViewport({ width: view.width, height: view.height });
      console.log(`safari actual viewport: ${measured.width}x${measured.height} @${measured.dpr}x (requested ${view.width}x${view.height})`);
      await transport.setStorageTheme(`http://127.0.0.1:${port}`, theme);
    } else {
      await transport.setViewport({ width: view.width, height: view.height, dpr: scenario.dpr, mobile: view.mobile });
      await transport.setEmulatedTheme(theme);
    }
    const portrait = browser === 'safari' ? measured.height > measured.width : view.mobile;
    const cols = portrait ? VIEWS.narrow.cols : VIEWS.desktop.cols;
    const rows = portrait ? VIEWS.narrow.rows : VIEWS.desktop.rows;
    const greenRow = Math.floor(rows / 2);
    const greenCol = Math.floor(cols / 2) - 20;
    const SNAP1 = gridScript({
      cols, rows, trail: false,
      corners: [[0, 0, 'A'], [0, cols - 1, 'B'], [rows - 1, 0, 'C'], [rows - 1, cols - 1, 'D']],
      black: [[1, 0, 10], [rows - 2, cols - 10, 10]],
      green: [greenRow, greenCol],
    });
    // rows-1 trailed lines leave the cursor at the last line, where the
    // Output frame lands; the bottom corners sit one line up.
    const SNAP2 = gridScript({
      cols, rows: rows - 1, trail: true,
      corners: [[0, 0, 'E'], [0, cols - 1, 'F'], [rows - 2, 0, 'G'], [rows - 2, cols - 1, 'H']],
      black: [[20, 0, 10]],
      green: [greenRow, greenCol],
    });
    const CORNERS1 = cornersAt([[0, 0, 'A'], [0, cols - 1, 'B'], [rows - 1, 0, 'C'], [rows - 1, cols - 1, 'D']]);
    const CORNERS2 = cornersAt([[0, 0, 'E'], [0, cols - 1, 'F'], [rows - 2, 0, 'G'], [rows - 2, cols - 1, 'H']]);
    // The real index.html, entry swapped for the bootstrap, via the SPA fallback.
    await transport.navigate(`http://127.0.0.1:${port}/s/${SESSION_ID}?run=${i}`);
    await waitFor(() => evaluate(`location.origin === 'http://127.0.0.1:${port}' && document.readyState === 'complete' && performance.getEntriesByType('navigation')[0]?.name.endsWith('/s/${SESSION_ID}?run=${i}')`), 'page load');
    await waitFor(() => evaluate('viewerTest.term && viewerTest.sockets.length === 1 && viewerTest.sockets[0].readyState === 1'), 'terminal open + socket');
    const send = (expression) => evaluate(`(() => { ${expression} })()`);
    const layout = portrait ? 'portrait' : 'landscape';
    assert.ok(await evaluate(`viewerTest.sockets[0].url.includes('/api/sessions/${SESSION_ID}/ws?layout=${layout}')`), `${lbl}: ws url layout`);
    await send(`viewerTest.sockets[0].emitText(JSON.stringify({ type: 'status', status: 'connected', encrypted: false })); true`);
    await send(`viewerTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: ${cols}, rows: ${rows} })); true`);
    await send(frameScript(0x03, SNAP1));
    await waitFor(() => evaluate(CORNERS1), 'snapshot corner markers');
    await waitFor(() => evaluate(`viewerTest.term.cols === ${cols} && viewerTest.term.rows === ${rows}`), 'refit applied');
    await delay(100);
    assert.equal(await evaluate(CORNERS1), true, `${lbl}: corners after first snapshot`);
    assert.equal(await evaluate(FIT), true, `${lbl}: screen fits after first refit`);
    assert.equal(await evaluate('(() => { const c = viewerTest.term.buffer.active.getLine(1).getCell(5); return c.isBgPalette() && c.getBgColor() === 0; })()'), true, `${lbl}: explicit black block`);
    assert.equal(await evaluate(ONSCREEN), true, `${lbl}: terminal visible on-screen before initial screenshot`);
    await screenshot(`${lbl}-initial.png`);
    // Shrink the viewport; the resize path must refit the grid into the box.
    const fontBefore = await evaluate('viewerTest.term.options.fontSize');
    let resized = await transport.setViewport(browser === 'safari'
      ? { width: view.resize.width, height: view.resize.height }
      : { width: view.resize.width, height: view.resize.height, dpr: scenario.dpr, mobile: view.mobile });
    if (browser === 'safari' && resized.width === measured.width && resized.height === measured.height) {
      // Safari window minimums clamped the resize; shrink the height instead.
      resized = await transport.setViewport({ width: measured.width, height: Math.max(320, measured.height - 200) });
    }
    if (browser === 'safari') console.log(`safari resized viewport: ${resized.width}x${resized.height} @${resized.dpr}x`);
    await waitFor(() => evaluate(`viewerTest.term.options.fontSize !== ${fontBefore}`), 'refit after resize');
    await delay(100);
    assert.equal(await evaluate(FIT), true, `${lbl}: screen fits after resize`);
    assert.equal(await evaluate(CORNERS1), true, `${lbl}: corners survive resize`);
    // A second snapshot (cursor left at the last line) plus a live Output frame.
    await send(frameScript(0x03, SNAP2));
    await waitFor(() => evaluate(CORNERS2), 'second snapshot corners');
    await send(frameScript(0x01, 'viewer-ok'));
    await waitFor(() => evaluate(`viewerTest.term.buffer.active.getLine(${rows - 1}).translateToString(true) === 'viewer-ok'`), 'output frame');
    await delay(100);
    assert.equal(await evaluate(FIT), true, `${lbl}: screen fits after second snapshot+output`);
    assert.equal(await evaluate(CORNERS2), true, `${lbl}: second corners intact`);
    assert.equal(await evaluate('(() => { const c = viewerTest.term.buffer.active.getLine(20).getCell(5); return c.isBgPalette() && c.getBgColor() === 0; })()'), true, `${lbl}: second black block`);
    const g = await evaluate(GEOMETRY);
    assert.equal(await evaluate(ONSCREEN), true, `${lbl}: terminal visible on-screen before final screenshot`);
    await screenshot(`${lbl}-final.png`);
    console.log(`PASS ${lbl}: ${g.cols}x${g.rows}, font ${g.fontSize}, screen ${g.screen} inside ${g.box}`);
  }
  console.log(`screenshots in ${shots}`);
} finally {
  await transport?.close();
  await server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
