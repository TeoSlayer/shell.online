// Local browser regression: terminal wheel scrolling in both viewers.
//
// The v0.21.3 stateful-snapshot work changed how the viewer's terminal is
// reset and refed, and a restored session can carry mouse-tracking modes.
// This fixture separates the two scroll paths that must both keep working:
//
//   local scrollback  — normal buffer, no mouse mode: the wheel scrolls the
//                       viewer's own scrollback, and a read-only/locked
//                       viewer must still be able to read its history;
//   TUI mouse report  — alternate screen with mouse tracking: the wheel is
//                       reported to the PTY (SGR 1006 as text, legacy 1000
//                       as binary), never as local scrollback.
//
// Synthetic WebSocket + real xterm + real CSS; no relay, login, or deploy.
// SHELL_BROWSER=safari runs the same probes through safaridriver.
// SHELL_SCROLL_PART=app|standalone|both selects a single viewer (default both).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport, launchSafariTransport } from './lib/browser-transport.mjs';

const browser = process.env.SHELL_BROWSER === 'safari' ? 'safari' : 'chrome';
const newProfile = () => (browser === 'chrome' ? mkdtemp(join(tmpdir(), 'shell-scroll-')) : Promise.resolve(null));
const part = process.env.SHELL_SCROLL_PART ?? 'both';
const SESSION_ID = 'scroll-canary-'.padEnd(32, '0');

const failures = [];
const check = (probe, report, verdict) => {
  // A probe is authoritative: a failed precondition (out.errors) is a failure
  // even when the assertion itself held. No PASS with errors.
  const preconditionsFailed = (report.errors?.length ?? 0) > 0;
  if (verdict && !preconditionsFailed) {
    console.log(`PASS ${probe}${report.detail ? ` (${report.detail})` : ''}`);
  } else {
    failures.push(probe);
    const reason = report.errors?.join('; ')
      ?? report.error
      ?? (preconditionsFailed ? 'precondition failed' : 'assertion failed');
    console.error(`FAIL ${probe}: ${reason}`);
  }
};

/*
 * One in-page probe runner for both viewers. cfg:
 *   termKey    — key into scrollTest.terms (standalone: 'standalone')
 *   lines      — how many output lines to feed before the wheel
 *   mouse      — DEC private mode sequence to send (e.g. alt screen + mouse)
 *   wantMouse  — the term.modes.mouseTrackingMode to wait for
 *   control    — a control message object to emit as text
 *   wheel      — deltaY to dispatch on the terminal screen
 *   wantReport — true: expect a mouse report frame; false: expect the local
 *                scrollback viewport to move past viewportBefore
 */
