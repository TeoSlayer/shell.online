// Real Go host -> real workerd relay -> real browser (xterm) canary.
//
// An isolated synthetic terminal session runs a generic full-screen fixture
// (box border, per-row labels, coloured blocks, reverse-video status bar) and
// paints it once, then emits incremental updates past the host's replay-ring
// capacity. Repainting the entire screen on every tick hides replay bugs.
// The real app terminal (TerminalPane, xterm.js) opens
// that session through the Vite dev proxy against the real local relay, and
// the audit compares:
//   - the MCP observer against the browser at the same matched grid (both
//     receive host snapshots, so this comparison ALONE is not an oracle);
//   - the browser's pixels and DOM geometry against the fixture's shape.
// It then exercises live streaming, a tiny pane at the fitted-font floor, a
// second viewer (tab), a resize, and a forced reconnect (snapshot replay).
//
// Synthetic data only; no deployment, no linked account, no user session is
// touched. Output contains fixed check names; credentials and terminal content
// are never printed. SHELL_BROWSER=chrome switches browsers (Safari default).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPair, exportJWK } from "jose";
import { createServer as createViteServer } from "vite";
import { parseJsonc } from "./wrangler-config-contract.mjs";
import { launchChromeTransport, launchSafariTransport } from "./lib/browser-transport.mjs";
import { auditTextLayout } from "./lib/text-layout-audit.mjs";

if (process.platform === "win32") throw new Error("local PTY canary requires a POSIX shell");
const root = fileURLToPath(new URL("../", import.meta.url));
const browser = process.env.SHELL_BROWSER === "chrome" ? "chrome" : "safari";
const temp = mkdtempSync("/tmp/shell-live-browser-");
const configPath = join(temp, "wrangler.jsonc");
const pauseFile = join(temp, "pause");
const fixturePath = join(temp, "fixture.mjs");
const shots = mkdtempSync("/tmp/shell-live-browser-shots-");
const check = (ok, name) => { if (!ok) throw new Error(name); console.log("PASS " + name); };
let runtime, session, bearer, failed = false, transport, vite;
let stage = "runtime setup";
let secret = []; // redaction list; never printed

// The synthetic terminal process: a generic full-screen TUI, not an agent.
writeFileSync(fixturePath, `
import { existsSync } from "node:fs";
const pauseFile = process.argv[2];
let counter = 0;
function frame() {
  const cols = Math.max(40, process.stdout.columns || 120);
  const rows = Math.max(16, process.stdout.rows || 36);
  const tag = String(counter++).padStart(4, "0");
  const greenRow = Math.floor(rows / 2), blackRow = 1, statusRow = rows - 3;
  let out = "\\x1b[H";
  out += "┌" + "─".repeat(cols - 2) + "┐";
  for (let r = 1; r < rows - 1; r++) {
    let inner = (" ROW " + String(r).padStart(2, "0") + " " + tag + " ").padEnd(cols - 2, " ");
    if (r === blackRow) inner = "\\x1b[40m" + inner.slice(0, 10) + "\\x1b[0m" + inner.slice(10);
    if (r === greenRow) inner = inner.slice(0, 30) + "\\x1b[48;2;0;255;0m" + " ".repeat(Math.min(40, cols - 72)) + "\\x1b[0m" + inner.slice(70);
    if (r === statusRow) inner = "\\x1b[7m" + (" STATUS " + tag + " ").padEnd(cols - 2, " ") + "\\x1b[27m";
    out += "\\r\\n│" + inner + "│";
  }
  out += "\\r\\n└" + "─".repeat(cols - 2) + "┘";
  process.stdout.write(out);
}
process.stdout.write("\\x1b[2J");
frame();
// Evict the initial full screen before a viewer joins. A raw-tail snapshot
// now loses the border/header/status; a stateful snapshot must retain them.
process.stdout.write("\\x1b[12;35H12345678".repeat(40000));
setInterval(() => {
  if (!existsSync(pauseFile)) process.stdout.write("\\x1b[12;35H" + String(counter++).padStart(8, "0"));
}, 120);
process.stdout.on("resize", () => frame());
process.on("SIGTERM", () => process.exit(0));
`, { mode: 0o600 });

const reservation = createNetServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
process.env.SHELL_STAGING_URL = "http://127.0.0.1:" + port;
// The app reads the relay from VITE_RELAY_URL (Vite exposes prefixed process.env).
process.env.VITE_RELAY_URL = process.env.SHELL_STAGING_URL;
const h = await import("./staging-harness/lib.mjs");

