// Browser fixture for the keep's MCP request panel and canvas layer, as the
// user actually sees them.
//
// It composes a route-like stage: a real pixi canvas with real target markers
// and the real McpFlowLayer arrows, and the real McpFlows panel over it in a
// transparent overlay (the game's own .keep class is used only for its
// variables; its opaque fixed background is neutralized inline so the canvas
// behind it is the canvas in the screenshot). The panel is expanded before
// every capture.
//
// Proven, in Chrome and Safari, at desktop and compact sizes:
//   - the canvas is visibly rendered: it is in the composited screenshot with
//     its background and arrow pixels, and hit-testing at points along the
//     arrows finds the canvas with no opaque element above it;
//   - the panel is open, on screen, readable, and does not occlude the arrows;
//   - every row points at a real figure on this field, with a distinct status
//     ("Input delivered", "Wait timed out", ...), and none says the agent
//     finished;
//   - other accounts' and ended sessions never appear; no sender is invented;
//   - the panel empties on its own clock under a hung fetch, and no flows
//     survive an account change.
// Synthetic data only; no login, relay, or deploy. SHELL_BROWSER=safari runs
// the same fixture through safaridriver (its driver cannot emulate a smaller
// viewport, so the compact pass there is a compact stage in the real window).
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport, launchSafariTransport } from '../../scripts/lib/browser-transport.mjs';

const browser = process.env.SHELL_BROWSER === 'safari' ? 'safari' : 'chrome';
const here = dirname(fileURLToPath(import.meta.url));
const profile = browser === 'chrome' ? await mkdtemp(join(tmpdir(), 'shell-game-flows-')) : null;
const shots = await mkdtemp(join(browser === 'safari' ? '/tmp' : tmpdir(), 'shell-game-flows-shots-'));
const TEST_ENTRY_ID = 'virtual:game-flows-test-entry';
const FIREBASE_STUB = join(here, 'fixtures', 'firebase-stub.ts');

const testEntryPlugin = {
  name: 'game-flows-test-entry',
  enforce: 'pre',
  resolveId(id, importer) {
    if (id === TEST_ENTRY_ID) return `\0${TEST_ENTRY_ID}.js`;
    if (id === './firebase' && importer && importer.endsWith('/src/lib/api.ts')) return FIREBASE_STUB;
    return null;
  },
  load(id) {
    if (id !== `\0${TEST_ENTRY_ID}.js`) return null;
    return `
      import * as ReactModule from 'react';
      import { createRoot } from 'react-dom/client';
      import 'pixi.js/unsafe-eval';
      import { Application, Container, Graphics, Text } from 'pixi.js';
      import { McpFlows } from '/src/game/ui/McpFlows.tsx';
      import { useGarrison } from '/src/game/state/use-garrison.ts';
      import { useExpiringMcpFlows } from '/src/game/state/mcp-flows.ts';
      import { createSim } from '/src/game/pixi/keepScene.ts';
      import { DEMO_ROSTER } from '/src/game/state/demo-garrison.ts';
      import { McpFlowLayer } from '/src/game/pixi/mcp-flows.ts';
      import { toScreen, ORIGIN_X } from '/src/game/world/iso.ts';
      import { AuthContext } from '/src/auth/AuthProvider.tsx';
      import '/src/styles/game.css';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, Application, Container, Graphics, Text, McpFlows, useGarrison, useExpiringMcpFlows, createSim, DEMO_ROSTER, McpFlowLayer, toScreen, ORIGIN_X, AuthContext };
    `;
  },
};

