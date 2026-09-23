// Local browser regression for the reported terminal paint defects: missing
// text inside the grid, fragments painted outside it, detached cursors and
// clipped/misaligned rows -- on light and dark themes, after tab switches,
// theme switches, resizes, snapshots and live output.
//
// Two independent layers are audited on the same grid, so a failure says which
// one broke instead of guessing:
//   - the VT layer: what the emulator's buffer holds (data correctness);
//   - the paint layer: what the screenshot actually shows at the grid's
//     measured geometry (pixels), and what the DOM paints outside the grid.
//
// The fixture is a generic full-screen terminal program (box border, per-row
// labels, a reverse-video status bar, coloured blocks), not an agent TUI.
// Synthetic WebSocket + real CSS and a real browser; no login, relay or deploy.
// SHELL_BROWSER=safari runs the same fixtures through safaridriver.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport, launchSafariTransport } from '../../scripts/lib/browser-transport.mjs';

const browser = process.env.SHELL_BROWSER === 'safari' ? 'safari' : 'chrome';
const profile = browser === 'chrome' ? await mkdtemp(join(tmpdir(), 'shell-paint-')) : null;
const shots = await mkdtemp(join(browser === 'safari' ? '/tmp' : tmpdir(), 'shell-paint-shots-'));
const TEST_ENTRY_ID = 'virtual:terminal-paint-test-entry';
const testEntryPlugin = {
  name: 'terminal-paint-test-entry',
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
  server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'silent',
});
let transport;
const waitFor = async (check, label) => {
  const end = Date.now() + 20000;
  let lastError;
  while (Date.now() < end) {
    try { if (await check()) return; lastError = null; }
    catch (error) { lastError = error; /* transient (e.g. mid-navigation); retry */ }
    await delay(50);
  }
  throw new Error(lastError ? `Timed out: ${label} (${lastError.message})` : `Timed out: ${label}`);
};
const evaluate = (expression) => transport.evaluate(expression);

// The fixture page: two panes in one stage, so the hidden pane is the real
// visibility-hidden kind the app keeps mounted, not an unmounted stand-in.
const SETUP = `
  const {React, createRoot, BrowserRouter, TerminalPane, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider, Terminal} = await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  document.getElementById('root').style.display = 'none';
  globalThis.paintTest = { terms: {}, sockets: [], roots: {}, pulses: {}, pulseEvents: [] };
  class FakeSocket extends EventTarget {
    readyState = 0;
    binaryType = '';
    sent = [];
    constructor(url) {
      super();
      this.url = url;
      globalThis.paintTest.sockets.push(this);
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
    const root = node.closest('[data-paint-root]');
    if (root) globalThis.paintTest.terms[root.dataset.paintRoot] = this;
    return originalOpen.call(this, node);
  };
  const auth = {
    mode: 'firebase',
    user: { uid: 'paint-test', email: 'paint@test', displayName: 'Paint', emailVerified: true, providerData: [] },
    initializing: false,
    signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {},
    signInWithProvider: async () => {}, resetPassword: async () => {}, resendVerification: async () => {},
    signOutUser: async () => {}, deleteAccount: async () => {},
  };
  const stage = document.createElement('div');
  stage.id = 'paint-stage';
  stage.style.cssText = 'position: fixed; top: 8px; left: 8px; z-index: 2147483647; width: 560px; height: 420px;';
  document.body.append(stage);
  globalThis.paintTest.mount = (key, active, fragment = '') => {
    const box = document.createElement('div');
    box.dataset.paintRoot = key;
    box.style.cssText = 'position: absolute; inset: 0;';
    stage.append(box);
    const shareUrl = location.origin + '/s/' + key.repeat(32) + fragment;
    const tree = (on) => React.createElement(AuthContext.Provider, { value: auth },
      React.createElement(BrowserRouter, null,
        React.createElement(VaultProvider, null,
          React.createElement(TeamKeyProvider, null,
            React.createElement(FeedbackProvider, null,
              React.createElement(TerminalPane, { shareUrl, active: on, renderer: 'xterm',
                onPulseChange: (value) => {
                  paintTest.pulses[key] = value;
                  paintTest.pulseEvents.push({ key, value });
                },
              })
            )
          )
        )
      )
    );
    const root = createRoot(box);
    globalThis.paintTest.roots[key] = { root, tree };
    root.render(tree(active));
  };
  globalThis.paintTest.setActive = (key, active) => {
    globalThis.paintTest.roots[key].root.render(globalThis.paintTest.roots[key].tree(active));
  };
  window.scrollTo(0, 0);
`;

