// Local browser regression: TerminalPane must fit the 120x36 session grid into a
// 350x300 pane without clipping, across desktop/narrow viewports (real mobile
// CSS zoom), DPR 1/2, light/dark, hide/show, resize, and a second
// snapshot+output. Synthetic WebSocket + real CSS, no login or relay.
// SHELL_BROWSER=safari runs the same fixtures through a real safaridriver
// session (no DPR/mobile emulation; the actual measured viewport is logged).
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport, launchSafariTransport, safariGreenPaintCheck } from '../../scripts/lib/browser-transport.mjs';

const browser = process.env.SHELL_BROWSER === 'safari' ? 'safari' : 'chrome';
const profile = browser === 'chrome' ? await mkdtemp(join(tmpdir(), 'shell-terminal-refit-')) : null;
// Screenshots live outside the Chrome profile, which is cleaned up below.
const shots = await mkdtemp(join(browser === 'safari' ? '/tmp' : tmpdir(), 'shell-terminal-refit-shots-'));
const TEST_ENTRY_ID = 'virtual:terminal-refit-test-entry';
const testEntryPlugin = {
  name: 'terminal-refit-test-entry',
  resolveId(id) {
    return id === TEST_ENTRY_ID ? `\0${TEST_ENTRY_ID}.js` : null;
  },
  load(id) {
    if (id !== `\0${TEST_ENTRY_ID}.js`) return null;
    // Bare imports are rewritten by Vite to the same optimized-dep URLs the
    // app uses, so React and @xterm/xterm share one module instance.
    return `
      import * as ReactModule from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserRouter } from 'react-router-dom';
      import { TerminalPane } from '/src/terminal/TerminalPane.tsx';
      import { AuthContext } from '/src/auth/AuthProvider.tsx';
      import { VaultProvider } from '/src/vault/VaultProvider.tsx';
      import { TeamKeyProvider } from '/src/vault/TeamKeyProvider.tsx';
      import { FeedbackProvider } from '/src/feedback/FeedbackProvider.tsx';
      import { Terminal } from '@xterm/xterm';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, BrowserRouter, TerminalPane, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider, Terminal };
    `;
  },
};
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [testEntryPlugin],
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
  // Chrome clips to the fixture; Safari captures the full viewport (the
  // on-screen visibility check above already proved the fixture is inside it).
  const clip = `(() => {
    const r = document.getElementById('refit-test').getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 1 };
  })()`;
  const data = await transport.screenshot(browser === 'chrome' ? clip : undefined);
  const path = join(shots, name);
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(`screenshot: ${path}`);
  if (browser === 'safari') {
    // Documented Safari-only accommodation: <=4/channel tolerance around
    // RGB(0,255,0), alpha 255, inside the fixture ROI (screenshot color
    // management, not a proven product defect).
    const green = await evaluate(safariGreenPaintCheck('refit-test', data));
    console.log(`${name}: green paint ${green.count}px in fixture ROI, observed ${JSON.stringify(green.observed)}`);
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
// The fixture page: real stylesheets via qa.html, synthetic socket, captured xterm.
const SETUP = `
  const {React, createRoot, BrowserRouter, TerminalPane, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider, Terminal} = await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  // The signed-in QA app in #root is unrelated to this fixture; hide it so the
  // screenshots show the pane on a plain background, not over the app UI.
  document.getElementById('root').style.display = 'none';
  globalThis.refitTest = { sockets: [], term: null };
  class FakeSocket extends EventTarget {
    readyState = 0;
    binaryType = '';
    sent = [];
    constructor(url) {
      super();
      this.url = url;
      globalThis.refitTest.sockets.push(this);
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
    globalThis.refitTest.term = this;
    return originalOpen.call(this, node);
  };
  const auth = {
    mode: 'firebase',
    user: { uid: 'refit-test', email: 'refit@test', displayName: 'Refit', emailVerified: true, providerData: [] },
    initializing: false,
    signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {},
    signInWithProvider: async () => {}, resetPassword: async () => {}, resendVerification: async () => {},
    signOutUser: async () => {}, deleteAccount: async () => {},
  };
  const container = document.createElement('div');
  container.id = 'refit-test';
  container.style.cssText = 'position: fixed; top: 8px; left: 8px; z-index: 2147483647; width: 350px; height: 300px;';
  document.body.append(container);
  window.scrollTo(0, 0);
  const shareUrl = location.origin + '/s/' + 'a'.repeat(32);
  const tree = (active) => React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(BrowserRouter, null,
      React.createElement(VaultProvider, null,
        React.createElement(TeamKeyProvider, null,
          React.createElement(FeedbackProvider, null,
            React.createElement(TerminalPane, { shareUrl, active, renderer: 'xterm' })
          )
        )
      )
    )
  );
  const root = createRoot(container);
  root.render(tree(true));
  globalThis.refitTest.setActive = (active) => root.render(tree(active));
`;
// 120 columns, `rows` lines, corner markers, explicit black background blocks,
// and a 40-space truecolor green block (ESC[48;2;0;255;0m) on an empty middle row.
// When `trail` is set every line ends with CRLF, leaving the cursor on the next line.
const ESC = String.fromCharCode(27);
const CRLF = String.fromCharCode(13, 10);
function gridScript({ rows, trail, corners, black, green }) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = ' '.repeat(120);
    const put = (c, ch) => { line = line.slice(0, c) + ch + line.slice(c + 1); };
    for (const [cr, cc, ch] of corners) if (cr === r) put(cc, ch);
    const block = black.find(([br]) => br === r);
    if (block) line = line.slice(0, block[1]) + ESC + '[40m' + ' '.repeat(block[2]) + ESC + '[0m' + line.slice(block[1] + block[2]);
    if (green && green[0] === r) line = line.slice(0, green[1]) + ESC + '[48;2;0;255;0m' + ' '.repeat(40) + ESC + '[0m' + line.slice(green[1] + 40);
    lines.push(line + (trail ? CRLF : ''));
  }
  return lines.join(trail ? '' : CRLF);
}
const SNAP1 = gridScript({
  rows: 36, trail: false,
  corners: [[0, 0, 'A'], [0, 119, 'B'], [35, 0, 'C'], [35, 119, 'D']],
  black: [[1, 0, 10], [34, 110, 10]],
  green: [17, 40],
});
// 35 trailed lines leave the cursor at line 35, where the Output frame lands.
const SNAP2 = gridScript({
  rows: 35, trail: true,
  corners: [[0, 0, 'E'], [0, 119, 'F'], [34, 0, 'G'], [34, 119, 'H']],
  black: [[20, 0, 10]],
  green: [17, 40],
});
function frameScript(opcode, text) {
  return `(() => {
    const payload = new TextEncoder().encode(${JSON.stringify(text)});
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = ${opcode};
    frame.set(payload, 1);
    refitTest.sockets[0].emitBinary(frame.buffer);
    return true;
  })()`;
}
const cornersAt = (rows, marks) => `(() => {
  const b = refitTest.term.buffer.active;
  const at = (r, c) => (b.getLine(r) && b.getLine(r).getCell(c) ? b.getLine(r).getCell(c).getChars() : '');
  return ${marks.map(([r, c, ch]) => `at(${r}, ${c}) === '${ch}'`).join(' && ')};
})()`;
const CORNERS1 = cornersAt(36, [[0, 0, 'A'], [0, 119, 'B'], [35, 0, 'C'], [35, 119, 'D']]);
const CORNERS2 = cornersAt(35, [[0, 0, 'E'], [0, 119, 'F'], [34, 0, 'G'], [34, 119, 'H']]);
const FIT = `(() => {
  const term = refitTest.term;
  const s = term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const p = document.querySelector('#refit-test .pane-screen').getBoundingClientRect();
  return s.width <= p.width + 1 && s.height <= p.height + 1 &&
    s.x >= p.x - 1 && s.y >= p.y - 1 && s.x + s.width <= p.x + p.width + 1 && s.y + s.height <= p.y + p.height + 1;
})()`;
const ONSCREEN = `(() => {
  const c = document.getElementById('refit-test');
  const r = c.getBoundingClientRect();
  if (r.x < 0 || r.y < 0 || r.x + r.width > innerWidth || r.y + r.height > innerHeight) return false;
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return top !== null && c.contains(top);
})()`;
const GEOMETRY = `(() => {
  const term = refitTest.term;
  const s = term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const p = document.querySelector('#refit-test .pane-screen').getBoundingClientRect();
  return { fontSize: term.options.fontSize, cols: term.cols, rows: term.rows, screen: Math.round(s.width) + 'x' + Math.round(s.height), pane: Math.round(p.width) + 'x' + Math.round(p.height) };
})()`;
const VIEWS = {
  desktop: { width: 1280, height: 800, mobile: false },
  narrow: { width: 480, height: 900, mobile: true },
};
const SCENARIOS = [];
if (browser === 'safari') {
  // Real hardware DPR and window minimums: no dpr/mobile emulation.
  for (const viewport of ['desktop', 'narrow']) for (const theme of ['light', 'dark']) {
    SCENARIOS.push({ viewport, theme });
  }
} else {
  for (const dpr of [1, 2]) for (const viewport of ['desktop', 'narrow']) for (const theme of ['light', 'dark']) {
    SCENARIOS.push({ dpr, viewport, theme });
  }
}
try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = browser === 'safari'
    ? await launchSafariTransport()
    : await launchChromeTransport({ profile });

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    const { theme } = scenario;
    const view = VIEWS[scenario.viewport];
    const label = scenario.dpr ? `dpr${scenario.dpr}-${scenario.viewport}-${theme}` : `${scenario.viewport}-${theme}`;
    console.log(`scenario: ${label}`);
    if (browser === 'safari') {
      const measured = await transport.setViewport({ width: view.width, height: view.height });
      console.log(`safari actual viewport: ${measured.width}x${measured.height} @${measured.dpr}x (requested ${view.width}x${view.height})`);
    } else {
      await transport.setViewport({ width: view.width, height: view.height, dpr: scenario.dpr, mobile: view.mobile });
    }
    // qa.html loads the app's real stylesheets; a fresh document per scenario.
    await transport.navigate(`http://127.0.0.1:${port}/qa.html?run=${i}`);
    // The app's router history-replaces to /login, but the original navigation
    // URL stays in the timing entry, so it proves a fresh document per scenario.
    await waitFor(() => evaluate(`location.origin === 'http://127.0.0.1:${port}' && document.readyState === 'complete' && performance.getEntriesByType('navigation')[0]?.name.endsWith('/qa.html?run=${i}')`), 'page load');
    await evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
    await evaluate(`(async () => { ${SETUP} })()`);
    await waitFor(() => evaluate('refitTest.term && refitTest.sockets.length === 1 && refitTest.sockets[0].readyState === 1'), 'terminal open');
    const send = (expression) => evaluate(`(() => { ${expression} })()`);
    await send(`refitTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: 120, rows: 36 })); true`);
    await send(frameScript(0x03, SNAP1));
    await waitFor(() => evaluate(CORNERS1), 'snapshot corner markers');
    await waitFor(() => evaluate('refitTest.term.options.fontSize !== 13'), 'refit applied');
    await delay(100);
    assert.equal(await evaluate(CORNERS1), true, `${label}: corners after first snapshot`);
    assert.equal(await evaluate(FIT), true, `${label}: screen fits after first refit`);
    assert.equal(await evaluate('(() => { const c = refitTest.term.buffer.active.getLine(1).getCell(5); return c.isBgPalette() && c.getBgColor() === 0; })()'), true, `${label}: explicit black block`);
    assert.equal(await evaluate(ONSCREEN), true, `${label}: fixture visible on-screen before initial screenshot`);
    await screenshot(`${label}-initial.png`);
    // Hide the pane (active=false keeps it mounted, visibility hidden), then show it.
    await send('refitTest.setActive(false); true');
    await waitFor(() => evaluate(`document.querySelector('#refit-test .pane').dataset.active === 'false'`), 'pane hidden');
    await send('refitTest.setActive(true); true');
    await waitFor(() => evaluate(`document.querySelector('#refit-test .pane').dataset.active === 'true'`), 'pane shown');
    await delay(150);
    assert.equal(await evaluate(FIT), true, `${label}: screen fits after hide/show`);
    assert.equal(await evaluate(CORNERS1), true, `${label}: corners survive hide/show`);
    // Resize the container; the ResizeObserver must refit into the new box.
    await send(`document.getElementById('refit-test').style.width = '320px'; document.getElementById('refit-test').style.height = '260px'; true`);
    await waitFor(() => evaluate(FIT), 'refit after resize');
    assert.equal(await evaluate(CORNERS1), true, `${label}: corners survive resize`);
    // A second snapshot (cursor left at line 35) plus a live Output frame.
    await send(frameScript(0x03, SNAP2));
    await waitFor(() => evaluate(CORNERS2), 'second snapshot corners');
    await send(frameScript(0x01, 'refit-ok'));
    await waitFor(() => evaluate(`refitTest.term.buffer.active.getLine(35).translateToString(true) === 'refit-ok'`), 'output frame');
    await delay(100);
    assert.equal(await evaluate(FIT), true, `${label}: screen fits after second snapshot+output`);
    assert.equal(await evaluate(CORNERS2), true, `${label}: second corners intact`);
    assert.equal(await evaluate('(() => { const c = refitTest.term.buffer.active.getLine(20).getCell(5); return c.isBgPalette() && c.getBgColor() === 0; })()'), true, `${label}: second black block`);
    const g = await evaluate(GEOMETRY);
    assert.equal(await evaluate(ONSCREEN), true, `${label}: fixture visible on-screen before final screenshot`);
    await screenshot(`${label}-final.png`);
    console.log(`PASS ${label}: ${g.cols}x${g.rows}, font ${g.fontSize}, screen ${g.screen} inside ${g.pane}`);
  }
  console.log(`screenshots in ${shots}`);
} finally {
  await transport?.close();
  await server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
