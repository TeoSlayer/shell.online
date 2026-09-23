// Local browser regression: a finger dragged over a TerminalPane on a phone
// must scroll it the way a mouse wheel does on a desktop. Scrollback moves in
// the normal buffer, a mouse-tracking TUI receives wheel reports, a tap still
// focuses without scrolling, and the chat renderer keeps its native scroll.
// Trusted touch input through CDP, synthetic WebSocket, real CSS, no relay.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const profile = await mkdtemp(join(tmpdir(), 'shell-touch-scroll-'));
const TEST_ENTRY_ID = 'virtual:terminal-touch-test-entry';
const testEntryPlugin = {
  name: 'terminal-touch-test-entry',
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
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* mid-navigation; retry */ }
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
};
const evaluate = (expression) => transport.evaluate(expression);

const setup = (renderer) => `
  const {React, createRoot, BrowserRouter, TerminalPane, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider, Terminal} = await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  document.getElementById('root').style.display = 'none';
  globalThis.touchTest = { sockets: [], term: null };
  class FakeSocket extends EventTarget {
    readyState = 0;
    binaryType = '';
    sent = [];
    constructor(url) {
      super();
      this.url = url;
      globalThis.touchTest.sockets.push(this);
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
    globalThis.touchTest.term = this;
    return originalOpen.call(this, node);
  };
  const auth = {
    mode: 'firebase',
    user: { uid: 'touch-test', email: 'touch@test', displayName: 'Touch', emailVerified: true, providerData: [] },
    initializing: false,
    signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {},
    signInWithProvider: async () => {}, resetPassword: async () => {}, resendVerification: async () => {},
    signOutUser: async () => {}, deleteAccount: async () => {},
  };
  const container = document.createElement('div');
  container.id = 'touch-test';
  container.style.cssText = 'position: fixed; top: 60px; left: 0; right: 0; bottom: 0; z-index: 2147483647;';
  document.body.append(container);
  const shareUrl = location.origin + '/s/' + 'a'.repeat(32);
  const root = createRoot(container);
  root.render(React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(BrowserRouter, null,
      React.createElement(VaultProvider, null,
        React.createElement(TeamKeyProvider, null,
          React.createElement(FeedbackProvider, null,
            React.createElement(TerminalPane, { shareUrl, active: true, renderer: ${JSON.stringify(renderer)} })
          )
        )
      )
    )
  ));
`;

function frameScript(opcode, text) {
  return `(() => {
    const payload = new TextEncoder().encode(${JSON.stringify(text)});
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = ${opcode};
    frame.set(payload, 1);
    touchTest.sockets[0].emitBinary(frame.buffer);
    return true;
  })()`;
}

// Everything typed into the session so far, decoded from Input frames.
const SENT_INPUT = `(() => touchTest.sockets[0].sent.map((data) => {
  const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer ?? data);
  return bytes[0] === 0x02 ? new TextDecoder().decode(bytes.subarray(1)) : '';
}).join(''))()`;