const ESC = String.fromCharCode(27);
const CRLF = String.fromCharCode(13, 10);
// A generic full-screen terminal program: a box border, a labelled row on
// every interior line, a reverse-video status bar and coloured blocks. Every
// row and both border columns carry ink by construction, which is what makes
// "a row with no ink" or "a border column with a gap" meaningful.
function fullScreenScript({ rows = 36, cols = 120, tag = '1', statusRow = 33, greenRow = 17, blackRow = 1, cursorRow = 20, cursorCol = 10 } = {}) {
  const frame = (left, right, fill) => left + fill.repeat(cols - 2) + right;
  const out = [];
  out.push(frame('┌', '┐', '─'));
  for (let r = 1; r < rows - 1; r++) {
    let inner = ` ROW ${String(r).padStart(2, '0')} ${tag} `.padEnd(cols - 2, ' ');
    if (r === blackRow) inner = ESC + '[40m' + inner.slice(0, 10) + ESC + '[0m' + inner.slice(10);
    if (r === greenRow) inner = inner.slice(0, 30) + ESC + '[48;2;0;255;0m' + ' '.repeat(40) + ESC + '[0m' + inner.slice(70);
    if (r === statusRow) inner = ESC + '[7m' + ` STATUS ${tag} OK `.padEnd(cols - 2, ' ') + ESC + '[27m';
    out.push('│' + inner + '│');
  }
  out.push(frame('└', '┘', '─'));
  /*
   * Park the cursor inside the grid on the last line as a suffix, not a line
   * of its own: a CRLF after the bottom row would scroll the buffer one line,
   * which shifts what the screen shows relative to the buffer rows this
   * fixture's checks speak in.
   */
  return ESC + '[?1049h' + out.join(CRLF) + (cursorRow ? ESC + `[${cursorRow};${cursorCol}H` + ESC + '[?25h' : '');
}
const socketEmit = (index, opcode, text) => `(() => {
  const payload = new TextEncoder().encode(${JSON.stringify(text)});
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = ${opcode};
  frame.set(payload, 1);
  paintTest.sockets[${index}].emitBinary(frame.buffer);
  return true;
})()`;