/** A share URL the viewer can open by itself: the fragment must carry the password too. */
function browserShareUrl(record) {
  const url = new URL(record.share_url);
  if (record.e2ee_password && !url.hash.includes("password=")) {
    const params = new URLSearchParams(url.hash.replace(/^#/, ""));
    params.set("password", record.e2ee_password);
    url.hash = params.toString();
  }
  return url.toString();
}

const screenRows = (text) => String(text ?? "").split("\n").map((line) => line.replace(/\s+$/, ""));
async function hostScreen() {
  const result = await h.mcpCall(bearer, "shell_screen", {});
  if (result.status !== 200 || result.error) throw new Error("host screen unavailable");
  return screenRows(result.toolResult?.text ?? "");
}
async function frozenHostScreen() {
  writeFileSync(pauseFile, "1");
  let previous = await hostScreen();
  for (let i = 0; i < 40; i++) {
    await delay(150);
    const next = await hostScreen();
    if (next.length && next.join("\n") === previous.join("\n")) return next;
    previous = next;
  }
  throw new Error("fixture did not settle after pause");
}

const TEST_ENTRY_ID = "virtual:live-browser-test-entry";
const testEntryPlugin = {
  name: "live-browser-test-entry",
  resolveId(id) { return id === TEST_ENTRY_ID ? `\0${TEST_ENTRY_ID}.js` : null; },
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

const SETUP = (shareUrl) => `
  const { React, createRoot, BrowserRouter, TerminalPane, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider, Terminal } =
    await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  document.getElementById('root').style.display = 'none';
  globalThis.liveTest = { sockets: [], terms: {}, roots: {} };
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); globalThis.liveTest.sockets.push(this); }
  };
  const originalOpen = Terminal.prototype.open;
  Terminal.prototype.open = function (node) {
    const root = node.closest('[data-live-root]');
    if (root) globalThis.liveTest.terms[root.dataset.liveRoot] = this;
    return originalOpen.call(this, node);
  };
  const auth = {
    mode: 'firebase',
    user: { uid: 'live-test', email: 'live@test', displayName: 'Live', emailVerified: true, providerData: [] },
    initializing: false,
    signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {}, signInWithProvider: async () => {},
    resetPassword: async () => {}, resendVerification: async () => {}, signOutUser: async () => {}, deleteAccount: async () => {},
  };
  const stage = document.createElement('div');
  stage.id = 'live-stage';
  stage.style.cssText = 'position: fixed; top: 8px; left: 8px; z-index: 2147483647; width: 560px; height: 420px;';
  document.body.append(stage);
  globalThis.liveTest.mount = (key, active, url) => {
    const box = document.createElement('div');
    box.dataset.liveRoot = key;
    box.style.cssText = 'position: absolute; inset: 0;';
    stage.append(box);
    const tree = (on) => React.createElement(AuthContext.Provider, { value: auth },
      React.createElement(BrowserRouter, null,
        React.createElement(VaultProvider, null,
          React.createElement(TeamKeyProvider, null,
            React.createElement(FeedbackProvider, null,
              React.createElement(TerminalPane, { shareUrl: url, active: on, renderer: 'xterm' })
            )
          )
        )
      )
    );
    const rootNode = createRoot(box);
    globalThis.liveTest.roots[key] = { root: rootNode, tree };
    rootNode.render(tree(active));
  };
  globalThis.liveTest.setActive = (key, active) => {
    globalThis.liveTest.roots[key].root.render(globalThis.liveTest.roots[key].tree(active));
  };
  window.scrollTo(0, 0);
  return true;
`;

function auditExpression({ rootKey, roi, base64, greenRow, blackRow, statusRow }) {
  return `(() => (async () => {
    const root = document.querySelector('[data-live-root=${JSON.stringify(rootKey)}]');
    const pane = root && root.querySelector('.pane');
    const term = liveTest.terms[${JSON.stringify(rootKey)}];
    if (!pane || !term || !term.element) return { error: 'pane or terminal missing' };
    const screen = term.element.querySelector('.xterm-screen');
    const sr = screen.getBoundingClientRect();
    const pr = pane.querySelector('.pane-screen').getBoundingClientRect();
    const vb = term.buffer.active;
    const at = (r, c) => { const line = vb.getLine(vb.viewportY + r); const cell = line && line.getCell(c); return cell ? cell.getChars() : ''; };
    const report = {
      term: { cols: term.cols, rows: term.rows, baseY: vb.baseY, viewportY: vb.viewportY, fontSize: term.options.fontSize },
      screen: { x: sr.x, y: sr.y, w: sr.width, h: sr.height }, pane: { w: pr.width, h: pr.height },
      fits: sr.width <= pr.width + 1 && sr.height <= pr.height + 1 && sr.y >= pr.y - 1 && sr.y + sr.height <= pr.y + pr.height + 1,
      vt: { topLeft: at(0, 0) === '┌', topRight: at(0, term.cols - 1) === '┐', bottomLeft: at(term.rows - 1, 0) === '└', bottomRight: at(term.rows - 1, term.cols - 1) === '┘' },
    };
    const rowEls = [...term.element.querySelectorAll('.xterm-rows > div')];
    let prevBottom = null, contiguous = true, minH = Infinity, maxH = 0;
    for (const el of rowEls) {
      const b = el.getBoundingClientRect();
      if (b.height > 0) { minH = Math.min(minH, b.height); maxH = Math.max(maxH, b.height); }
      if (prevBottom !== null && Math.abs(b.top - prevBottom) > 1) contiguous = false;
      prevBottom = b.bottom;
    }
    report.dom = { rows: rowEls.length, contiguous, minH: Number.isFinite(minH) ? minH : null, maxH, lastBottomGap: prevBottom === null ? null : prevBottom - sr.bottom };
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
    let bg = null;
    for (const [x, y] of [[sr.right + 5, sr.top + 4], [sr.left - 5, sr.bottom + 5], [sr.left + 5, sr.bottom + 5]]) { const c = sample(x, y); if (c) { bg = c; break; } }
    const ink = (c) => diff(c, bg) > 60;
    const cols = term.cols, rows = term.rows;
    const cellW = sr.width / cols, cellH = sr.height / rows;
    const cellHasInk = (r, c) => {
      // Inspect every pixel centre inside the cell, not three scanlines that
      // can miss a one-pixel box border with Linux's tiny-font rasterization.
      const x0 = Math.max(0, Math.ceil((sr.left + c * cellW - ${JSON.stringify(roi.x)}) * sx - 0.5));
      const x1 = Math.min(cv.width, Math.ceil((sr.left + (c + 1) * cellW - ${JSON.stringify(roi.x)}) * sx - 0.5));
      const y0 = Math.max(0, Math.ceil((sr.top + r * cellH - ${JSON.stringify(roi.y)}) * sy - 0.5));
      const y1 = Math.min(cv.height, Math.ceil((sr.top + (r + 1) * cellH - ${JSON.stringify(roi.y)}) * sy - 0.5));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * cv.width + x) * 4;
        if (ink([px[i], px[i + 1], px[i + 2]])) return true;
      }
      return false;
    };
    const toolsEl = pane.querySelector('.pane-tools');
    const toolsBox = toolsEl && toolsEl.getBoundingClientRect();
    const hasTools = !!toolsBox && toolsBox.width > 0 && toolsBox.height > 0;
    /* The tools strip is legitimately drawn over the grid; a cell under it cannot be judged. */
    const covered = (r, c) => hasTools &&
      sr.left + c * cellW < toolsBox.right + 1 && sr.left + (c + 1) * cellW > toolsBox.left - 1 &&
      sr.top + r * cellH < toolsBox.bottom + 1 && sr.top + (r + 1) * cellH > toolsBox.top - 1;
    const rowsWithoutInk = [], borderGaps = [];
    for (let r = 0; r < rows; r++) {
      let hit = false;
      for (let c = 0; c < cols; c++) if (!covered(r, c) && cellHasInk(r, c)) { hit = true; break; }
      if (!hit && !covered(r, 0) && !covered(r, cols - 1)) rowsWithoutInk.push(r);
      if (r > 0 && r < rows - 1 && !((covered(r, 0) || cellHasInk(r, 0)) && (covered(r, cols - 1) || cellHasInk(r, cols - 1)))) borderGaps.push(r);
    }
    let greenPixels = 0, greenTotal = 0;
    for (let y = sr.top + (${greenRow} + 0.2) * cellH; y < sr.top + (${greenRow} + 0.8) * cellH; y += 0.5) {
      for (let x = sr.left + 31 * cellW; x < sr.left + 69 * cellW; x += 0.5) {
        const c = sample(x, y); greenTotal++;
        if (c && c[1] > 200 && c[0] < 120 && c[2] < 120) greenPixels++;
      }
    }
    let blackPixels = 0, blackTotal = 0;
    for (let y = sr.top + (${blackRow} + 0.2) * cellH; y < sr.top + (${blackRow} + 0.8) * cellH; y += 0.5) {
      for (let x = sr.left + 0.5 * cellW; x < sr.left + 9 * cellW; x += 0.5) {
        const c = sample(x, y); blackTotal++;
        if (ink(c)) blackPixels++;
      }
    }
    const barRows = [];
    let statusGlyphPixels = 0;
    for (let y = sr.top + (${statusRow} + 0.15) * cellH; y < sr.top + (${statusRow} + 0.85) * cellH; y += 0.25) {
      for (let x = sr.left + 2 * cellW; x < sr.left + 8 * cellW; x += 0.25) {
        const c = sample(x, y);
        if (c && Math.min(c[0], c[1], c[2]) > 130) statusGlyphPixels++;
      }
    }
    for (let y = sr.top + (${statusRow} - 1) * cellH; y < sr.top + (${statusRow} + 2) * cellH; y += 0.5) {
      let run = 0, best = 0;
      for (let x = sr.left; x < sr.left + sr.width; x += 0.5) { if (ink(sample(x, y))) { run += 0.5; if (run > best) best = run; } else run = 0; }
      if (best >= sr.width * 0.5) barRows.push(y);
    }
    const barTop = barRows.length ? barRows[0] : null, barBottom = barRows.length ? barRows[barRows.length - 1] + 0.5 : null;
    const stage = document.getElementById('live-stage').getBoundingClientRect();
    let stray = 0;
    for (let y = stage.top; y < stage.bottom; y += 2) for (let x = stage.left; x < stage.right; x += 2) {
      if (x > sr.left - 3 && x < sr.right + 3 && y > sr.top - 3 && y < sr.bottom + 3) continue;
      if (hasTools && x >= toolsBox.left - 2 && x <= toolsBox.right + 2 && y >= toolsBox.top - 2 && y <= toolsBox.bottom + 2) continue;
      if (ink(sample(x, y))) stray++;
    }
    report.paint = { rowsWithoutInk, borderGaps, greenCoverage: +(greenPixels / Math.max(greenTotal, 1)).toFixed(3), blackCoverage: +(blackPixels / Math.max(blackTotal, 1)).toFixed(3), stray,
      status: { top: barTop, bottom: barBottom, glyphPixels: statusGlyphPixels }, };
    return report;
  })())()`;
}

async function auditReport(rootKey, { label, greenRow, blackRow, statusRow }) {
  const stageRect = await evaluate(`(() => { const r = document.getElementById('live-stage').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const clip = `(() => { const r = document.getElementById('live-stage').getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 1 }; })()`;
  const roi = browser === "chrome"
    ? { x: Math.max(0, stageRect.x - 8), y: Math.max(0, stageRect.y - 8), width: stageRect.width + 16, height: stageRect.height + 16 }
    : { x: 0, y: 0, width: safariViewport.width, height: safariViewport.height };
  const data = await transport.screenshot(browser === "chrome" ? clip : undefined);
  const report = await evaluate(auditExpression({ rootKey, roi, base64: data, greenRow, blackRow, statusRow }));
  check(report && !report.error, `${label}: audit ran`);
  const image = Buffer.from(data, "base64");
  const imagePath = join(shots, `${label}.png`);
  writeFileSync(imagePath, image);
  writeFileSync(join(shots, `${label}.json`), JSON.stringify(report, null, 2));
  report.imagePath = imagePath;
  return report;
}

function assertAudit(report, label, statusRow) {
  check(report.vt.topLeft && report.vt.topRight && report.vt.bottomLeft && report.vt.bottomRight, `${label}: VT border cells`);
  check(report.paint.rowsWithoutInk.length === 0, `${label}: every row painted (missing: ${report.paint.rowsWithoutInk.join(',') || 'none'})`);
  check(report.paint.borderGaps.length === 0, `${label}: both border columns painted`);
  check(report.paint.greenCoverage >= 0.8, `${label}: green block painted`);
  check(report.paint.blackCoverage >= 0.5, `${label}: black block painted`);
  check(report.paint.status.glyphPixels > 0, `${label}: reverse-video status text is visible`);
  check(report.paint.stray <= 2, `${label}: no stray paint outside the grid`);
  check(report.fits, `${label}: grid fits the pane`);
  check(report.dom.rows === report.term.rows, `${label}: row strip count`);
  check(report.dom.contiguous, `${label}: rows contiguous`);
  check(report.dom.maxH - report.dom.minH <= 0.6, `${label}: row heights uniform`);
  check(Math.abs(report.dom.lastBottomGap) <= 1.5, `${label}: last row on the grid`);
  const expectedBarTop = report.screen.y + statusRow * (report.screen.h / report.term.rows);
  check(report.paint.status.top !== null && Math.abs(report.paint.status.top - expectedBarTop) <= 2, `${label}: status bar on its row`);
  console.log(`AUDIT ${label}: grid ${report.term.cols}x${report.term.rows} font ${report.term.fontSize} screen ${Math.round(report.screen.w)}x${Math.round(report.screen.h)} pane ${Math.round(report.pane.w)}x${Math.round(report.pane.h)} shot ${report.imagePath}`);
}

async function audit(rootKey, options) {
  const report = await auditReport(rootKey, options);
  assertAudit(report, options.label, options.statusRow);
  return report;
}

let safariViewport = { width: 0, height: 0 };
let evaluate = () => { throw new Error("page not ready"); };

try {
  const config = parseJsonc(readFileSync(join(root, "wrangler.example.jsonc"), "utf8"));
  config.name = "shell-online-live-browser-canary";
  config.main = join(root, "worker/index.ts");
  config.assets.directory = join(root, "dist");
  config.vars.MCP_CONTROL_ENABLED = "1";
  for (const key of ["MCP_ROUTE_KEY", "MCP_FRAME_KEY"]) {
    const pair = await generateKeyPair("ECDH-ES", { extractable: true });
    config.vars[key] = JSON.stringify({ ...await exportJWK(pair.privateKey), kid: key + "-local" });
  }
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  runtime = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
    "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", configPath,
    "--persist-to", join(temp, "state"), "--log-level", "error"], {
    cwd: root, detached: true, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (runtime.exitCode !== null) throw new Error("local runtime exited before readiness");
    try { ready = (await fetch(h.STAGING + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await delay(200);
  }
  check(ready, "real relay ready");
  stage = "create synthetic session";
  session = await h.createSession([process.execPath, fixturePath, pauseFile]);
  secret = [session.session_id, session.share_url, session.e2ee_password];
  check(/^[-A-Za-z0-9_]{32}$/.test(session.session_id || ""), "synthetic session created");
  bearer = await h.grant(session.session_id, "Browser canary " + "W".repeat(40), "control", 900);
  secret.push(bearer);
  stage = "fixture streaming";
  let live = await hostScreen();
  for (let i = 0; i < 50 && !(live.join("\n").includes("STATUS") && live.join("\n").includes("ROW 02")); i++) {
    await delay(150);
    live = await hostScreen();
  }
  check(live.join("\n").includes("STATUS") && live.join("\n").includes("ROW 02"), "generic fixture is streaming on the host");
  stage = "start browser";
  vite = await createViteServer({
    root: join(root, "app"),
    plugins: [testEntryPlugin],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  await vite.listen();
  const vitePort = vite.httpServer.address().port;
  transport = browser === "safari" ? await launchSafariTransport() : await launchChromeTransport({ profile: join(temp, "chrome") });
  evaluate = (expression) => transport.evaluate(expression);
  if (browser === "safari") {
    safariViewport = await transport.setViewport({ width: 1280, height: 820 });
    console.log(`safari viewport: ${safariViewport.width}x${safariViewport.height} @${safariViewport.dpr}x`);
  } else {
    await transport.setViewport({ width: 1280, height: 820, dpr: 2, mobile: false });
  }
  stage = "open viewer";
  await transport.navigate(`http://127.0.0.1:${vitePort}/qa.html?live=${Date.now()}`);
  await new Promise((r) => setTimeout(r, 800));
  await evaluate(`(async () => { ${SETUP(browserShareUrl(session))} })()`);
  await transport.call((url) => { liveTest.mount('a', true, url); return true; }, browserShareUrl(session));
  await waitForPage(() => evaluate(`liveTest.sockets.length >= 1 && liveTest.terms.a && liveTest.terms.a.buffer.active.getLine(0) && liveTest.terms.a.buffer.active.getLine(0).getCell(0) && liveTest.terms.a.buffer.active.getLine(0).getCell(0).getChars() === '┌'`), "viewer decrypted the snapshot");
  check(true, "real viewer connected and decrypted");

  stage = "host vs browser at a matched grid";
  const frozen = await frozenHostScreen();
  await delay(250);
  const first = await evaluate(`(() => {
    const t = liveTest.terms.a; const b = t.buffer.active; const rows = [];
    for (let i = 0; i < t.rows; i++) { const line = b.getLine(b.viewportY + i); rows.push(line ? line.translateToString(true) : ''); }
    return { cols: t.cols, rows: t.rows, lines: rows };
  })()`);
  console.log(`synthetic grid: browser=${first.cols}x${first.rows}, reference=${frozen[0]?.length}x${frozen.length}`);
  check(first.cols === frozen[0]?.length || frozen[0]?.length === 0, "grid width matches the host");
  let mismatches = 0;
  for (let i = 0; i < Math.min(first.rows, frozen.length); i++) if ((first.lines[i] ?? "") !== (frozen[i] ?? "")) mismatches += 1;
  check(mismatches === 0, "browser buffer matches the host VT screen row for row");
  check(frozen.length === first.rows, "host and browser agree on the row count");
  const rows = first.rows;
  const greenRow = Math.floor(rows / 2), blackRow = 1, statusRow = rows - 3;
  await audit("a", { label: `${browser}-frozen`, greenRow, blackRow, statusRow });

  // Keep the actual host paused and hide only a paint row. The audit must
  // catch missing pixels even though the decrypted VT border still exists.
  await transport.call(async () => {
    const style = document.createElement('style');
    style.id = 'negative-paint-control';
    style.textContent = '[data-live-root="a"] .xterm-rows > div:last-child { visibility: hidden !important; }';
    document.head.append(style);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  try {
    const missing = await auditReport("a", { label: `${browser}-missing-bottom-row`, greenRow, blackRow, statusRow });
    check(missing.vt.bottomLeft && missing.vt.bottomRight, "negative control retains actual VT border");
    check(JSON.stringify(missing.paint.rowsWithoutInk) === JSON.stringify([rows - 1]), "negative control detects exactly the unpainted row");
  } finally {
    await evaluate(`document.getElementById('negative-paint-control').remove()`);
  }

  stage = "live streaming and tiny pane";
  rmSync(pauseFile, { force: true });
  await delay(600);
  await evaluate(`(() => { const s = document.getElementById('live-stage'); s.style.height = '230px'; return true; })()`);
  await delay(500);
  await frozenHostScreen();
  const tinyReport = await auditReport("a", { label: `${browser}-tiny-live`, greenRow, blackRow, statusRow });
  const readBuffer = () => evaluate(`(() => {
    const t = liveTest.terms.a; const b = t.buffer.active; const lines = [];
    for (let i = 0; i < t.rows; i++) { const line = b.getLine(b.viewportY + i); lines.push(line ? line.translateToString(true) : ''); }
    return { cols: t.cols, rows: t.rows, lines };
  })()`);
  if (tinyReport.paint.borderGaps.length > 0) {
    console.log(`OBSERVED ${browser}-tiny-live before rebuild: borderGaps ${JSON.stringify(tinyReport.paint.borderGaps)} stray ${tinyReport.paint.stray} shot ${tinyReport.imagePath}`);
    const domDump = await evaluate(`(() => {
      const t = liveTest.terms.a;
      const rows = [...t.element.querySelectorAll('.xterm-rows > div')];
      const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const info = (r) => {
        const el = rows[r]; if (!el) return null;
        const b = el.getBoundingClientRect();
        const spans = [...el.querySelectorAll('span')];
        const last = spans[spans.length - 1];
        const lb = last ? last.getBoundingClientRect() : null;
        const line = t.buffer.active.getLine(t.buffer.active.viewportY + r);
        const cells = [118, 119].map((c) => { const cell = line && line.getCell(c); return cell ? JSON.stringify(cell.getChars()) : '?'; });
        return { r, rowW: +b.width.toFixed(2), spanCount: spans.length,
          lastSpan: last ? { text: JSON.stringify(last.textContent.slice(-4)), x: +lb.x.toFixed(2), w: +lb.width.toFixed(2), right: +(lb.x + lb.width).toFixed(2) } : null,
          cells, screenRight: +screen.right.toFixed(2) };
      };
      return [1, 2, 3, 4, 5, 6].map(info);
    })()`);
    for (const entry of domDump) console.log('DOM ' + JSON.stringify(entry));
    const hitTest = await evaluate(`(() => {
      const points = [[337, 34], [336, 42], [342.5, 48], [337, 58], [330.5, 59]];
      return points.map(([x, y]) => ({
        x, y,
        stack: document.elementsFromPoint(x, y).slice(0, 4).map((el) => {
          const r = el.getBoundingClientRect();
          return el.tagName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.') + ' @' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
        }),
      }));
    })()`);
    for (const entry of hitTest) console.log('HIT ' + JSON.stringify(entry));
    const before = await readBuffer();
    const levers = [
      ["refresh", "t.refresh(0, t.rows - 1);"],
      ["same-resize", "t.resize(t.cols, t.rows);"],
      ["row-cycle", "t.resize(t.cols, t.rows + 1); t.resize(t.cols, t.rows);"],
      ["font-nudge", "const f = t.options.fontSize; t.options.fontSize = f + 0.25; t.options.fontSize = f;"],
      ["layer-nudge", "const s = document.getElementById('live-stage'); s.style.transform = 'translateZ(0)'; s.getBoundingClientRect(); s.style.transform = '';"],
    ];
    let cleared = null;
    for (const [name, code] of levers) {
      await evaluate(`(() => { const t = liveTest.terms.a; ${code} return true; })()`);
      await delay(300);
      const trial = await auditReport("a", { label: `${browser}-tiny-lever-${name}`, greenRow, blackRow, statusRow });
      console.log(`LEVER ${name}: borderGaps ${JSON.stringify(trial.paint.borderGaps)} stray ${trial.paint.stray} shot ${trial.imagePath}`);
      if (trial.paint.borderGaps.length === 0 && !cleared) cleared = name;
    }
    const after = await readBuffer();
    check(JSON.stringify(before) === JSON.stringify(after), "rebuild levers leave the buffer content unchanged");
    check(cleared !== null, `rebuild lever clears the stale rows (cleared by: ${cleared ?? "none"})`);
    console.log(`REBUILD stale rows cleared by: ${cleared ?? "none"}`);
  } else {
    assertAudit(tinyReport, `${browser}-tiny-live`, statusRow);
  }

  stage = "second viewer and tab switch";
  await transport.call((url) => { liveTest.mount('b', false, url); return true; }, browserShareUrl(session));
  await waitForPage(() => evaluate(`liveTest.terms.b && liveTest.terms.b.buffer.active.getLine(0) && liveTest.terms.b.buffer.active.getLine(0).getCell(0) && liveTest.terms.b.buffer.active.getLine(0).getCell(0).getChars() === '┌'`), "second viewer decrypted");
  await evaluate(`(() => { liveTest.setActive('a', false); liveTest.setActive('b', true); return true; })()`);
  await delay(500);
  await frozenHostScreen();
  await audit("b", { label: `${browser}-tab-b`, greenRow, blackRow, statusRow });
  await evaluate(`(() => { liveTest.setActive('b', false); liveTest.setActive('a', true); return true; })()`);
  await delay(500);

  stage = "resize and reconnect (snapshot replay)";
  await evaluate(`(() => { const s = document.getElementById('live-stage'); s.style.width = '700px'; s.style.height = '520px'; return true; })()`);
  await delay(600);
  await evaluate(`(() => {
    const socket = liveTest.sockets[0];
    try { socket.close(4001, 'canary reconnect'); } catch {}
    /* A dropped link is what the retry path sees; the close event is what it acts on. */
    socket.dispatchEvent(new CloseEvent('close', { code: 4001 }));
    return true;
  })()`);
  try {
    await waitForPage(() => evaluate(`(() => { const s = liveTest.sockets; return s.length >= 3 && s[s.length - 1].readyState === 1; })()`), "viewer reconnected", 15000);
  } catch (error) {
    const states = await evaluate(`liveTest.sockets.map((s) => s.readyState)`).catch(() => null);
    throw new Error(`viewer reconnected (states ${JSON.stringify(states)})`);
  }
  await delay(800);
  const frozenNow = await frozenHostScreen();
  const after = await evaluate(`(() => {
    const t = liveTest.terms.a; const b = t.buffer.active; const rows = [];
    for (let i = 0; i < t.rows; i++) { const line = b.getLine(b.viewportY + i); rows.push(line ? line.translateToString(true) : ''); }
    return { cols: t.cols, rows: t.rows, lines: rows };
  })()`);
  let replayMismatches = 0; const mismatchRows = [];
  for (let i = 0; i < Math.min(after.rows, frozenNow.length); i++) if ((after.lines[i] ?? "") !== (frozenNow[i] ?? "")) { replayMismatches += 1; if (mismatchRows.length < 6) mismatchRows.push(i); }
  check(replayMismatches === 0, `after reconnect the buffer matches the host again (rows ${mismatchRows.join(",")}, host rows ${frozenNow.length}, browser rows ${after.rows})`);
  await audit("a", { label: `${browser}-after-reconnect`, greenRow, blackRow, statusRow });

  stage = "public session responsive layout";
  // Real /s/* page, not the isolated app pane. Navigate away from the app
  // first so its viewers cannot impose a competing canonical grid.
  await transport.navigate(browserShareUrl(session));
  await waitForPage(() => evaluate(`!!document.querySelector('#terminal .xterm-screen') && document.querySelector('#session-status').classList.contains('connected')`), "public viewer decrypted");
  for (const theme of ["light", "dark"]) {
  await evaluate(`(() => {document.getElementById('settings-open').click();document.querySelector('#theme-options [data-theme="${theme}"]').click();document.getElementById('settings-close').click();})()`);
  const colors = await evaluate(`(() => {const page=document.querySelector('.session-page'),header=document.querySelector('.session-header'),button=document.getElementById('settings-open');return {scheme:getComputedStyle(page).colorScheme,paper:getComputedStyle(page).backgroundColor,header:getComputedStyle(header).backgroundColor,button:getComputedStyle(button).color,saved:localStorage.getItem('shell-online-terminal-theme')};})()`);
  check(colors.scheme===theme && colors.saved===theme && colors.paper===colors.header && colors.paper===(theme==='dark'?'rgb(22, 25, 20)':'rgb(243, 241, 233)'), `${browser} public ${theme}: real preference and shared brand palette`);
  for (const [width, height] of [[1440,900],[901,768],[900,768],[761,700],[760,700],[561,700],[560,700],[481,700],[480,700],[371,700],[370,700],[320,640],[390,844],[850,480],[600,480],[844,390],[667,375],[1024,480],[1440,900]]) {
    await transport.setViewport({ width, height, dpr: 1, mobile: false });
    await delay(350);
    // Stress only the synthetic fixture's displayed label. Do not change the
    // session's authorization or connection state to manufacture a pass.
    await evaluate(`document.getElementById('session-label').textContent='Synthetic terminal '+ 'W'.repeat(96)`);
    const layout = await evaluate(`(() => {
      const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,b:r.bottom}};
      return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,page:rect('.session-page'),header:rect('.session-header'),identity:rect('.session-identity'),actions:rect('.session-actions'),screen:rect('#terminal .xterm-screen'),wrap:rect('#terminal-wrap'),settings:rect('#settings-open'),report:rect('#issue-open')};
    })()`);
    writeFileSync(join(shots, `${browser}-public-${theme}-${layout.width}-${layout.height}.png`), Buffer.from(await transport.screenshot(), "base64"));
    check(!layout.overflow, `${browser} public ${layout.width}x${layout.height}: no page overflow`);
    check(layout.page.b <= layout.height + 2 && layout.screen.b <= layout.wrap.b + 2 && layout.screen.right <= layout.wrap.right + 2, `${browser} public ${layout.width}: complete terminal fits`);
    const keyStrip = await evaluate(`(() => {
      const bar=document.getElementById('mobile-terminal-keys');
      if(!bar.checkVisibility())return {visible:false};
      const buttons=[...bar.querySelectorAll('button')], first=buttons[0].getBoundingClientRect();
      const oneRow=buttons.every(b=>Math.abs(b.getBoundingClientRect().top-first.top)<=1);
      const targets=buttons.every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44});
      bar.scrollLeft=bar.scrollWidth;
      const last=buttons.at(-1).getBoundingClientRect(), bounds=bar.getBoundingClientRect();
      const reachable=last.left>=bounds.left&&last.right<=bounds.right+1;
      bar.scrollLeft=0;
      return {visible:true,oneRow,targets,reachable};
    })()`);
    check(!keyStrip.visible || (keyStrip.oneRow && keyStrip.targets && keyStrip.reachable), `${browser} public ${layout.width}: keys stay in one row, finger-sized and scroll-reachable`);
    check(layout.settings.x >= 0 && layout.settings.right <= layout.width && layout.report.x >= 0 && layout.actions.b <= layout.header.b + 2, `${browser} public ${layout.width}: header actions fit`);
    if (layout.width > 760) check(layout.identity.right <= layout.actions.x + 2, `${browser} public ${layout.width}: identity does not overlap controls`);
    const disclosure = await evaluate(`(() => {
      const badge=document.getElementById('session-encryption'),r=badge.getBoundingClientRect(),identity=badge.parentElement.getBoundingClientRect(),status=document.getElementById('session-status').getBoundingClientRect();
      return {visible:!badge.hidden && r.width>0 && r.x>=identity.x && r.right<=identity.right+1,statusVisible:status.right<=identity.right+1,compact:getComputedStyle(badge,'::after').content,hasMcp:badge.textContent.includes('MCP')};
    })()`);
    check(disclosure.visible && disclosure.statusVisible && (layout.width>760 || !disclosure.hasMcp || disclosure.compact.includes('MCP')), `${browser} public ${layout.width}: connection and MCP disclosure stay visible`);
    const labels = await transport.call(auditTextLayout, {selectors:['#session-label','#session-status','.presence-agent','.presence-more'],groups:['.session-identity','.session-actions'],complete:['#session-status','.presence-more']});
    check(labels.length===0, `${browser} public ${layout.width}: labels and badges fit (${labels.join(', ')})`);
    await evaluate(`(()=>{const p=document.getElementById('presence');p.scrollLeft=p.scrollWidth;})()`);
    await delay(80);
    check(await evaluate(`(()=>{const p=document.getElementById('presence'),b=p.lastElementChild;if(!b||!p.checkVisibility())return true;const r=b.getBoundingClientRect(),v=p.getBoundingClientRect();return r.right<=v.right+2&&r.left>=v.left-2;})()`), `${browser} public ${layout.width}: last presence badge is reachable`);
    await evaluate(`document.getElementById('settings-open').click()`);
    await delay(220);
    const dialog = await evaluate(`(() => {
      const d=document.getElementById('terminal-settings'),r=d.getBoundingClientRect(),c=d.querySelector('.settings-content');
      c.scrollTop=c.scrollHeight;
      const last=c.lastElementChild.getBoundingClientRect(),box=c.getBoundingClientRect();
      return {open:d.open,x:r.x,y:r.y,right:r.right,b:r.bottom,width:innerWidth,height:innerHeight,lastVisible:last.bottom<=box.bottom+2};
    })()`);
    check(dialog.open && dialog.x >= 0 && dialog.y >= 0 && dialog.right <= dialog.width + 2 && dialog.b <= dialog.height + 2 && dialog.lastVisible, `${browser} public ${layout.width}: controls dialog fits and scrolls`);
    if (width===390 || width===1440) writeFileSync(join(shots, `${browser}-controls-${theme}-${width}.png`), Buffer.from(await transport.screenshot(), "base64"));
    await evaluate(`document.getElementById('settings-close').click()`);
  }
  }
  await evaluate(`(() => {document.getElementById('settings-open').click();document.querySelector('#theme-options [data-theme="system"]').click();document.getElementById('settings-close').click();})()`);
  for(const theme of transport.setEmulatedTheme ? ['dark','light'] : [await evaluate(`matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'`)]) {
    if (transport.setEmulatedTheme) await transport.setEmulatedTheme(theme);
    await delay(100);
    check(await evaluate(`document.querySelector('.session-page').classList.contains('theme-${theme}') && localStorage.getItem('shell-online-terminal-theme')===null`), `${browser} public system preference: ${theme}`);
  }

  stage = "public password gate responsive layout";
  await evaluate(`(() => {sessionStorage.clear();localStorage.clear();})()`);
  const lockedLink = new URL(session.share_url);
  const lockedFragment = new URLSearchParams(lockedLink.hash.slice(1));
  lockedFragment.delete("password");
  lockedLink.hash = lockedFragment.toString();
  // A fragment-only navigation would retain the current in-memory cipher.
  await transport.navigate("about:blank");
  await transport.navigate(lockedLink.toString());
  await waitForPage(() => evaluate(`!!document.querySelector('.encryption-gate:not([hidden])')`), "password required on a fresh viewer");
  for (const theme of ['light','dark']) {
  // Header switch remains reachable before the password is supplied.
  await evaluate(`(() => {if(!document.querySelector('.session-page').classList.contains('theme-${theme}'))document.getElementById('theme-toggle').click();})()`);
  for (const [width, height] of [[320,640],[760,480],[1024,768]]) {
    await transport.setViewport({width,height,dpr:1,mobile:false});
    await evaluate(`(() => {const help=document.querySelector('.encryption-help');if(help)help.open=true;})()`);
    await delay(150);
    const gate = await evaluate(`(() => {
      const g=document.querySelector('.encryption-gate'),p=document.querySelector('.encryption-panel');
      g.scrollTop=0;const top=p.getBoundingClientRect().top,box=g.getBoundingClientRect();
      g.scrollTop=g.scrollHeight;const bottom=p.getBoundingClientRect().bottom;
      return {top,gateTop:box.top,bottom,gateBottom:box.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    check(!gate.overflow && gate.top>=gate.gateTop-1 && gate.bottom<=gate.gateBottom+1, `${browser} password ${width}: expanded help and form are reachable`);
    writeFileSync(join(shots, `${browser}-password-${theme}-${width}.png`), Buffer.from(await transport.screenshot(), "base64"));
  }
  }

  console.log(`screenshots in ${shots}`);
} catch (error) {
  failed = true;
  console.error("FAIL real-runtime browser canary: " + stage);
  console.error(h.redact(error?.message ?? "failed", secret.filter(Boolean)).slice(0, 300));
} finally {
  try { rmSync(pauseFile, { force: true }); } catch {}
  if (session) {
    try {
      const cleanup = await h.cleanupSession(session.session_id, { verifyBearer: bearer });
      if (!cleanup.clean) { failed = true; console.error("FAIL verified session cleanup"); }
      else console.log("PASS verified session cleanup");
    } catch { failed = true; console.error("FAIL verified session cleanup"); }
  }
  if (runtime) { try { process.kill(-runtime.pid, "SIGTERM"); } catch {} await delay(300); }
  try { await transport?.close(); } catch {}
  try { await vite?.close(); } catch {}
  rmSync(temp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

async function waitForPage(probe, label, timeout = 25000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { if (await probe()) return; lastError = null; } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(lastError ? `${label} (${lastError.message})` : label);
}
