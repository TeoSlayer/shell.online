// Full-route browser regression for the session detail page.
//
// The real Session route is mounted with the real providers and the real API
// layer; only the network is synthetic (a fetch stub backed by an in-page
// backend) and the Firebase module is replaced so the request layer can mint a
// token. What this proves, in a real browser:
//   - the tab title and the heading carry the short session title;
//   - the summary is the genuine description, or the truthful empty state;
//   - the full command is behind a closed disclosure;
//   - a change made elsewhere (as the CLI makes it) reaches the checkboxes
//     through the route's own poll, with no reload and no local copy;
//   - a checkbox change is sent as one partial PUT and reflected from the
//     server response.
//
// Chrome by default; SHELL_BROWSER=safari runs the same fixture through
// safaridriver. Synthetic data only; no login, relay or deploy.
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
const profile = browser === 'chrome' ? await mkdtemp(join(tmpdir(), 'shell-route-')) : null;
const shots = await mkdtemp(join(browser === 'safari' ? '/tmp' : tmpdir(), 'shell-route-shots-'));
const TEST_ENTRY_ID = 'virtual:session-route-test-entry';
const FIREBASE_STUB = join(here, 'fixtures', 'firebase-stub.ts');

const testEntryPlugin = {
  name: 'session-route-test-entry',
  enforce: 'pre',
  // Only api.ts asks for this module; the route tree never mounts AuthProvider.
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
      import { BrowserRouter, Routes, Route } from 'react-router-dom';
      import { Session } from '/src/routes/Session.tsx';
      import { AuthContext } from '/src/auth/AuthProvider.tsx';
      import { VaultProvider } from '/src/vault/VaultProvider.tsx';
      import { TeamKeyProvider } from '/src/vault/TeamKeyProvider.tsx';
      import { FeedbackProvider } from '/src/feedback/FeedbackProvider.tsx';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, BrowserRouter, Routes, Route, Session, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider };
    `;
  },
};

const server = await createServer({
  root: dirname(here) === '' ? here : join(here, '..'),
  plugins: [testEntryPlugin],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent',
});
let transport;
const evaluate = (expression) => transport.evaluate(expression);
const waitFor = async (check, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { if (await check()) return; lastError = null; }
    catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(lastError ? `Timed out: ${label} (${lastError.message})` : `Timed out: ${label}`);
};

const SETUP = `
  const { React, createRoot, BrowserRouter, Routes, Route, Session, AuthContext, VaultProvider, TeamKeyProvider, FeedbackProvider } =
    await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  const you = { uid: 'qa-owner', email: 'owner@test', name: 'Owner', role: 'owner' };
  globalThis.routeTest = {
    consent: { mcpTeamAccess: false, dailyBriefingEnabled: false, dailyBriefingTeamAccess: false },
    puts: [],
  };
  const session = () => ({
    id: 'route-test', uid: 'qa-owner', orgId: 'org-qa', ownerUid: 'qa-owner',
    shareUrl: location.origin + '/s/' + 'r'.repeat(32),
    command: '/opt/tools/very-long-agent-command --with --flags --that --go --on',
    readOnly: false, encrypted: true, persistent: false, host: 'laptop',
    startedAt: Date.now() - 60000, ...globalThis.routeTest.consent,
  });
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/vault') return json({ vault: null });
    if (url.pathname === '/api/team-key') return json({ teamKey: null, share: null, missing: [], you });
    if (url.pathname === '/api/sessions' && method === 'GET') return json({ sessions: [], members: [you], you });
    if (url.pathname === '/api/sessions/route-test' && method === 'GET') return json({ session: session(), members: [you], you, comments: [] });
    if (url.pathname === '/api/sessions/route-test/automation' && method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}'));
      globalThis.routeTest.puts.push(body);
      Object.assign(globalThis.routeTest.consent, body);
      return json({ session: session() });
    }
    return json({});
  };
  const auth = {
    mode: 'firebase',
    user: { uid: 'qa-owner', email: 'owner@test', displayName: 'Owner', emailVerified: true, providerData: [] },
    initializing: false,
    signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {}, signInWithProvider: async () => {},
    resetPassword: async () => {}, resendVerification: async () => {}, signOutUser: async () => {}, deleteAccount: async () => {},
  };
  history.replaceState(null, '', '/sessions/route-test');
  const root = document.createElement('div');
  root.id = 'route-test';
  document.body.append(root);
  window.scrollTo(0, 0);
  createRoot(root).render(React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(BrowserRouter, null,
      React.createElement(VaultProvider, null,
        React.createElement(TeamKeyProvider, null,
          React.createElement(FeedbackProvider, null,
            React.createElement(Routes, null,
              React.createElement(Route, { path: '/sessions/:sessionId', element: React.createElement(Session) }))))))));
  return true;
