// Browser regression for the adaptive renderer: the real TerminalPane, the
// real stylesheets, a synthetic WebSocket, and a session captured from Claude
// Code at 120x36 (src/terminal/adaptive/fixtures). It checks what a person
// sees: a narrow pane lays the session out at a legible size instead of
// shrinking 120 columns into it, a wide pane draws the grid whole, the view is
// the same after resizing away and back, and the owner's "Fit to my screen"
// asks for this pane's grid and nothing else.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const profile = await mkdtemp(join(tmpdir(), 'shell-terminal-adaptive-'));
const shots = await mkdtemp(join(tmpdir(), 'shell-terminal-adaptive-shots-'));
const TEST_ENTRY_ID = 'virtual:terminal-adaptive-test-entry';
const testEntryPlugin = {
  name: 'terminal-adaptive-test-entry',
  resolveId(id) {
    return id === TEST_ENTRY_ID ? `\0${TEST_ENTRY_ID}.js` : null;
  },
  load(id) {
    if (id !== `\0${TEST_ENTRY_ID}.js`) return null;
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
    catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(lastError ? `Timed out: ${label} (${lastError.message})` : `Timed out: ${label}`);
};
const evaluate = (expression) => transport.evaluate(expression);

// The pane, mounted as the owner, with the canvas captured when xterm opens it.
const SETUP = `
  const {React, createRoot, BrowserRouter, TerminalPane, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider, Terminal} = await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  document.getElementById('root').style.display = 'none';
  globalThis.adaptiveTest = { sockets: [], canvas: null };
  class FakeSocket extends EventTarget {
    readyState = 0;
    binaryType = '';
    sent = [];
    constructor(url) {
      super();
      this.url = url;
      globalThis.adaptiveTest.sockets.push(this);
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
    globalThis.adaptiveTest.canvas = this;
    return originalOpen.call(this, node);
  };
  const auth = {
    mode: 'firebase',
    user: { uid: 'adaptive-test', email: 'adaptive@test', displayName: 'Adaptive', emailVerified: true, providerData: [] },
    initializing: false,
    signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {},
    signInWithProvider: async () => {}, resetPassword: async () => {}, resendVerification: async () => {},
    signOutUser: async () => {}, deleteAccount: async () => {},
  };
  const container = document.createElement('div');
  container.id = 'adaptive-test';
  container.style.cssText = 'position: fixed; top: 0; left: 0; z-index: 2147483647; width: ' + innerWidth + 'px; height: ' + (innerHeight - 40) + 'px;';
  document.body.append(container);
  const shareUrl = location.origin + '/s/' + 'a'.repeat(32);
  const tree = React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(BrowserRouter, null,
      React.createElement(VaultProvider, null,
        React.createElement(TeamKeyProvider, null,
          React.createElement(FeedbackProvider, null,
            React.createElement(TerminalPane, { shareUrl, active: true, canResize: true, renderer: 'adaptive' })
          )
        )
      )
    )
  );
  createRoot(container).render(tree);
  const { capture: captured } = await import('/src/terminal/adaptive/fixtures/captures.ts');
  const capture = captured('claude');
  globalThis.adaptiveTest.snapshot = () => {
    const frame = new Uint8Array(capture.byteLength + 1);
    frame[0] = 0x03;
    frame.set(capture, 1);
    globalThis.adaptiveTest.sockets[0].emitBinary(frame.buffer);
  };
  globalThis.adaptiveTest.rows = () => {
    const canvas = globalThis.adaptiveTest.canvas;
    const buffer = canvas.buffer.active;
    const rows = [];
    for (let y = 0; y < canvas.rows; y += 1) rows.push((buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').replace(/\\s+$/u, ''));
    return rows;
  };
  globalThis.adaptiveTest.size = (width) => { container.style.width = width + 'px'; };
`;

const FITS = `(() => {
  const canvas = adaptiveTest.canvas;
  const s = canvas.element.querySelector('.xterm-screen').getBoundingClientRect();
  const p = document.querySelector('#adaptive-test .pane-screen').getBoundingClientRect();
  return s.width <= p.width + 1 && s.height <= p.height + 1 && s.x >= p.x - 1 && s.y >= p.y - 1;
})()`;
const STATE = `(() => {
  const canvas = adaptiveTest.canvas;
  return { cols: canvas.cols, rows: canvas.rows, fontSize: canvas.options.fontSize, fit: !!document.querySelector('#adaptive-test .pane-fit') };
})()`;

const VIEWS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];