const HISTORY = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, '0')}`).join('\r\n');

// A slow drag: a finger held and moved in small steps, the way a person reads
// through scrollback. dy > 0 moves the finger down, which scrolls back in time.
async function drag(dy, { steps = 12, pause = 24 } = {}) {
  const box = await evaluate(`(() => {
    const r = document.querySelector('#touch-test .pane-screen').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const startY = box.y - Math.round(dy / 2);
  await transport.touch('touchStart', [{ x: box.x, y: startY }]);
  for (let i = 1; i <= steps; i++) {
    await delay(pause);
    await transport.touch('touchMove', [{ x: box.x, y: startY + Math.round(dy * i / steps) }]);
  }
  // Held still before lifting, so a fling does not muddy the measurement.
  await delay(150);
  await transport.touch('touchMove', [{ x: box.x, y: startY + dy }]);
  await transport.touch('touchEnd', []);
  await delay(100);
}

async function tap() {
  const box = await evaluate(`(() => {
    const r = document.querySelector('#touch-test .pane-screen').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await transport.touch('touchStart', [{ x: box.x, y: box.y }]);
  await delay(40);
  await transport.touch('touchEnd', []);
  await delay(150);
}

async function open(renderer, run) {
  await transport.navigate(`http://127.0.0.1:${port}/qa.html?touch=${renderer}-${run}`);
  await waitFor(() => evaluate(`document.readyState === 'complete' && performance.getEntriesByType('navigation')[0]?.name.endsWith('touch=${renderer}-${run}')`), 'page load');
  await evaluate(`(async () => { ${setup(renderer)} })()`);
  await waitFor(() => evaluate('touchTest.sockets.length === 1 && touchTest.sockets[0].readyState === 1'), 'socket open');
  await evaluate(`(() => { touchTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: 80, rows: 40 })); return true; })()`);
}

let port;
try {
  await server.listen();
  port = server.httpServer.address().port;
  transport = await launchChromeTransport({ profile });
  await transport.setViewport({ width: 390, height: 844, dpr: 3, mobile: true });
  await transport.enableTouch();

  // xterm, normal buffer: a drag moves through scrollback.
  {
    await open('xterm', 1);
    await evaluate(frameScript(0x03, HISTORY));
    await waitFor(() => evaluate('touchTest.term.buffer.active.baseY > 300'), 'history written');
    const base = await evaluate('touchTest.term.buffer.active.baseY');
    assert.equal(await evaluate('touchTest.term.buffer.active.viewportY'), base, 'xterm starts at the bottom');
    await drag(300);
    const back = await evaluate('touchTest.term.buffer.active.viewportY');
    assert.ok(back < base - 5, `xterm: dragging down scrolls back (viewportY ${back}, bottom ${base})`);
    await drag(-200);
    const forward = await evaluate('touchTest.term.buffer.active.viewportY');
    assert.ok(forward > back, `xterm: dragging up scrolls forward (viewportY ${forward}, was ${back})`);
    console.log(`PASS xterm scrollback: bottom ${base} -> ${back} -> ${forward}`);

    // A tap is not a scroll, and still gives the terminal the keyboard.
    const before = await evaluate('touchTest.term.buffer.active.viewportY');
    await evaluate('(() => { document.activeElement?.blur(); return true; })()');
    await tap();
    assert.equal(await evaluate('touchTest.term.buffer.active.viewportY'), before, 'xterm: a tap does not scroll');
    assert.equal(await evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea') ?? false`), true, 'xterm: a tap focuses the terminal');
    console.log('PASS xterm tap focuses without scrolling');

    // A flick keeps going after the finger lifts.
    const flickStart = await evaluate('touchTest.term.buffer.active.viewportY');
    const box = await evaluate(`(() => { const r = document.querySelector('#touch-test .pane-screen').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await transport.flick({ x: box.x, y: box.y - 60, yDistance: 120, speed: 1500 });
    const lifted = await evaluate('touchTest.term.buffer.active.viewportY');
    await delay(800);
    const settled = await evaluate('touchTest.term.buffer.active.viewportY');
    assert.ok(lifted < flickStart, `xterm: a flick scrolls back (${flickStart} -> ${lifted})`);
    assert.ok(settled < lifted, `xterm: a flick coasts after lift (${flickStart} -> ${lifted} -> ${settled})`);
    console.log(`PASS xterm flick coasts: ${flickStart} -> ${lifted} -> ${settled}`);
  }

  // xterm, a full-screen TUI with SGR mouse tracking: a drag reaches the
  // program as wheel reports, which is how it scrolls its own view.
  {
    await open('xterm', 2);
    await evaluate(frameScript(0x03, '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[Hfull screen app'));
    await waitFor(() => evaluate(`touchTest.term.buffer.active.type === 'alternate' && touchTest.term.modes.mouseTrackingMode !== 'none'`), 'mouse mode on');
    await drag(240);
    const up = await evaluate(SENT_INPUT);
    assert.match(up, /\x1b\[<64;\d+;\d+M/, 'TUI: dragging down sends wheel-up reports');
    await drag(-240);
    const down = await evaluate(SENT_INPUT);
    assert.match(down, /\x1b\[<65;\d+;\d+M/, 'TUI: dragging up sends wheel-down reports');
    console.log(`PASS xterm TUI wheel reports: ${(down.match(/\x1b\[<6[45];/g) ?? []).length} sent`);
  }

  // xterm, the alternate screen without mouse reporting (less, man, vim by
  // default): a wheel there is arrow keys, and so is a drag.
  {
    await open('xterm', 5);
    await evaluate(frameScript(0x03, '\x1b[?1049h\x1b[Hpager'));
    await waitFor(() => evaluate(`touchTest.term.buffer.active.type === 'alternate' && touchTest.term.modes.mouseTrackingMode === 'none'`), 'alternate screen on');
    await drag(240);
    const keys = await evaluate(SENT_INPUT);
    assert.match(keys, /\x1b\[A/, 'pager: dragging down sends arrow-up keys');
    assert.doesNotMatch(keys, /\x1b\[B/, 'pager: and no arrow-down keys');
    console.log(`PASS xterm alternate screen arrow keys: ${(keys.match(/\x1b\[A/g) ?? []).length} sent`);
  }

  // refstream, normal buffer: the same drag moves its scrollback.
  {
    await open('refstream', 3);
    await waitFor(() => evaluate(`!!document.querySelector('#touch-test .shell-terminal')`), 'refstream mounted');
    await evaluate(frameScript(0x03, HISTORY));
    const SCROLLER = `[...document.querySelectorAll('#touch-test .shell-terminal *')].find((el) => el.scrollHeight > el.clientHeight + 50 && getComputedStyle(el).overflowY !== 'visible')`;
    await waitFor(() => evaluate(`(() => { const el = ${SCROLLER}; return !!el && el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 4; })()`), 'refstream history at bottom');
    const bottom = await evaluate(`(${SCROLLER}).scrollTop`);
    await drag(300);
    const back = await evaluate(`(${SCROLLER}).scrollTop`);
    assert.ok(back < bottom - 20, `refstream: dragging down scrolls back (scrollTop ${back}, bottom ${bottom})`);
    console.log(`PASS refstream scrollback: scrollTop ${bottom} -> ${back}`);
  }

  // chat: a conversation is an ordinary scrolling list and keeps the
  // browser's own touch scrolling; the adapter must stay out of its way.
  {
    await open('chat', 4);
    const touchAction = await evaluate(`getComputedStyle(document.querySelector('#touch-test .pane-screen')).touchAction`);
    assert.notEqual(touchAction, 'none', 'chat: native touch scrolling is left on');
    console.log(`PASS chat keeps native scrolling (touch-action: ${touchAction})`);
  }
} finally {
  await transport?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