const runProbe = async (cfg) => {
  const T = globalThis.scrollTest;
  const term = T.terms[cfg.termKey];
  if (!term) return { error: 'terminal not found' };
  const sock = T.sockets.find((s) => s.url.includes(cfg.sockId));
  if (!sock) return { error: 'socket not found' };
  const screen = term.element.querySelector('.xterm-screen');
  if (!screen) return { error: 'screen not found' };
  const out = {
    rows: term.rows,
    cols: term.cols,
    bufferType: term.buffer.active.type,
    mouse: term.modes.mouseTrackingMode,
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (checkFn, label, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (checkFn()) return true;
      await wait(50);
    }
    out.errors = out.errors || [];
    out.errors.push(label);
    return false;
  };
  const send = (text) => {
    const payload = new TextEncoder().encode(text);
    const frame = new Uint8Array(payload.byteLength + 1);
    frame[0] = 1; // Opcode.Output
    frame.set(payload, 1);
    sock.emitBinary(frame.buffer);
  };
  const sendControl = (obj) => sock.emitText(JSON.stringify(obj));
  // The wheel must carry in-bounds client coords: xterm derives the report
  // cell from clientX/clientY, and (0,0) is outside the screen.
  const wheel = (deltaY) => {
    const rect = screen.getBoundingClientRect();
    const event = new WheelEvent('wheel', {
      deltaY, deltaMode: 0, bubbles: true, cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    /*
     * A real wheel event carries the legacy delta as well, and xterm prefers
     * it (wheelDeltaY / (120 * dpr) is its line delta); a constructed event's
     * wheelDeltaY equals deltaY, which is below one line and moves nothing.
     * Own properties shadow the prototype getters, exactly like the real event.
     */
    Object.defineProperty(event, 'wheelDeltaY', { value: -deltaY * 3 });
    Object.defineProperty(event, 'wheelDelta', { value: -deltaY * 3 });
    screen.dispatchEvent(event);
  };
  // Scan only frames sent after `from`, so a report from an earlier mode
  // cannot false-pass a later probe.
  const report = (from = 0) => {
    for (let i = from; i < sock.sent.length; i++) {
      const raw = sock.sent[i];
      const f = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (f[0] !== 2) continue; // Opcode.Input only
      if (f.length >= 6 && f[1] === 0x1b && f[2] === 0x5b && f[3] === 0x4d) return { kind: 'binary-x10' };
      const text = Array.from(f.slice(1), (b) => String.fromCharCode(b)).join('');
      if (text.includes('\u001b[<64;') || text.includes('\u001b[<65;')) return { kind: 'sgr', sample: text.slice(0, 20) };
    }
    return null;
  };

  if (cfg.mouse !== undefined) {
    send(cfg.mouse);
    await until(() => term.modes.mouseTrackingMode === cfg.wantMouse, `mouse mode ${cfg.wantMouse} not active`);
    out.mouse = term.modes.mouseTrackingMode;
  }
  if (cfg.lines > 0) {
    const text = Array.from({ length: cfg.lines }, (_, i) => `LINE ${String(i).padStart(4, '0')}`).join('\r\n');
    send(text);
    await until(() => term.buffer.active.baseY > 0, 'scrollback not built');
    // Wait for the write to fully drain: baseY stops growing.
    let lastBaseY = -1;
    let stable = 0;
    while (stable < 3) {
      const baseY = term.buffer.active.baseY;
      if (baseY === lastBaseY) stable += 1;
      else { stable = 0; lastBaseY = baseY; }
      await wait(50);
    }
    // Establish the desired initial viewport explicitly. A return-to-normal
    // buffer legitimately retains its prior scroll position, so do not rely on
    // auto-follow; scroll to the bottom so the wheel-up has scrollback to enter.
    term.scrollToBottom();
    await until(() => term.buffer.active.viewportY === term.buffer.active.baseY, 'viewport not at bottom after scrollToBottom');
    out.baseY = term.buffer.active.baseY;
  }
  if (cfg.control !== undefined) {
    sendControl(cfg.control);
    await wait(150);
  }
  // Re-read after the mode/line changes: a probe can switch buffers (e.g.
  // exit the alt screen), so the start-of-probe snapshot is stale.
  out.bufferType = term.buffer.active.type;
  out.mouse = term.modes.mouseTrackingMode;

  out.viewportBefore = term.buffer.active.viewportY;
  if (cfg.wheel !== undefined) {
    await until(() => screen.getBoundingClientRect().width > 0, 'screen laid out');
    const sentBefore = sock.sent.length;
    wheel(cfg.wheel);
    if (cfg.wantReport) {
      await until(() => report(sentBefore) !== null, 'no mouse report frame sent');
      out.report = report(sentBefore);
    } else if (cfg.noReport) {
      // Access gate (canType=false): give any incorrect report time to arrive,
      // then assert none did.
      await wait(300);
      out.report = report(sentBefore);
      if (out.report !== null) {
        out.errors = out.errors || [];
        out.errors.push('unexpected mouse report frame sent');
      }
    } else {
      // deltaY < 0 scrolls UP into history: viewportY (ydisp) decreases.
      await until(() => term.buffer.active.viewportY < out.viewportBefore, 'scrollback viewport did not move');
      out.viewportAfter = term.buffer.active.viewportY;
    }
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* Phase 1: the app viewer (TerminalPane)                              */
/* ------------------------------------------------------------------ */
if (part === 'both' || part === 'app') {
  const APP_ENTRY_ID = 'virtual:terminal-scroll-app-entry';
  const testEntryPlugin = {
    name: 'terminal-scroll-app-entry',
    resolveId(id) {
      return id === APP_ENTRY_ID ? `\0${APP_ENTRY_ID}.js` : null;
    },
    load(id) {
      if (id !== `\0${APP_ENTRY_ID}.js`) return null;
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
    root: fileURLToPath(new URL('../app', import.meta.url)),
    plugins: [testEntryPlugin],
    server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'silent',
  });
  let transport;
  const profile = await newProfile();
  const waitFor = async (checkFn, label) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      try { if (await checkFn()) return; } catch { /* transient (mid-navigation) */ }
      await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    transport = browser === 'safari' ? await launchSafariTransport() : await launchChromeTransport({ profile });
    await server.listen();
    const port = server.httpServer.address().port;
    await transport.navigate(`http://127.0.0.1:${port}/qa.html?scroll=${Date.now()}`);
    await waitFor(() => transport.evaluate(`document.getElementById('root') !== null`), 'qa.html load');

    await transport.evaluate(`(async () => {
      const {React, createRoot, BrowserRouter, TerminalPane, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider, Terminal} = await import('/@id/__x00__${APP_ENTRY_ID}.js');
      document.getElementById('root').style.display = 'none';
      globalThis.scrollTest = { terms: {}, sockets: [] };
      class FakeSocket extends EventTarget {
        readyState = 0;
        binaryType = '';
        bufferedAmount = 0;
        sent = [];
        constructor(url) {
          super();
          this.url = String(url);
          globalThis.scrollTest.sockets.push(this);
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
        const root = node.closest('[data-scroll-root]');
        if (root) globalThis.scrollTest.terms[root.dataset.scrollRoot] = this;
        return originalOpen.call(this, node);
      };
      const auth = {
        mode: 'firebase',
        user: { uid: 'scroll-test', email: 'scroll@test', displayName: 'Scroll', emailVerified: true, providerData: [] },
        initializing: false,
        signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {},
        signInWithProvider: async () => {}, resetPassword: async () => {}, resendVerification: async () => {},
        signOutUser: async () => {}, deleteAccount: async () => {},
      };
      const stage = document.createElement('div');
      stage.id = 'scroll-stage';
      stage.style.cssText = 'position: fixed; top: 8px; left: 8px; z-index: 2147483647; width: 560px; height: 420px;';
      document.body.append(stage);
      const mount = (key, canType) => {
        const box = document.createElement('div');
        box.dataset.scrollRoot = key;
        box.style.cssText = 'position: absolute; inset: 0;';
        stage.append(box);
        const shareUrl = location.origin + '/s/' + key.repeat(32);
        createRoot(box).render(React.createElement(AuthContext.Provider, { value: auth },
          React.createElement(BrowserRouter, null,
            React.createElement(VaultProvider, null,
              React.createElement(TeamKeyProvider, null,
                React.createElement(FeedbackProvider, null,
                  React.createElement(TerminalPane, { shareUrl, active: true, renderer: 'xterm', canType })
                )
              )
            )
          )
        ));
      };
      mount('a', true);
      mount('r', false);
      return true;
    })()`);

    // React mounts asynchronously: wait for both terminals to open and their
    // sockets to connect before probing.
    await waitFor(
      () => transport.evaluate(`globalThis.scrollTest && globalThis.scrollTest.terms.a && globalThis.scrollTest.terms.r && globalThis.scrollTest.sockets.length >= 2`),
      'app terminals + sockets ready',
    );

    const probe = async (cfg) => {
      const result = await transport.call(runProbe, cfg);
      console.log(`PROBE app ${JSON.stringify(cfg)} -> ${JSON.stringify(result)}`);
      return result ?? { error: 'probe returned nothing' };
    };
    const AA = 'a'.repeat(32);
    const RR = 'r'.repeat(32);

    // A1: normal buffer, no mouse mode — the wheel scrolls local scrollback.
    let r = await probe({ termKey: 'a', sockId: AA, lines: 300, wheel: -400 });
    check('app: normal-buffer wheel scrolls local scrollback', r,
      r.bufferType === 'normal' && r.mouse === 'none' && r.viewportAfter < r.viewportBefore,
    );

    // A2: read-only viewer — history must still be readable.
    r = await probe({ termKey: 'r', sockId: RR, lines: 300, wheel: -400 });
    check('app: read-only wheel still scrolls local scrollback', r,
      r.bufferType === 'normal' && r.mouse === 'none' && r.viewportAfter < r.viewportBefore,
    );

    // A3: canType=false (handoff) blocks binary mouse reports even though the
    // connection is not read-only — the same access gate as onData.
    r = await probe({
      termKey: 'r', sockId: RR,
      mouse: '\u001b[?1049h\u001b[?1000h', wantMouse: 'vt200',
      wheel: -400, noReport: true,
    });
    check('app: canType=false blocks legacy(1000) binary report', r,
      r.mouse === 'vt200' && r.report === null,
    );

    // B1: alternate screen + SGR mouse (1000 + 1006, as real TUIs enable) —
    // the wheel is a text report.
    r = await probe({
      termKey: 'a', sockId: AA,
      mouse: '\u001b[?1049h\u001b[?1000h\u001b[?1006h', wantMouse: 'vt200',
      wheel: -400, wantReport: true,
    });
    check('app: alt-screen SGR(1006) wheel reports to PTY', r,
      r.bufferType === 'alternate' && r.report?.kind === 'sgr',
    );

    // B2: alternate screen + legacy mouse (1000) — the wheel is a binary report.
    r = await probe({
      termKey: 'a', sockId: AA,
      mouse: '\u001b[?1006l\u001b[?1000h', wantMouse: 'vt200',
      wheel: -400, wantReport: true,
    });
    check('app: alt-screen legacy(1000) wheel reports to PTY (binary)', r,
      r.report?.kind === 'binary-x10',
    );

    // B3: mouse mode off again — local scrollback resumes.
    r = await probe({
      termKey: 'a', sockId: AA,
      mouse: '\u001b[?1000l\u001b[?1049l', wantMouse: 'none',
      lines: 100, wheel: -400,
    });
    check('app: after mouse mode off, wheel scrolls local scrollback again', r,
      r.bufferType === 'normal' && r.mouse === 'none' && r.viewportAfter < r.viewportBefore,
    );
  } finally {
    await transport?.close();
    await server.close();
    if (browser === 'chrome') await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/* ------------------------------------------------------------------ */
/* Phase 2: the standalone viewer (index.html + web/main.ts)           */
/* ------------------------------------------------------------------ */
if (part === 'both' || part === 'standalone') {
  const BOOTSTRAP_ID = 'virtual:scroll-standalone-bootstrap';
  const bootstrapPlugin = {
    name: 'scroll-standalone-bootstrap',
    transformIndexHtml(html) {
      const entry = /<script type="module" src="\/web\/entry\.ts"><\/script>/;
      assert(entry.test(html), 'Standalone fixture must replace the real viewer entry');
      return html.replace(
        entry,
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
        globalThis.scrollTest = { terms: {}, sockets: [] };
         class FakeSocket extends EventTarget {
           static OPEN = 1;
           static CLOSED = 3;
           readyState = 0;
           binaryType = '';
           bufferedAmount = 0;
           sent = [];
          constructor(url) {
            super();
            this.url = String(url);
            globalThis.scrollTest.sockets.push(this);
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
          globalThis.scrollTest.terms.standalone = this;
          return originalOpen.call(this, node);
        };
        await import('/web/entry.ts');
      `;
    },
  };
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [bootstrapPlugin],
    server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent',
  });
  let transport;
  const profile = await newProfile();
  const waitFor = async (checkFn, label) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      try { if (await checkFn()) return; } catch { /* transient (mid-navigation) */ }
      await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    transport = browser === 'safari' ? await launchSafariTransport() : await launchChromeTransport({ profile });
    await server.listen();
    const port = server.httpServer.address().port;
    await transport.navigate(`http://127.0.0.1:${port}/s/${SESSION_ID}?run=${Date.now()}`);
    await waitFor(
      () => transport.evaluate(`globalThis.scrollTest && globalThis.scrollTest.terms.standalone !== undefined`),
      'standalone terminal open',
    );

    const probe = async (cfg) => {
      const result = await transport.call(runProbe, { termKey: 'standalone', sockId: SESSION_ID, ...cfg });
      console.log(`PROBE standalone ${JSON.stringify(cfg)} -> ${JSON.stringify(result)}`);
      return result ?? { error: 'probe returned nothing' };
    };

    // S1: normal buffer, no mouse mode — the wheel scrolls local scrollback.
    let r = await probe({ lines: 300, wheel: -400 });
    check('standalone: normal-buffer wheel scrolls local scrollback', r,
      r.bufferType === 'normal' && r.mouse === 'none' && r.viewportAfter < r.viewportBefore,
    );

    // S2: alternate screen + SGR mouse (1000 + 1006) — the wheel is a text report.
    r = await probe({
      mouse: '\u001b[?1049h\u001b[?1000h\u001b[?1006h', wantMouse: 'vt200',
      wheel: -400, wantReport: true,
    });
    check('standalone: alt-screen SGR(1006) wheel reports to PTY', r,
      r.bufferType === 'alternate' && r.report?.kind === 'sgr',
    );

    // S3: alternate screen + legacy mouse (1000) — the wheel is a binary report.
    r = await probe({
      mouse: '\u001b[?1006l\u001b[?1000h', wantMouse: 'vt200',
      wheel: -400, wantReport: true,
    });
    check('standalone: alt-screen legacy(1000) wheel reports to PTY (binary)', r,
      r.report?.kind === 'binary-x10',
    );

    // S4: read-only viewer, normal buffer — history must still be readable.
    r = await probe({
      mouse: '\u001b[?1000l\u001b[?1049l', wantMouse: 'none',
      control: { readOnly: true },
      lines: 100, wheel: -400,
    });
    check('standalone: read-only wheel still scrolls local scrollback', r,
      r.bufferType === 'normal' && r.mouse === 'none' && r.viewportAfter < r.viewportBefore,
    );
  } finally {
    await transport?.close();
    await server.close();
    if (browser === 'chrome') await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (failures.length > 0) {
  console.error(`\nscroll regression: ${failures.length} failing probe(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nPASS terminal scroll: local scrollback and TUI mouse reporting intact in both viewers');