// The audit: VT first (buffer cells), then pixels -- per-row ink coverage, both
// border columns, the reverse-video bar, stray ink outside the grid, cursor
// placement and row-strip geometry. Runs in the page against a real screenshot.
function auditExpression({ rootKey, roi, base64, rows, cols, statusRow, greenRow = 17, blackRow = 1 }) {
  return `(() => (async () => {
    const root = document.querySelector('[data-paint-root=${JSON.stringify(rootKey)}]');
    const pane = root && root.querySelector('.pane');
    const term = paintTest.terms[${JSON.stringify(rootKey)}];
    if (!pane || !term || !term.element) return { error: 'pane or terminal missing' };
    const screen = term.element.querySelector('.xterm-screen');
    if (!screen) return { error: 'screen missing' };
    const sr = screen.getBoundingClientRect();
    const paneScreen = pane.querySelector('.pane-screen');
    const pr = paneScreen ? paneScreen.getBoundingClientRect() : null;
    const report = { browser: /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent) ? 'safari' : 'chrome',
      screen: { x: +sr.x.toFixed(2), y: +sr.y.toFixed(2), w: +sr.width.toFixed(2), h: +sr.height.toFixed(2) },
      pane: pr ? { x: +pr.x.toFixed(2), y: +pr.y.toFixed(2), w: +pr.width.toFixed(2), h: +pr.height.toFixed(2) } : null,
      fits: pr ? (sr.width <= pr.width + 1 && sr.height <= pr.height + 1 && sr.x >= pr.x - 1 && sr.y >= pr.y - 1 && sr.x + sr.width <= pr.x + pr.width + 1 && sr.y + sr.height <= pr.y + pr.height + 1) : false,
      cell: { w: +(sr.width / ${cols}).toFixed(3), h: +(sr.height / ${rows}).toFixed(3) },
      vt: { rows: term.rows, cols: term.cols, cursorX: term.buffer.active.cursorX, cursorY: term.buffer.active.cursorY } };

    // --- VT layer: border cells and per-row labels in the buffer. Lines are
    // read from the viewport (viewportY), and the audit requires no scrollback
    // shift, so a painted row and a buffer row mean the same thing.
    const vb = term.buffer.active;
    const at = (r, c) => { const line = vb.getLine(vb.viewportY + r); const cell = line && line.getCell(c); return cell ? cell.getChars() : ''; };
    report.vt.baseY = vb.baseY;
    report.vt.viewportY = vb.viewportY;
    report.vt.topLeft = at(0, 0) === '┌';
    report.vt.topRight = at(0, ${cols - 1}) === '┐';
    report.vt.bottomLeft = at(${rows - 1}, 0) === '└';
    report.vt.bottomRight = at(${rows - 1}, ${cols - 1}) === '┘';
    report.vt.labelsOk = true;
    for (let r = 1; r < ${rows - 1}; r++) {
      if (r === ${statusRow}) continue;
      if (at(r, 2) !== 'R') { report.vt.labelsOk = false; break; }
    }
    // Colour state in the buffer, so a missing background in the pixels is
    // distinguishable from a background that never reached the emulator.
    const bgCell = vb.getLine(vb.viewportY + ${blackRow}).getCell(5);
    report.vt.blackCell = { palette: bgCell.isBgPalette(), color: bgCell.getBgColor(), inverse: bgCell.isInverse() };
    const greenCell = vb.getLine(vb.viewportY + ${greenRow}).getCell(50);
    report.vt.greenCell = { rgb: greenCell.isBgRGB(), color: greenCell.getBgColor(), inverse: greenCell.isInverse() };
    const statusCell = vb.getLine(vb.viewportY + ${statusRow}).getCell(5);
    report.vt.statusCell = { inverse: statusCell.isInverse(), chars: statusCell.getChars() };

    // --- Run geometry: rows contiguous, heights uniform, ends on the screen.
    const rowEls = [...term.element.querySelectorAll('.xterm-rows > div')];
    report.dom = { rowCount: rowEls.length, contiguous: true, minH: null, maxH: null, lastBottomGap: null };
    let minH = Infinity, maxH = 0, prevBottom = null;
    for (const el of rowEls) {
      const b = el.getBoundingClientRect();
      if (b.height > 0) { minH = Math.min(minH, b.height); maxH = Math.max(maxH, b.height); }
      if (prevBottom !== null && Math.abs(b.top - prevBottom) > 1) report.dom.contiguous = false;
      prevBottom = b.bottom;
    }
    report.dom.minH = Number.isFinite(minH) ? +minH.toFixed(2) : null;
    report.dom.maxH = +maxH.toFixed(2);
    if (prevBottom !== null) report.dom.lastBottomGap = +(prevBottom - sr.bottom).toFixed(2);

    const cur = term.element.querySelector('.xterm-cursor');
    if (cur) {
      const b = cur.getBoundingClientRect();
      const expectedX = sr.x + vb.cursorX * sr.width / term.cols;
      const expectedY = sr.y + (vb.baseY + vb.cursorY - vb.viewportY) * sr.height / term.rows;
      report.cursor = { x: +b.x.toFixed(2), y: +b.y.toFixed(2), positioned: Math.abs(b.x - expectedX) <= 1.5 && Math.abs(b.y - expectedY) <= 1.5, inside: b.x >= sr.x - 1.5 && b.x + b.width <= sr.x + sr.width + 1.5 && b.y >= sr.y - 1.5 && b.y + b.height <= sr.y + sr.height + 1.5 };
    }

    // --- Pixel layer.
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('png decode')); img.src = 'data:image/png;base64,' + ${JSON.stringify(base64)}; });
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const sx = cv.width / ${JSON.stringify(roi.width)}, sy = cv.height / ${JSON.stringify(roi.height)};
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const sample = (cssX, cssY) => {
      const X = Math.round((cssX - ${JSON.stringify(roi.x)}) * sx), Y = Math.round((cssY - ${JSON.stringify(roi.y)}) * sy);
      if (X < 0 || Y < 0 || X >= cv.width || Y >= cv.height) return null;
      const i = (Y * cv.width + X) * 4; return [px[i], px[i + 1], px[i + 2]];
    };
    const diff = (a, b) => a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : 0;
    // Background: sampled inside the pane but outside the grid; the page there
    // is uniform, so the first sample wins.
    let bg = null;
    for (const [x, y] of [[sr.right + 5, sr.top + 4], [sr.right + 5, sr.bottom - 4], [sr.left - 5, sr.bottom + 5], [sr.left + 5, sr.bottom + 5]]) {
      const c = sample(x, y); if (c) { bg = c; break; }
    }
    if (!bg) return { ...report, error: 'no background sample' };
    const ink = (c) => diff(c, bg) > 60;
    report.bg = bg;

    const cellW = sr.width / ${cols}, cellH = sr.height / ${rows};
    /*
     * Inspect every device-pixel centre inside this cell. Three horizontal
     * scanlines can miss a one-pixel box border at tiny fonts (font rasterizers
     * differ across Linux/macOS). Never sample an adjacent row or column: it
     * must not hide a genuinely blank cell.
     */
    const cellHasInk = (r, c) => {
      const x0 = Math.max(0, Math.ceil((sr.left + c * cellW - ${JSON.stringify(roi.x)}) * sx - 0.5));
      const x1 = Math.min(cv.width, Math.ceil((sr.left + (c + 1) * cellW - ${JSON.stringify(roi.x)}) * sx - 0.5));
      const y0 = Math.max(0, Math.ceil((sr.top + r * cellH - ${JSON.stringify(roi.y)}) * sy - 0.5));
      const y1 = Math.min(cv.height, Math.ceil((sr.top + (r + 1) * cellH - ${JSON.stringify(roi.y)}) * sy - 0.5));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * cv.width + x) * 4;
          if (ink([px[i], px[i + 1], px[i + 2]])) return true;
        }
      }
      return false;
    };
    const rowsWithoutInk = [], borderLeftGapRows = [], borderRightGapRows = [];
    for (let r = 0; r < ${rows}; r++) {
      let count = 0;
      for (let c = 0; c < ${cols}; c++) if (cellHasInk(r, c)) count++;
      if (count === 0) rowsWithoutInk.push(r);
      if (r > 0 && r < ${rows - 1}) {
        if (!cellHasInk(r, 0)) borderLeftGapRows.push(r);
        if (!cellHasInk(r, ${cols - 1})) borderRightGapRows.push(r);
      }
    }
    report.paint = { rowsWithoutInk, borderLeftGapRows, borderRightGapRows, borderLeftGaps: borderLeftGapRows.length, borderRightGaps: borderRightGapRows.length, statusCoverage: 0, strayPixels: 0 };
    let statusInk = 0;
    for (let c = 0; c < ${cols}; c++) if (ink(sample(sr.left + (c + 0.5) * cellW, sr.top + (${statusRow} + 0.5) * cellH))) statusInk++;
    report.paint.statusCoverage = +(statusInk / ${cols}).toFixed(3);

    // Background fills: the truecolor green block and the palette-black block.
    let greenPixels = 0, greenTotal = 0, blackPixels = 0, blackTotal = 0;
    for (let y = sr.top + (${greenRow} + 0.2) * cellH; y < sr.top + (${greenRow} + 0.8) * cellH; y += 0.5) {
      for (let x = sr.left + 31 * cellW; x < sr.left + 69 * cellW; x += 0.5) {
        const c2 = sample(x, y); greenTotal++;
        if (c2 && c2[1] > 200 && c2[0] < 120 && c2[2] < 120) greenPixels++;
      }
    }
    for (let y = sr.top + (${blackRow} + 0.2) * cellH; y < sr.top + (${blackRow} + 0.8) * cellH; y += 0.5) {
      for (let x = sr.left + 0.5 * cellW; x < sr.left + 9 * cellW; x += 0.5) {
        const c2 = sample(x, y); blackTotal++;
        if (ink(c2)) blackPixels++;
      }
    }
    report.paint.greenCoverage = +(greenPixels / Math.max(greenTotal, 1)).toFixed(3);
    report.paint.blackCoverage = +(blackPixels / Math.max(blackTotal, 1)).toFixed(3);

    /*
     * Fill alignment: a background block has to sit on its own row and behind
     * its own columns, not merely somewhere inside the band -- an offset fill
     * is exactly the "stacked rectangles" class of defect.
     */
    const fillBox = (test, row, x0, x1) => {
      let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1, n = 0;
      const yStart = sr.top + Math.max(0, row - 1) * cellH, yEnd = sr.top + Math.min(${rows}, row + 2) * cellH;
      for (let y = yStart; y < yEnd; y += 0.5) {
        for (let x = sr.left + x0 * cellW; x < sr.left + x1 * cellW; x += 0.5) {
          const c3 = sample(x, y);
          if (c3 && test(c3)) { n++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
        }
      }
      return n ? { x0: +bx0.toFixed(1), y0: +by0.toFixed(1), x1: +bx1.toFixed(1), y1: +by1.toFixed(1), n } : { n: 0 };
    };
    report.paint.greenBox = fillBox((c3) => c3[1] > 200 && c3[0] < 120 && c3[2] < 120, ${greenRow}, 30, 70);
    /*
     * The reverse-video bar and the body text can be the same colour (light
     * theme: both the theme foreground), so the bar is found by its shape: the
     * only rows that carry one long, near-full-width ink run.
     */
    const barRows = [];
    for (let y = sr.top + Math.max(0, ${statusRow} - 1) * cellH; y < sr.top + Math.min(${rows}, ${statusRow} + 2) * cellH; y += 0.5) {
      let run = 0, best = 0;
      for (let x = sr.left; x < sr.left + sr.width; x += 0.5) {
        if (ink(sample(x, y))) { run += 0.5; if (run > best) best = run; } else run = 0;
      }
      if (best >= sr.width * 0.5) barRows.push(y);
    }
    report.paint.statusBox = barRows.length ? { y0: barRows[0], y1: barRows[barRows.length - 1] + 0.5, n: barRows.length } : { n: 0 };

    // Stray ink: coarse sweep of the whole stage outside the grid (+3px),
    // skipping the terminal's own chrome (viewport/scrollbar) and the tools
    // strip, which are legitimately outside the grid.
    const skip = [['.xterm-viewport', term.element], ['.pane-tools', pane]];
    const skipRects = skip.map(([sel, scope]) => { const el = scope.querySelector(sel); const b = el && el.getBoundingClientRect(); return b && b.width > 0 && b.height > 0 ? b : null; }).filter(Boolean);
    const inSkip = (x, y) => skipRects.some((b) => x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2);
    const stage = document.getElementById('paint-stage').getBoundingClientRect();
    for (let y = stage.top; y < stage.bottom; y += 2) {
      for (let x = stage.left; x < stage.right; x += 2) {
        if (x > sr.left - 3 && x < sr.right + 3 && y > sr.top - 3 && y < sr.bottom + 3) continue;
        if (inSkip(x, y)) continue;
        if (ink(sample(x, y))) report.paint.strayPixels++;
      }
    }

    // Colour histograms for the fixture's painted bands, so a missing
    // background fill is distinguishable from missing glyphs.
    report.samples = {};
    const hist = (y0, y1, x0, x1) => {
      const counts = new Map();
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const c = sample(x, y); if (!c) continue;
          const key = c.join(',');
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, n]) => ({ rgb: key, n }));
    };
    report.samples.statusRow = hist(sr.top + (${statusRow} + 0.2) * cellH, sr.top + (${statusRow} + 0.8) * cellH, sr.left + 1, sr.left + sr.width - 1);
    report.samples.greenRow = hist(sr.top + (${greenRow} + 0.2) * cellH, sr.top + (${greenRow} + 0.8) * cellH, sr.left + 31 * cellW, sr.left + 69 * cellW);
    report.samples.blackBlock = hist(sr.top + (${blackRow} + 0.2) * cellH, sr.top + (${blackRow} + 0.8) * cellH, sr.left + 0.5 * cellW, sr.left + 9 * cellW);
    report.samples.lastInteriorLeft = hist(sr.top + (${rows} - 2.2) * cellH, sr.top + (${rows} - 1.2) * cellH, sr.left - 1, sr.left + 3 * cellW);
    return report;
  })())()`;
}