try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = await launchChromeTransport({ profile });
  let run = 0;
  for (const dpr of [1, 2]) for (const view of VIEWS) {
    const label = `dpr${dpr}-${view.name}`;
    await transport.setViewport({ width: view.width, height: view.height, dpr, mobile: view.mobile });
    await transport.navigate(`http://127.0.0.1:${port}/qa.html?run=${run += 1}`);
    await waitFor(() => evaluate(`document.readyState === 'complete' && performance.getEntriesByType('navigation')[0]?.name.endsWith('/qa.html?run=${run}')`), 'page load');
    await evaluate(`(async () => { ${SETUP} })()`);
    await waitFor(() => evaluate('adaptiveTest.canvas && adaptiveTest.sockets.length === 1 && adaptiveTest.sockets[0].readyState === 1'), 'terminal open');
    await evaluate(`(() => { adaptiveTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: 120, rows: 36, dynamic: true })); adaptiveTest.snapshot(); return true; })()`);
    await waitFor(() => evaluate(`adaptiveTest.rows().some((row) => row.includes('Cogitated for 13s'))`), 'session drawn');
    await delay(150);

    const state = await evaluate(STATE);
    const rows = await evaluate('adaptiveTest.rows()');
    assert.equal(await evaluate(FITS), true, `${label}: the canvas is inside the pane`);
    for (const row of rows) assert.ok(row.length <= state.cols, `${label}: no row is wider than the canvas`);
    if (view.name === 'phone') {
      assert.ok(state.cols < 120, `${label}: a phone lays the session out rather than shrinking 120 columns (${state.cols})`);
      assert.ok(state.fontSize >= 11, `${label}: legible text (${state.fontSize}px)`);
      const prose = rows.join(' ').replace(/\s+/gu, ' ');
      assert.ok(prose.includes('A pseudo-terminal (PTY) is a pair of'), `${label}: the answer is rewrapped, not cut`);
      assert.equal(state.fit, true, `${label}: the owner is offered their own grid`);
    } else {
      assert.equal(state.cols, 120, `${label}: a wide pane draws the grid whole`);
      assert.equal(state.rows, 36, `${label}: all 36 rows`);
    }

    // Resizing away and back is the same view: layout is a function of the pane.
    const before = JSON.stringify({ rows, state });
    await evaluate(`adaptiveTest.size(${Math.round(view.width * 0.55)}), true`);
    await delay(200);
    await evaluate(`adaptiveTest.size(${view.width}), true`);
    await delay(250);
    assert.equal(JSON.stringify({ rows: await evaluate('adaptiveTest.rows()'), state: await evaluate(STATE) }), before, `${label}: same view after resizing away and back`);

    // The same grid announced again changes nothing and sends nothing.
    const sentBefore = await evaluate('adaptiveTest.sockets[0].sent.length');
    await evaluate(`(() => { adaptiveTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: 120, rows: 36, dynamic: true })); return true; })()`);
    await delay(150);
    assert.equal(await evaluate('adaptiveTest.sockets[0].sent.length'), sentBefore, `${label}: a repeated grid sends nothing`);
    assert.equal(JSON.stringify(await evaluate('adaptiveTest.rows()')), JSON.stringify(rows), `${label}: a repeated grid redraws nothing`);

    const data = await transport.screenshot();
    await writeFile(join(shots, `${label}.png`), Buffer.from(data, 'base64'));

    if (state.fit) {
      await evaluate(`document.querySelector('#adaptive-test .pane-fit').click(), true`);
      const requests = await evaluate(`adaptiveTest.sockets[0].sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m)).filter((m) => m.type === 'grid_request')`);
      assert.equal(requests.length, 1, `${label}: one click, one request`);
      const [request] = requests;
      /* Laid out, the pane's grid is what it is drawing; drawn whole, it is what the pane would lay out. */
      if (view.name === 'phone') assert.deepEqual(request, { type: 'grid_request', cols: state.cols, rows: state.rows }, `${label}: fit asks for this pane's grid`);
      else assert.ok(request.cols > 120 && request.rows > 36, `${label}: a wide pane asks for more than the session has (${request.cols}x${request.rows})`);
      // The host takes it: the pane now draws that grid whole and stops offering.
      await evaluate(`(() => { adaptiveTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: ${request.cols}, rows: ${request.rows}, dynamic: true })); return true; })()`);
      await waitFor(() => evaluate(`!document.querySelector('#adaptive-test .pane-fit')`), 'fit offer withdrawn');
      const after = await evaluate(STATE);
      assert.deepEqual([after.cols, after.rows], [request.cols, request.rows], `${label}: the fitted grid is drawn whole`);
    }
    console.log(`PASS ${label}: ${state.cols}x${state.rows} at ${state.fontSize}px for a 120x36 session${state.fit ? ', fit offered and applied' : ''}`);
  }
  console.log(`screenshots in ${shots}`);
} finally {
  await transport?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