const server = await createServer({
  root: join(here, '..'),
  plugins: [testEntryPlugin],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent',
});
let transport;
let evaluate = () => { throw new Error('page not ready'); };
const waitFor = async (check, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { if (await check()) return; lastError = null; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(lastError ? `Timed out: ${label} (${lastError.message})` : `Timed out: ${label}`);
};

const ID = '6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f';
const OTHER_ID = '6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d9f8e';

const SETUP = (compact) => `
  const { React, createRoot, Application, Container, Graphics, Text, McpFlows, useGarrison, useExpiringMcpFlows, createSim, DEMO_ROSTER, McpFlowLayer, toScreen, ORIGIN_X, AuthContext } =
    await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  const shortTtl = 1200;
  const now = Date.now();
  const sessionRow = (id, owner, extra = {}) => ({
    id, uid: owner, orgId: 'org-1', ownerUid: owner, shareUrl: location.origin + '/s/' + id,
    command: 'htop', readOnly: false, encrypted: true, persistent: false, host: 'laptop',
    relayStatus: 'connected', startedAt: now - 60_000, ...extra,
  });
  globalThis.gameBackend = {
    uid: 'owner-1',
    sessions: [
      sessionRow('live-1', 'owner-1'),
      sessionRow('live-2', 'owner-1'),
      sessionRow('ended-1', 'owner-1', { closedAt: now - 1000 }),
      sessionRow('other-1', 'other-owner'),
    ],
    members: [{ uid: 'owner-1', email: 'o@x', name: 'Owner', role: 'owner' }],
    you: { uid: 'owner-1', email: 'o@x', name: 'Owner', role: 'owner' },
    flows: [
      { id: '${ID}', targetSessionId: 'live-1', tool: 'shell_send', phase: 'started', at: now - 500 },
      { id: '${ID}', targetSessionId: 'live-1', tool: 'shell_send', phase: 'settled', at: now - 400, outcome: 'delivered' },
      { id: '${ID}', targetSessionId: 'live-2', tool: 'shell_screen', phase: 'settled', at: now - 300, outcome: 'timeout' },
      { id: '${OTHER_ID}', targetSessionId: 'ended-1', tool: 'shell_status', phase: 'settled', at: now - 200, outcome: 'ok' },
      { id: '${OTHER_ID}', targetSessionId: 'other-1', tool: 'shell_status', phase: 'settled', at: now - 100, outcome: 'ok' },
    ],
    sessionFetches: 0, hangSessions: false, freezeFlows: false, flowCalls: 0,
  };
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    const backend = globalThis.gameBackend;
    if (path === '/api/sessions') {
      backend.sessionFetches += 1;
      if (backend.hangSessions) return new Promise(() => {});
      return json({ sessions: backend.sessions, members: backend.members, you: backend.you });
    }
    if (path === '/api/game/mcp-flows') {
      backend.flowCalls += 1;
      if (backend.freezeFlows) return json({ flows: backend.flows });
      return json({ flows: backend.flows.map((flow) => ({ ...flow, at: Date.now() - 300 })) });
    }
    return json({});
  };

  /* Tile coordinates near the map centre, so the projection lands on stage. */
  const actors = [
    { id: 'a1', x: 70, y: 66, name: 'Wright One', session: { id: 'live-1', startedAt: 0, host: 'laptop', command: 'htop' } },
    { id: 'a2', x: 75, y: 65, name: 'Wright Two', session: { id: 'live-2', startedAt: 0, host: 'laptop', command: 'htop' } },
  ];

  const compact = ${compact ? 'true' : 'false'};
  const targetWidth = Math.max(360, Math.min(compact ? 440 : 900, window.innerWidth - 16));
  const targetHeight = Math.max(420, Math.min(compact ? 640 : 560, window.innerHeight - 16));
  const stage = document.createElement('div');
  stage.id = 'game-stage';
  document.body.append(stage);

  const app = new Application();
  await app.init({ width: targetWidth, height: targetHeight, background: 0x15212c, antialias: true });
  app.canvas.id = 'game-canvas';
  app.canvas.style.cssText = 'display: block; width: 100%; height: 100%;';
  stage.append(app.canvas);

  /*
   * The projection is in map pixels (thousands); a camera brings the scene
   * into the stage, exactly like the keep's own camera container holds the
   * field. Its offset is computed from the real projected points, never a
   * guessed map centre.
   */
  const camera = new Container();
  app.stage.addChild(camera);

  /* Real target markers: one per live, owned session, drawn at its figure. */
  const markers = new Graphics();
  const labels = [];
  for (const actor of actors) {
    const at = toScreen(actor.x, actor.y);
    markers.circle(at.x, at.y, 18).fill(0x3e3324).stroke({ width: 4, color: 0xe8b44a });
    const label = new Text({ text: actor.name, style: { fontFamily: 'sans-serif', fontSize: 22, fill: 0xf3f1e9, stroke: { color: 0x120d08, width: 4 } } });
    label.position.set(at.x - 46, at.y + 26);
    labels.push(label);
  }
  camera.addChild(markers);
  for (const label of labels) camera.addChild(label);
  const flowLayer = new McpFlowLayer(camera);

  /*
   * Everything the picture must show: the projected session figures, the
   * neutral external-client marker, and the label extents around them (the
   * layer's own offsets for the marker and its caption).
   */
  const actorPoints = actors.map((actor) => toScreen(actor.x, actor.y));
  const sourcePoint = { x: actorPoints[0].x - 170, y: actorPoints[0].y - 170 };
  const sceneBox = (() => {
    const boxes = [];
    for (const point of actorPoints) boxes.push({ minX: point.x - 70, maxX: point.x + 70, minY: point.y - 40, maxY: point.y + 80 });
    boxes.push({ minX: sourcePoint.x - 140, maxX: sourcePoint.x + 150, minY: sourcePoint.y - 60, maxY: sourcePoint.y + 60 });
    return {
      minX: Math.min(...boxes.map((box) => box.minX)), maxX: Math.max(...boxes.map((box) => box.maxX)),
      minY: Math.min(...boxes.map((box) => box.minY)), maxY: Math.max(...boxes.map((box) => box.maxY)),
    };
  })();

  const cameraState = { scale: 1, offsetX: 0, offsetY: 0, visible: null };
  function fitScene() {
    const width = stage.clientWidth > 0 ? stage.clientWidth : targetWidth;
    const height = stage.clientHeight > 0 ? stage.clientHeight : targetHeight;
    const stageRect = stage.getBoundingClientRect();
    const panel = document.querySelector('.keep-mcp-flows');
    /* Always fit for the expanded panel: that is what the screenshots show. */
    if (panel && !panel.open) panel.open = true;
    const panelRect = panel ? panel.getBoundingClientRect() : null;
    const boxWidth = Math.max(1, sceneBox.maxX - sceneBox.minX);
    const boxHeight = Math.max(1, sceneBox.maxY - sceneBox.minY);
    /*
     * The panel owns the top-left, so the free space is an L. Try the room
     * below it and the room beside it, and keep whichever lets the scene be
     * drawn largest: a narrow strip beside a wide panel loses to the full-width
     * band under it, and vice versa.
     */
    const margin = 12;
    const below = {
      x: margin,
      y: Math.min(height - 60, (panelRect ? panelRect.bottom - stageRect.top : 0) + margin),
      w: Math.max(0, width - margin * 2),
      h: 0,
    };
    below.h = Math.max(0, height - below.y - margin);
    const beside = {
      x: Math.min(width - 60, (panelRect ? panelRect.right - stageRect.left : 0) + margin),
      y: margin,
      w: 0,
      h: Math.max(0, height - margin * 2),
    };
    beside.w = Math.max(0, width - beside.x - margin);
    const candidates = [below, beside].filter((box) => box.w > 40 && box.h > 40);
    const scaleFor = (box) => Math.min(box.w / boxWidth, box.h / boxHeight, 1.5);
    let visible = candidates[0] ?? { x: margin, y: margin, w: width - margin * 2, h: height - margin * 2 };
    let scale = scaleFor(visible);
    for (const candidate of candidates) {
      const candidateScale = scaleFor(candidate);
      if (candidateScale > scale) { visible = candidate; scale = candidateScale; }
    }
    const centre = { x: (sceneBox.minX + sceneBox.maxX) / 2, y: (sceneBox.minY + sceneBox.maxY) / 2 };
    camera.scale.set(scale);
    camera.position.set(visible.x + visible.w / 2 - centre.x * scale, visible.y + visible.h / 2 - centre.y * scale);
    Object.assign(cameraState, { scale, offsetX: camera.position.x, offsetY: camera.position.y, visible });
    app.renderer.render(app.stage);
  }
  function fitStage(width, height) {
    stage.style.cssText = 'position: fixed; top: 8px; left: 8px; z-index: 1; width: ' + width + 'px; height: ' + height + 'px;';
    app.renderer.resize(width, height);
    fitScene();
    flowLayer.sync(globalThis.gameVisual ? globalThis.gameVisual.flows : [], actors, Date.now());
    app.renderer.render(app.stage);
  }
  fitStage(targetWidth, targetHeight);

  /*
   * The overlay carries .keep for its variables only; its opaque fixed
   * background is overridden inline so the canvas behind it is what a
   * screenshot shows. The panel inside keeps pointer events to itself.
   */
  const overlay = document.createElement('div');
  overlay.id = 'game-overlay';
  overlay.className = 'keep';
  overlay.setAttribute('style', 'position: absolute; inset: 0; background: transparent !important; pointer-events: none; overflow: visible;');
  stage.append(overlay);

  globalThis.gameVisual = {
    compact,
    flows: [],
    actors,
    camera: cameraState,
    stage: () => stage.getBoundingClientRect(),
    resize: (width, height) => fitStage(width, height),
    fitVisible: () => fitScene(),
    expand: () => { const panel = document.querySelector('.keep-mcp-flows'); if (panel) panel.open = true; return !!panel; },
    probe: () => {
      const rect = (value) => value ? { x: value.x, y: value.y, width: value.width, height: value.height,
        top: value.top, bottom: value.bottom, left: value.left, right: value.right } : null;
      const canvas = app.canvas.getBoundingClientRect();
      const panel = document.querySelector('.keep-mcp-flows');
      const panelRect = panel ? panel.getBoundingClientRect() : null;
      app.renderer.render(app.stage);
      const canvasRect = app.canvas.getBoundingClientRect();
      const toViewport = (world) => {
        const point = camera.toGlobal({ x: world.x, y: world.y });
        return { x: canvasRect.left + point.x, y: canvasRect.top + point.y };
      };
      const source = toViewport(sourcePoint);
      const samples = [];
      for (const actor of actors) {
        const target = toViewport(toScreen(actor.x, actor.y));
        for (const fraction of [0.3, 0.6]) {
          const point = { x: source.x + (target.x - source.x) * fraction, y: source.y + (target.y - source.y) * fraction };
          const stack = document.elementsFromPoint(point.x, point.y);
          const canvasIndex = stack.indexOf(app.canvas);
          const above = canvasIndex >= 0 ? stack.slice(0, canvasIndex) : stack;
          const blockers = above.filter((element) => {
            const style = getComputedStyle(element);
            const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none';
            return painted || style.pointerEvents !== 'none';
          }).map((element) => element.id || String(element.className).slice(0, 24));
          const insidePanel = panelRect && point.x >= panelRect.left && point.x <= panelRect.right && point.y >= panelRect.top && point.y <= panelRect.bottom;
          samples.push({ ...point, canvasInStack: canvasIndex >= 0, blockers, insidePanel, unobstructed: canvasIndex >= 0 && blockers.length === 0 && !insidePanel });
        }
      }
      const rows = panel ? [...panel.querySelectorAll('.keep-mcp-flows-list li')].map((item) => {
        const rect = item.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          target: item.querySelector('.keep-mcp-flows-target').textContent,
          tool: item.querySelector('.keep-mcp-flows-tool').textContent,
          status: item.querySelector('.keep-mcp-flows-status').textContent,
          outcome: item.dataset.outcome, phase: item.dataset.phase,
          visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
          hit: hit === item || item.contains(hit),
        };
      }) : [];
      return {
        open: !!panel && panel.open,
        stage: rect(stage.getBoundingClientRect()), canvas: rect(canvas), panel: rect(panelRect), rows, samples,
        scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
        text: panel ? panel.textContent : '',
        summaryFont: panel ? parseFloat(getComputedStyle(panel.querySelector('summary')).fontSize) : 0,
      };
    },
    countPixels: (base64, roi) => {
      const image = new Image();
      const done = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('png decode')); image.src = 'data:image/png;base64,' + base64; });
      return done.then(() => {
        const canvasEl = document.createElement('canvas');
        canvasEl.width = image.naturalWidth; canvasEl.height = image.naturalHeight;
        const context = canvasEl.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const scaleX = image.naturalWidth / roi.width, scaleY = image.naturalHeight / roi.height;
        const x0 = Math.max(0, Math.floor(roi.x * scaleX)), y0 = Math.max(0, Math.floor(roi.y * scaleY));
        const x1 = Math.min(canvasEl.width, Math.ceil((roi.x + roi.width) * scaleX)), y1 = Math.min(canvasEl.height, Math.ceil((roi.y + roi.height) * scaleY));
        const pixels = context.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
        let blue = 0, green = 0, background = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
          if (Math.abs(r - 0x89) < 28 && Math.abs(g - 0xdc) < 28 && Math.abs(b - 0xeb) < 28) blue += 1;
          else if (Math.abs(r - 0xa6) < 28 && Math.abs(g - 0xe3) < 28 && Math.abs(b - 0xa1) < 28) green += 1;
          else if (Math.abs(r - 0x15) < 12 && Math.abs(g - 0x21) < 12 && Math.abs(b - 0x2c) < 12) background += 1;
        }
        return { blue, green, background };
      });
    },
  };

  function Harness() {
    const simRef = React.useRef(null);
    if (!simRef.current) simRef.current = createSim();
    const garrison = useGarrison(simRef.current, DEMO_ROSTER, 'terminal', { pollMs: 300, fetchTimeoutMs: 700 });
    const flows = useExpiringMcpFlows(garrison.demo ? [] : garrison.flows, shortTtl);
    globalThis.gameVisual.flows = flows;
    flowLayer.sync(flows, actors, Date.now());
    globalThis.gameHarness = { loading: garrison.loading, error: garrison.error, demo: garrison.demo, rows: flows.length };
    return React.createElement(McpFlows, { flows, actors });
  }
  function Root() {
    const [uid, setUid] = React.useState('owner-1');
    globalThis.setGameUid = setUid;
    const auth = { mode: 'firebase', user: { uid, email: uid + '@x', displayName: uid, emailVerified: true, providerData: [] },
      initializing: false, signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {}, signInWithProvider: async () => {},
      resetPassword: async () => {}, resendVerification: async () => {}, signOutUser: async () => {}, deleteAccount: async () => {} };
    return React.createElement(AuthContext.Provider, { value: auth }, React.createElement(Harness));
  }
  createRoot(overlay).render(React.createElement(Root));
  return true;
`;

async function capture(label) {
  await waitFor(() => evaluate(`(() => { const panel = document.querySelector('.keep-mcp-flows'); return !!panel && panel.open && panel.querySelectorAll('.keep-mcp-flows-list li').length > 0; })()`), `${label}: panel open with rows`);
  const probe = await evaluate(`(() => { try { return gameVisual.probe(); } catch (error) { return { probeError: String((error && error.stack) || error) }; } })()`);
  if (probe.probeError) throw new Error(`${label}: probe failed: ${probe.probeError.slice(0, 500)}`);
  assert.equal(probe.open, true, `${label}: panel must be open`);
  assert.ok(probe.stage.width > 0 && probe.stage.height > 0, `${label}: stage laid out`);
  assert.ok(probe.canvas.width > 0 && probe.canvas.height > 0, `${label}: canvas laid out`);
  assert.ok(probe.canvas.top >= -1 && probe.canvas.left >= -1 && probe.canvas.right <= probe.innerWidth + 1, `${label}: canvas on screen`);
  assert.ok(probe.scrollWidth <= probe.innerWidth, `${label}: no horizontal overflow (${probe.scrollWidth} > ${probe.innerWidth})`);
  assert.ok(probe.summaryFont >= 16, `${label}: summary font ${probe.summaryFont}px`);
  for (const row of probe.rows) {
    assert.ok(row.visible && row.hit, `${label}: row not visibly readable: ${JSON.stringify(row)}`);
  }
  const unobstructed = probe.samples.filter((sample) => sample.unobstructed);
  assert.ok(unobstructed.length >= 2, `${label}: arrows visibly unobstructed at >=2 points: ${JSON.stringify(probe.samples)}`);
  const data = await transport.screenshot();
  const pixels = await evaluate(`gameVisual.countPixels(${JSON.stringify(data)}, ${JSON.stringify({ x: probe.stage.x, y: probe.stage.y, width: probe.stage.width, height: probe.stage.height })})`);
  assert.ok(pixels.blue + pixels.green >= 20, `${label}: arrow pixels visible in the screenshot: ${JSON.stringify(pixels)}`);
  assert.ok(pixels.background >= 5000, `${label}: canvas background visible (not covered): ${JSON.stringify(pixels)}`);
  const path = join(shots, `game-flows-${label}-${browser}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(`PASS ${label}: canvas visible, panel open and readable, arrows drawn (${JSON.stringify(pixels)}); shot ${path}`);
  return probe;
}

try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = browser === 'safari' ? await launchSafariTransport() : await launchChromeTransport({ profile });
  evaluate = (expression) => transport.evaluate(expression);

  const formats = browser === 'chrome'
    ? [{ label: 'desktop', viewport: { width: 1280, height: 900, dpr: 2, mobile: false }, compact: false },
       { label: 'compact', viewport: { width: 480, height: 900, dpr: 2, mobile: true }, compact: true }]
    : [{ label: 'desktop', viewport: { width: 1280, height: 900 }, compact: false },
       /* The Safari driver cannot emulate a smaller viewport: the compact pass shrinks the stage instead. */
       { label: 'compact-stage', viewport: { width: 1280, height: 900 }, compact: true }];

  for (const format of formats) {
    const viewport = await transport.setViewport(format.viewport);
    if (browser === 'safari') console.log(`safari viewport: ${viewport.width}x${viewport.height} @${viewport.dpr}x`);
    await transport.navigate(`http://127.0.0.1:${port}/scripts/fixtures/route-test.html?game=${format.label}-${Date.now()}`);
    await waitFor(() => evaluate(`document.readyState === 'complete'`), 'page load');
    await evaluate(`(async () => { try { ${SETUP(format.compact)} } catch (error) { globalThis.setupError = String((error && error.stack) || error); } })()`);
    const setupError = await evaluate(`globalThis.setupError ?? null`);
    if (setupError) throw new Error(`fixture setup: ${String(setupError).slice(0, 300)}`);
    await waitFor(() => evaluate(`!!globalThis.gameHarness && globalThis.gameHarness.demo === false && globalThis.gameHarness.rows === 2`), `${format.label}: harness live with rows`);
    assert.equal(await evaluate(`(() => { const opened = gameVisual.expand(); gameVisual.fitVisible(); return opened; })()`), true, `${format.label}: panel exists to expand`);
    await delay(150);
    await capture(format.label);
  }

  /* Nothing invented: a flow whose target is not on the field draws no arrow. */
  await evaluate(`(() => {
    const backend = gameBackend;
    backend.flows = [{ id: '${OTHER_ID}', targetSessionId: 'not-on-the-field', tool: 'shell_screen', phase: 'started', at: Date.now() }];
    return true;
  })()`);
  await waitFor(() => evaluate(`gameHarness.rows === 0`), 'rows drop when no target is live', 8000);
  const blankProbe = await evaluate(`gameVisual.probe()`);
  const blankShot = await transport.screenshot();
  const blankPixels = await evaluate(`gameVisual.countPixels(${JSON.stringify(blankShot)}, ${JSON.stringify({ x: blankProbe.stage.x, y: blankProbe.stage.y, width: blankProbe.stage.width, height: blankProbe.stage.height })})`);
  assert.ok(blankPixels.blue + blankPixels.green < 20, `arrows with no on-field target: ${JSON.stringify(blankPixels)}`);
  assert.ok(blankPixels.background >= 5000, `canvas must stay rendered: ${JSON.stringify(blankPixels)}`);
  console.log(`PASS no invented sender: no arrows without a target on the field (${JSON.stringify(blankPixels)})`);

  /* The account changes: the old account's flows must not survive it. */
  await evaluate(`(() => {
    gameBackend.flows = [{ id: '${OTHER_ID}', targetSessionId: 'live-1', tool: 'shell_screen', phase: 'started', at: Date.now() }];
    return true;
  })()`);
  await waitFor(() => evaluate(`gameHarness.rows === 1`), 'a flow for the current account', 8000);
  await evaluate(`setGameUid('owner-2')`);
  await delay(120);
  const afterFlip = await evaluate(`(() => ({ rows: gameHarness.rows, panel: !!document.querySelector('.keep-mcp-flows') }))()`);
  assert.equal(afterFlip.rows, 0, `rows after uid flip: ${JSON.stringify(afterFlip)}`);
  assert.equal(afterFlip.panel, false, 'panel must be gone the moment the account changes');
  console.log(`PASS ${browser}: no flows survive an account change`);

  /* A hung session fetch: the panel still empties, and nothing piles up. */
  await evaluate(`setGameUid('owner-1')`);
  await waitFor(() => evaluate(`gameHarness.rows === 1`), 'rows back for owner-1', 8000);
  const fetchesBefore = await evaluate(`gameBackend.sessionFetches`);
  await evaluate(`(() => { gameBackend.freezeFlows = true; gameBackend.hangSessions = true; return true; })()`);
  await delay(2600);
  const hung = await evaluate(`(() => ({ rows: gameHarness.rows, panel: !!document.querySelector('.keep-mcp-flows'), fetches: gameBackend.sessionFetches, error: gameHarness.error }))()`);
  assert.equal(hung.rows, 0, `rows while hung: ${JSON.stringify(hung)}`);
  assert.equal(hung.panel, false, 'panel must expire without a fetch');
  assert.ok(hung.fetches - fetchesBefore <= 2, `fetch pile-up: ${JSON.stringify(hung)}`);
  assert.ok(typeof hung.error === 'string' && hung.error.length > 0, `bounded fetch should report: ${JSON.stringify(hung)}`);
  console.log(`PASS ${browser}: expiry independent of fetch; hung fetch bounded (${hung.fetches - fetchesBefore} further fetches)`);
  console.log(`screenshots in ${shots}`);
} finally {
  await transport?.close();
  await server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