`;

try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = browser === 'safari' ? await launchSafariTransport() : await launchChromeTransport({ profile });
  if (browser === 'safari') {
    const viewport = await transport.setViewport({ width: 1280, height: 900 });
    console.log(`safari actual viewport: ${viewport.width}x${viewport.height} @${viewport.dpr}x`);
  } else {
    await transport.setViewport({ width: 1280, height: 900, dpr: 2, mobile: false });
  }
  await transport.navigate(`http://127.0.0.1:${port}/scripts/fixtures/route-test.html?route=${Date.now()}`);
  await waitFor(() => evaluate(`location.origin === 'http://127.0.0.1:${port}' && document.readyState === 'complete'`), 'page load');
  await evaluate(`(async () => { ${SETUP} })()`);
  await waitFor(() => evaluate(`!!document.querySelector('.detail-name')`), 'session detail rendered');
  await waitFor(() => evaluate(`document.querySelectorAll('.session-automation-switch input').length === 3`), 'three consent checkboxes');

  // 1) Short title in the heading and the tab title; command behind a closed disclosure.
  const heading = await evaluate(`document.querySelector('.detail-name').textContent`);
  assert.equal(heading, 'very-long-agent-command', `heading: ${heading}`);
  /*
   * The title effect runs after the commit, and the QA page's own app can set
   * a title first; give the route's title a moment to win.
   */
  await waitFor(() => evaluate(`document.title.includes('very-long-agent-command')`), 'tab title', 5000);
  const title = await evaluate(`document.title`);
  assert.match(title, /very-long-agent-command/, `tab title: ${title}`);
  const summary = await evaluate(`document.querySelector('.detail-summary').textContent`);
  assert.equal(summary, 'No description.', `summary: ${summary}`);
  const details = await evaluate(`(() => { const d = document.querySelector('details.detail-command-details'); return d ? { open: d.open, text: d.querySelector('code').textContent } : null; })()`);
  assert.ok(details && details.open === false, 'command disclosure must be closed by default');
  assert.match(details.text, /--with --flags --that --go --on/, 'full command must be reachable behind the disclosure');
  console.log(`PASS ${browser}: title/summary/command`);

  // 2) A change made elsewhere (the CLI's route) arrives through the poll.
  const before = await evaluate(`(() => [...document.querySelectorAll('.session-automation-switch input')].map((i) => i.checked))()`);
  assert.deepEqual(before, [false, false, false], `initial checkboxes: ${JSON.stringify(before)}`);
  await evaluate(`(() => { routeTest.consent.dailyBriefingEnabled = true; return true; })()`);
  await waitFor(() => evaluate(`(() => { const i = document.querySelectorAll('.session-automation-switch input'); return i.length === 3 && i[1].checked === true; })()`), 'CLI-side change reflected by the poll', 12000);
  const after = await evaluate(`(() => [...document.querySelectorAll('.session-automation-switch input')].map((i) => i.checked))()`);
  assert.deepEqual(after, [false, true, false], `checkboxes after poll: ${JSON.stringify(after)}`);
  console.log(`PASS ${browser}: CLI-to-web poll transition`);

  // 3) A checkbox change is one partial PUT, reflected from the response.
  await evaluate(`(() => { document.querySelectorAll('.session-automation-switch input')[0].click(); return true; })()`);
  await waitFor(() => evaluate(`routeTest.puts.length === 1`), 'automation PUT');
  const puts = await evaluate(`routeTest.puts`);
  assert.deepEqual(puts, [{ mcpTeamAccess: true }], `PUT bodies: ${JSON.stringify(puts)}`);
  await waitFor(() => evaluate(`document.querySelectorAll('.session-automation-switch input')[0].checked === true`), 'checkbox reflects the save');
  const merged = await evaluate(`(() => [...document.querySelectorAll('.session-automation-switch input')].map((i) => i.checked))()`);
  assert.deepEqual(merged, [true, true, false], `checkboxes after save: ${JSON.stringify(merged)}`);
  const data = await transport.screenshot();
  await writeFile(join(shots, `session-route-${browser}.png`), Buffer.from(data, 'base64'));
  console.log(`PASS ${browser}: partial PUT and response merge; screenshot ${join(shots, `session-route-${browser}.png`)}`);
} finally {
  await transport?.close();
  await server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