async function audit(rootKey, opts, expectedBlankRows = []) {
  // Focus the full-screen TUI and stop blinking so a screenshot cannot sample
  // the cursor off. The fixture enters the alternate buffer via normal ANSI.
  await transport.call((key) => {
    const term = globalThis.paintTest.terms[key];
    term.options.cursorBlink = false;
    term.blur(); term.focus();
  }, rootKey);
  await delay(80);
  const stageRect = await evaluate(`(() => { const r = document.getElementById('paint-stage').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const clipExpression = `(() => { const r = document.getElementById('paint-stage').getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 1 }; })()`;
  const roi = browser === 'safari'
    ? { x: 0, y: 0, width: safariViewport.width, height: safariViewport.height }
    : { x: Math.max(0, stageRect.x - 8), y: Math.max(0, stageRect.y - 8), width: stageRect.width + 16, height: stageRect.height + 16 };
  const data = await transport.screenshot(browser === 'chrome' ? clipExpression : undefined);
  const report = await evaluate(auditExpression({ rootKey, roi, base64: data, ...opts }));
  assert.ok(report && !report.error, `${opts.label}: audit failed: ${report?.error ?? 'null report'}`);
  await writeFile(join(shots, `${opts.label}.png`), Buffer.from(data, 'base64'));
  await writeFile(join(shots, `${opts.label}.json`), JSON.stringify(report, null, 2));
  const fail = (message) => { failures.push(`${opts.label}: ${message}`); console.log(`FAIL ${opts.label}: ${message}`); };
  const expect = (condition, message) => { if (!condition) fail(message); };
  expect(report.vt.rows === opts.rows && report.vt.cols === opts.cols, `vt grid ${report.vt.cols}x${report.vt.rows}`);
  expect(report.vt.baseY === 0 && report.vt.viewportY === 0, `grid scrolled (baseY ${report.vt.baseY}, viewportY ${report.vt.viewportY}); expectations invalid`);
  expect(report.vt.topLeft && report.vt.topRight && report.vt.bottomLeft && report.vt.bottomRight, 'VT border cells');
  expect(report.vt.labelsOk, 'VT row labels');
  expect(JSON.stringify(report.paint.rowsWithoutInk) === JSON.stringify(expectedBlankRows), `rows with no painted ink: ${report.paint.rowsWithoutInk.join(',')} (expected ${expectedBlankRows.join(',') || 'none'})`);
  expect(report.paint.borderLeftGapRows.length === 0, `left border unpainted on rows: ${report.paint.borderLeftGapRows.join(',')}`);
  expect(report.paint.borderRightGapRows.length === 0, `right border unpainted on rows: ${report.paint.borderRightGapRows.join(',')}`);
  expect(report.paint.statusCoverage >= 0.85, `reverse bar coverage ${report.paint.statusCoverage}`);
  expect(report.paint.greenCoverage >= 0.8, `green block coverage ${report.paint.greenCoverage}`);
  expect(report.paint.blackCoverage >= 0.5, `black block coverage ${report.paint.blackCoverage}`);
  const cellW = report.screen.w / opts.cols, cellH = report.screen.h / opts.rows;
  const greenTop = report.screen.y + (opts.greenRow ?? 17) * cellH, greenBottom = greenTop + cellH;
  expect(report.paint.greenBox.n > 0 && Math.abs(report.paint.greenBox.y0 - greenTop) <= 2 && Math.abs(report.paint.greenBox.y1 - greenBottom) <= 2,
    `green block ${JSON.stringify(report.paint.greenBox)} vs expected rows ${greenTop.toFixed(1)}..${greenBottom.toFixed(1)}`);
  const statusTop = report.screen.y + opts.statusRow * cellH, statusBottom = statusTop + cellH;
  expect(report.paint.statusBox.n > 0 && Math.abs(report.paint.statusBox.y0 - statusTop) <= 2 && Math.abs(report.paint.statusBox.y1 - statusBottom) <= 2,
    `status bar ${JSON.stringify(report.paint.statusBox)} vs expected rows ${statusTop.toFixed(1)}..${statusBottom.toFixed(1)}`);
  expect(report.paint.strayPixels <= 2, `stray painted pixels outside the grid: ${report.paint.strayPixels}`);
  expect(report.fits, `screen ${JSON.stringify(report.screen)} overflows the pane ${JSON.stringify(report.pane)}`);
  expect(report.dom.rowCount === opts.rows, `row strip count ${report.dom.rowCount}`);
  expect(report.dom.contiguous, 'rows not contiguous');
  expect(report.dom.maxH - report.dom.minH <= 0.6, `row heights ${report.dom.minH}..${report.dom.maxH}`);
  expect(Math.abs(report.dom.lastBottomGap) <= 1.5, `last row gap ${report.dom.lastBottomGap}`);
  expect(!!report.cursor, 'visible cursor must be painted');
  if (report.cursor) {
    expect(report.cursor.inside, 'cursor outside the grid');
    expect(report.cursor.positioned, 'painted cursor does not match the terminal buffer cell');
  }
  if (!failures.some((entry) => entry.startsWith(`${opts.label}:`))) {
    console.log(`PASS ${opts.label}: ${JSON.stringify({ screen: report.screen, cell: report.cell, status: report.paint.statusCoverage, stray: report.paint.strayPixels, bg: { black: report.vt.blackCell, green: report.vt.greenCell, status: report.vt.statusCell }, cursor: report.cursor ?? null })}`);
  }
  return report;
}
const failures = [];

let safariViewport = { width: 0, height: 0, dpr: 1 };

const ROWS = 36, COLS = 120, STATUS_ROW = 33;
const SNAP1 = fullScreenScript({ rows: ROWS, cols: COLS, tag: '1', statusRow: STATUS_ROW });
const SNAP2 = fullScreenScript({ rows: ROWS, cols: COLS, tag: '2', statusRow: STATUS_ROW, cursorRow: 30, cursorCol: 40 });
const SNAP_MOBILE = fullScreenScript({ rows: 40, cols: 80, tag: 'M', statusRow: 36 });

try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = browser === 'safari' ? await launchSafariTransport() : await launchChromeTransport({ profile });
  if (browser === 'safari') {
    safariViewport = await transport.setViewport({ width: 1280, height: 800 });
    console.log(`safari actual viewport: ${safariViewport.width}x${safariViewport.height} @${safariViewport.dpr}x`);
  } else {
    await transport.setViewport({ width: 1280, height: 800, dpr: 2, mobile: false });
  }

  for (const theme of ['light', 'dark']) {
    await transport.navigate(`http://127.0.0.1:${port}/qa.html?paint=${theme}-${Date.now()}`);
    await waitFor(() => evaluate(`location.origin === 'http://127.0.0.1:${port}' && document.readyState === 'complete'`), 'page load');
    await transport.call((value) => { document.documentElement.dataset.theme = value; return true; }, theme);
    await evaluate(`(async () => { ${SETUP} })()`);
    await evaluate(`(() => { paintTest.mount('a', true); paintTest.mount('b', false); return true; })()`);
    await waitFor(() => evaluate(`paintTest.sockets.length === 2 && !!paintTest.terms.a && !!paintTest.terms.b`), 'two terminals open');
    await evaluate(`(() => { paintTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: ${COLS}, rows: ${ROWS} })); return true; })()`);
    await evaluate(socketEmit(0, 0x03, SNAP1));
    await waitFor(() => evaluate(`(() => { const b = paintTest.terms.a.buffer.active.getLine(0); return b && b.getCell(0) && b.getCell(0).getChars() === '┌'; })()`), 'snapshot in pane a');
    await evaluate(`(() => { paintTest.sockets[1].emitText(JSON.stringify({ type: 'terminal_size', cols: ${COLS}, rows: ${ROWS} })); return true; })()`);
    await evaluate(socketEmit(1, 0x03, SNAP1));
    await delay(250);

    const common = { rows: ROWS, cols: COLS, statusRow: STATUS_ROW };
    await audit('a', { ...common, label: `${browser}-${theme}-initial` });
    await transport.call((value) => { document.documentElement.dataset.theme = value; return true; }, theme === 'light' ? 'dark' : 'light');
    await delay(300);
    await audit('a', { ...common, label: `${browser}-${theme}-inverted` });
    await transport.call((value) => { document.documentElement.dataset.theme = value; return true; }, theme);
    await delay(300);
    await audit('a', { ...common, label: `${browser}-${theme}-restored` });

    await evaluate(`(() => { paintTest.setActive('a', false); paintTest.setActive('b', true); return true; })()`);
    await waitFor(() => evaluate(`paintTest.terms.b && paintTest.terms.b.buffer.active.getLine(0) && paintTest.terms.b.buffer.active.getLine(0).getCell(0) && paintTest.terms.b.buffer.active.getLine(0).getCell(0).getChars() === '┌'`), 'pane b snapshot');
    await delay(400);
    await audit('b', { ...common, label: `${browser}-${theme}-tab-b` });
    await evaluate(`(() => { paintTest.setActive('b', false); paintTest.setActive('a', true); return true; })()`);
    await delay(400);
    await audit('a', { ...common, label: `${browser}-${theme}-tab-back` });

    await evaluate(`(() => { const s = document.getElementById('paint-stage'); s.style.width = '700px'; s.style.height = '520px'; return true; })()`);
    await delay(400);
    await audit('a', { ...common, label: `${browser}-${theme}-resized` });

    await evaluate(socketEmit(0, 0x03, SNAP2));
    await waitFor(() => evaluate(`(() => { const l = paintTest.terms.a.buffer.active.getLine(0); return l && l.getCell(1) && l.getCell(1).getChars() === '─' && l.getCell(2) && l.getCell(2).getChars() === '─'; })()`), 'second snapshot');
    await evaluate(socketEmit(0, 0x01, 'paint-ok' + CRLF));
    await delay(250);
    await audit('a', { ...common, label: `${browser}-${theme}-replay` });

    await evaluate(`(() => { paintTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: 80, rows: 40 })); return true; })()`);
    await evaluate(socketEmit(0, 0x03, SNAP_MOBILE));
    await waitFor(() => evaluate(`(() => { const t = paintTest.terms.a; return t && t.cols === 80 && t.rows === 40; })()`), 'mobile grid adopted');
    await delay(400);
    await audit('a', { rows: 40, cols: 80, statusRow: 36, label: `${browser}-${theme}-portrait` });
    await evaluate(`(() => { paintTest.sockets[0].emitText(JSON.stringify({ type: 'terminal_size', cols: ${COLS}, rows: ${ROWS} })); return true; })()`);
    await evaluate(socketEmit(0, 0x03, SNAP1));
    await waitFor(() => evaluate(`(() => { const t = paintTest.terms.a; return t && t.cols === ${COLS} && t.rows === ${ROWS}; })()`), 'desktop grid back');
    await delay(400);
    await audit('a', { ...common, label: `${browser}-${theme}-back-to-desktop` });

    /*
     * 7) Tiny pane: the user's reported geometry. A short pane drives the fit
     * to the 4px floor; the grid must still fit the pane, with every row,
     * border and fill painted at the same grid.
     */
    await evaluate(`(() => { const s = document.getElementById('paint-stage'); s.style.width = '560px'; s.style.height = '230px'; return true; })()`);
    await delay(400);
    const tiny = await audit('a', { ...common, label: `${browser}-${theme}-tiny` });
    console.log(`tiny: font ${tiny.vt ? 'n/a' : ''}${JSON.stringify({ screen: tiny.screen, pane: tiny.pane, cell: tiny.cell })}`);

    // Negative control: the VT still holds its bottom border, but no pixels
    // are painted there. Full-cell sampling must detect this, not borrow ink
    // from the previous row. Restore before testing actual live output.
    await evaluate(`paintTest.terms.a.element.querySelector('.xterm-rows > div:last-child').style.visibility = 'hidden'`);
    try {
      await audit('a', { ...common, label: `${browser}-${theme}-missing-bottom-row` }, [ROWS - 1]);
    } finally {
      await evaluate(`paintTest.terms.a.element.querySelector('.xterm-rows > div:last-child').style.visibility = ''`);
    }

    /*
     * 8) Live streaming under perturbations: full-frame redraws at ~8 fps while
     * the tab is hidden and shown, the pane resized, the theme flipped twice,
     * and a snapshot injected mid-stream. The last live frame must be the
     * frame on screen, fully painted.
     */
    await evaluate(`(() => { const s = document.getElementById('paint-stage'); s.style.width = '560px'; s.style.height = '320px'; return true; })()`);
    await delay(300);
    const liveFrames = [];
    for (let i = 0; i < 12; i++) liveFrames.push(fullScreenScript({ rows: ROWS, cols: COLS, tag: String.fromCharCode(65 + i), statusRow: STATUS_ROW, cursorRow: 20, cursorCol: 10 }));
    await evaluate(`(() => {
      const frames = ${JSON.stringify(liveFrames)};
      const enc = new TextEncoder();
      paintTest.liveIndex = 0;
      paintTest.liveTimer = setInterval(() => {
        const text = String.fromCharCode(27) + '[H' + frames[paintTest.liveIndex % frames.length];
        paintTest.liveIndex += 1;
        const payload = enc.encode(text);
        const frame = new Uint8Array(payload.byteLength + 1);
        frame[0] = 0x01;
        frame.set(payload, 1);
        paintTest.sockets[0].emitBinary(frame.buffer);
      }, 120);
      return true;
    })()`);
    await delay(600);
    await evaluate(`(() => { paintTest.setActive('a', false); paintTest.setActive('b', true); return true; })()`);
    await delay(450);
    await evaluate(`(() => { paintTest.setActive('b', false); paintTest.setActive('a', true); return true; })()`);
    await delay(450);
    await evaluate(`(() => { const s = document.getElementById('paint-stage'); s.style.height = '280px'; return true; })()`);
    await delay(450);
    await transport.call((value) => { document.documentElement.dataset.theme = value; return true; }, theme === 'light' ? 'dark' : 'light');
    await delay(450);
    await transport.call((value) => { document.documentElement.dataset.theme = value; return true; }, theme);
    await delay(450);
    await evaluate(socketEmit(0, 0x03, SNAP2));
    await delay(900);
    await evaluate(`(() => { clearInterval(paintTest.liveTimer); return true; })()`);
    await delay(400);
    await audit('a', { ...common, label: `${browser}-${theme}-live` });
  }
  // Exercise passive pulse metadata through the real pane and AES-GCM viewer.
  // The only socket is the existing terminal viewer; all frames are synthetic.
  await transport.navigate(`http://127.0.0.1:${port}/qa.html?pulse=${Date.now()}`);
  await waitFor(() => evaluate(`document.readyState === 'complete'`), 'pulse page load');
  await evaluate(`(async () => { ${SETUP}
    const { BrowserFrameCipher } = await import('/src/terminal/e2ee.ts');
    const key = new Uint8Array(32).fill(7);
    paintTest.hostCipher = await BrowserFrameCipher.fromKey(key);
    paintTest.emitEncrypted = async (opcode, text) => {
      const payload = new TextEncoder().encode(text);
      const frame = new Uint8Array(payload.length + 1);
      frame[0] = opcode; frame.set(payload, 1);
      const sealed = await paintTest.hostCipher.seal(frame);
      paintTest.sockets[0].emitBinary(sealed.buffer);
    };
    paintTest.intervals = new Set();
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = (...args) => {
      const id = nativeSetInterval(...args); paintTest.intervals.add(id); return id;
    };
    window.clearInterval = (id) => { paintTest.intervals.delete(id); nativeClearInterval(id); };
    const fragment = '#key=' + btoa(String.fromCharCode(...key)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    paintTest.mount('c', false, fragment);
  })()`);
  await waitFor(() => evaluate(`paintTest.sockets.length === 1 && !!paintTest.terms.c`), 'encrypted viewer open');
  // Let the existing file-service probe finish before measuring outbound traffic.
  await delay(150);
  const sendsBeforePulse = await evaluate(`paintTest.sockets[0].sent.length`);
  await evaluate(`paintTest.emitEncrypted(0x03, 'Synthetic saved screen')`);
  await waitFor(() => evaluate(`paintTest.pulses.c?.activity === 'unobserved'`), 'snapshot pulse');
  assert.equal(await evaluate(`paintTest.pulses.c.bytesSinceViewed`), 0, 'snapshot does not create unread output');
  assert.equal(await evaluate(`paintTest.pulses.c.lastOutputAt`), null, 'snapshot does not imply live activity');
  await evaluate(`paintTest.emitEncrypted(0x01, '\\r\\nApproval required')`);
  await waitFor(() => evaluate(`paintTest.pulses.c?.bytesSinceViewed > 0 && paintTest.pulses.c?.hint?.label === 'Input may be needed'`), 'decrypted hidden output pulse');
  /*
   * Observed and published, and deliberately not drawn.
   *
   * The badge that used to sit over the session -- a coloured dot and a word
   * about whether output was arriving -- said nothing the conversation was
   * not already saying, in an accent that competed with the messages for the
   * same attention. Everything it was made of is still measured and still
   * reported upward, which is what every other assertion here is about; the
   * pane simply does not paint it over the terminal any more.
   */
  assert.equal(await evaluate(`!!document.querySelector('[data-paint-root="c"] .session-pulse')`), false, 'pulse is observed but not drawn over the session');
  await evaluate(`(() => { paintTest.setActive('c', true); return true; })()`);
  await waitFor(() => evaluate(`paintTest.pulses.c?.bytesSinceViewed === 0`), 'visible pane acknowledges output');
  assert.equal(await evaluate(`paintTest.sockets.length`), 1, 'pulse keeps the same viewer socket');
  assert.equal(await evaluate(`paintTest.sockets[0].sent.length`), sendsBeforePulse, 'pulse sends no requests');
  await evaluate(`(() => { paintTest.sockets[0].close(4000); return true; })()`);
  await waitFor(() => evaluate(`paintTest.pulses.c === null && !document.querySelector('[data-paint-root="c"] .session-pulse')`), 'disconnect purges pulse');
  await evaluate(`(() => { paintTest.roots.c.root.unmount(); return true; })()`);
  assert.equal(await evaluate(`paintTest.intervals.size`), 0, 'pane intervals cleaned up');
  const eventsAfterUnmount = await evaluate(`paintTest.pulseEvents.length`);
  await evaluate(`paintTest.emitEncrypted(0x01, 'Approval required')`);
  await delay(1100);
  assert.equal(await evaluate(`paintTest.pulseEvents.length`), eventsAfterUnmount, 'disposed pane does not publish pulse');
  assert.equal(await evaluate(`paintTest.sockets.length`), 1, 'unmount creates no socket');
  console.log('PASS passive pulse: encrypted output, snapshots, hidden unread, visible acknowledgement, not drawn, no network traffic, disconnect and timer cleanup');
  if (failures.length > 0) throw new Error(`paint audit failures (${failures.length}):\n- ${failures.join('\n- ')}`);
  console.log(`screenshots in ${shots}`);
} finally {
  await transport?.close();
  await server.close();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
