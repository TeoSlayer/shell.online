// Full-route browser regression for asking a session's owner for its password.
//
// The real Workspace and Session routes are mounted with the real providers
// and the real API layer; only the network is synthetic (a fetch stub backed
// by state this script carries between page loads) and the Firebase module is
// replaced so the request layer can mint a token. What this proves, in a real
// browser:
//   - a teammate without the password sees a lock beside the session's name;
//   - the Decrypt terminal prompt offers to ask the owner, and says it asked;
//   - the owner sees the waiting count on the Share button's corner, and the
//     same count on a "Password requests" item in the Share menu;
//   - that item lands on the session page's password requests section;
//   - accepting seals the password in the browser and sends it with the
//     answer; declining sends only the answer;
//   - the declined teammate is told so and can ask again.
//
// Chrome only. Synthetic data only; no login, relay or deploy.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'shell-pwreq-'));
const shots = process.env.SHELL_SHOTS ?? await mkdtemp(join(tmpdir(), 'shell-pwreq-shots-'));
await mkdir(shots, { recursive: true });
const TEST_ENTRY_ID = 'virtual:password-requests-test-entry';
const FIREBASE_STUB = join(here, 'fixtures', 'firebase-stub.ts');
const SALT = 'A'.repeat(22);

const testEntryPlugin = {
  name: 'password-requests-test-entry',
  enforce: 'pre',
  resolveId(id, importer) {
    if (id === TEST_ENTRY_ID) return `\0${TEST_ENTRY_ID}.js`;
    if (id === './firebase' && importer && importer.endsWith('/src/lib/api.ts')) return FIREBASE_STUB;
    return null;
  },
  load(id) {
    if (id !== `\0${TEST_ENTRY_ID}.js`) return null;
    return `
      import '/src/styles/tokens.css';
      import '/src/styles/base.css';
      import '/src/styles/auth.css';
      import '/src/styles/shell.css';
      import '/src/styles/terminal.css';
      import '/src/styles/chat.css';
      import '/src/styles/people.css';
      import '/src/styles/collab.css';
      import '/src/styles/audit.css';
      import '/src/styles/terms.css';
      import '/src/styles/vault.css';
      import '/src/styles/feedback.css';
      import * as ReactModule from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
      import { Session } from '/src/routes/Session.tsx';
      import { Workspace } from '/src/routes/Workspace.tsx';
      import { AuthContext } from '/src/auth/AuthProvider.tsx';
      import { VaultProvider, useVault } from '/src/vault/VaultProvider.tsx';
      import { TeamKeyProvider } from '/src/vault/TeamKeyProvider.tsx';
      import { FeedbackProvider } from '/src/feedback/FeedbackProvider.tsx';
      import { rememberVerified } from '/src/lib/session-passwords.ts';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, BrowserRouter, Routes, Route, useNavigate, Session, Workspace, AuthContext, VaultProvider, useVault, TeamKeyProvider, FeedbackProvider, rememberVerified };
    `;
  },
};

/*
 * The service's state, kept here so it survives the page being reloaded as
 * a different person. Each page load gets a copy and hands back its changes.
 */
const backend = { requests: [], answers: [], keyShares: {} };

/*
 * A constant: everything that varies between page loads (who is signed in,
 * where they start, the service's state) arrives in the page's own URL, so no
 * value is ever spliced into code the page evaluates.
 */
const SETUP = `
  const params = new URLSearchParams(location.search);
  const persona = params.get('as');
  const startAt = params.get('path');
  const { React, createRoot, BrowserRouter, Routes, Route, useNavigate, Session, Workspace, AuthContext, VaultProvider, useVault, TeamKeyProvider, FeedbackProvider, rememberVerified } =
    await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const accountKey = async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return encode(await crypto.subtle.exportKey('raw', pair.publicKey));
  };
  const members = [
    { orgId: 'org-qa', uid: 'qa-owner', email: 'olivia@test', name: 'Olivia', role: 'owner', joinedAt: 1, accountKey: await accountKey() },
    { orgId: 'org-qa', uid: 'qa-ana', email: 'ana@test', name: 'Ana', role: 'member', joinedAt: 2, accountKey: await accountKey() },
    { orgId: 'org-qa', uid: 'qa-ben', email: 'ben@test', name: 'Ben', role: 'member', joinedAt: 3, accountKey: await accountKey() },
  ];
  const you = members.find((member) => member.uid === persona);
  globalThis.pw = JSON.parse(params.get('state'));
  const shareUrl = location.origin + '/s/' + 'p'.repeat(32) + '#salt=${SALT}';
  const session = () => {
    const mine = pw.requests.filter((request) => request.sessionId === 'pw-test');
    const own = you.uid === 'qa-owner';
    const request = mine.find((entry) => entry.requesterUid === you.uid);
    return {
      id: 'pw-test', uid: 'qa-owner', orgId: 'org-qa', ownerUid: 'qa-owner', assigneeUids: ['qa-owner'],
      shareUrl, command: 'claude', name: 'Refactor billing',
      readOnly: false, encrypted: true, persistent: false, host: 'olivias-laptop',
      startedAt: Date.now() - 600000, relayStatus: 'connected', hostLastSeenAt: Date.now(),
      keyShare: pw.keyShares[you.uid],
      ...(own
        ? { passwordRequestsPending: mine.filter((entry) => entry.status === 'pending').length }
        : request ? { passwordRequest: { requesterUid: request.requesterUid, status: request.status, requestedAt: request.requestedAt, resolvedAt: request.resolvedAt } } : {}),
    };
  };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/vault') return json({ vault: null });
    if (url.pathname === '/api/team-key') return json({ teamKey: null, share: null, missing: [], you });
    if (url.pathname === '/api/devices') return json({ devices: [] });
    if (url.pathname === '/api/sessions' && method === 'GET') return json({ sessions: [session()], members, you });
    if (url.pathname === '/api/sessions/pw-test' && method === 'GET') {
      return json({ session: session(), members, you, comments: [],
        passwordRequests: you.uid === 'qa-owner' ? pw.requests : undefined });
    }
    if (url.pathname === '/api/sessions/pw-test/password-requests' && method === 'POST') {
      const existing = pw.requests.find((entry) => entry.requesterUid === you.uid);
      const request = existing?.status === 'pending' ? existing
        : { orgId: 'org-qa', sessionId: 'pw-test', requesterUid: you.uid, status: 'pending', requestedAt: Date.now() };
      pw.requests = [request, ...pw.requests.filter((entry) => entry !== existing)];
      return json({ request });
    }
    const answer = url.pathname.match(/^\\/api\\/sessions\\/pw-test\\/password-requests\\/(.+)$/);
    if (answer && method === 'PUT') {
      const uid = decodeURIComponent(answer[1]);
      const body = JSON.parse(String(init.body));
      pw.answers.push({ uid, ...body });
      const request = pw.requests.find((entry) => entry.requesterUid === uid && entry.status === 'pending');
      if (!request) return json({ error: 'that request has already been answered' }, 409);
      request.status = body.decision === 'approve' ? 'approved' : 'declined';
      request.resolvedAt = Date.now();
      request.resolvedBy = you.uid;
      if (body.share) pw.keyShares[uid] = { senderPublicKey: body.share.sender_public_key, sealed: body.share.sealed };
      return json({ request });
    }
    return json({});
  };
  /* No relay connection is permitted in this all-synthetic fixture. */
  globalThis.WebSocket = class extends EventTarget {
    readyState = 0;
    send() {}
    close() { this.readyState = 3; }
  };
  /* The owner's browser proved the password when it started the session. */
  if (you.uid === 'qa-owner') rememberVerified('pw-test', 'correct horse battery staple', shareUrl);
  pw.click = (selector, text) => {
    const found = [...document.querySelectorAll(selector)]
      .find((element) => !text || element.textContent.includes(text));
    if (!found) return false;
    found.click();
    return true;
  };
  function Probe() {
    pw.vault = useVault();
    pw.navigate = useNavigate();
    return null;
  }
  const auth = {
    mode: 'firebase',
    user: { uid: you.uid, email: you.email, displayName: you.name, emailVerified: true, providerData: [] },
    initializing: false,
    signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {}, signInWithProvider: async () => {},
    resetPassword: async () => {}, resendVerification: async () => {}, signOutUser: async () => {}, deleteAccount: async () => {},
  };
  history.replaceState(null, '', startAt);
  const root = document.createElement('div');
  document.body.append(root);
  createRoot(root).render(React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(BrowserRouter, null,
      React.createElement(VaultProvider, null,
        React.createElement(TeamKeyProvider, null,
          React.createElement(FeedbackProvider, null,
            React.createElement(Routes, null,
              React.createElement(Route, { path: '/sessions/:sessionId', element: React.createElement(Session) }),
              React.createElement(Route, { path: '/sessions', element: React.createElement(Workspace) })),
            React.createElement(Probe)))))));
  return true;
`;

const server = await createServer({
  root: join(here, '..'),
  plugins: [testEntryPlugin],
  server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'silent',
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
const shot = async (name) => {
  await delay(250);
  const data = await transport.screenshot();
  await writeFile(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
};

let port;
/* A fresh page as somebody, carrying the service's state over. */
async function as(persona, path) {
  const page = new URL(`http://127.0.0.1:${port}/scripts/fixtures/route-test.html`);
  page.search = new URLSearchParams({ as: persona, path, state: JSON.stringify(backend), at: String(Date.now()) }).toString();
  await transport.navigate(page.href);
  await waitFor(() => evaluate(`document.readyState === 'complete'`), 'page load');
  await evaluate(`(async () => { ${SETUP} })()`);
}
async function keep() {
  Object.assign(backend, await evaluate(`({ requests: pw.requests, answers: pw.answers, keyShares: pw.keyShares })`));
}

try {
  await server.listen();
  port = server.httpServer.address().port;
  transport = await launchChromeTransport({ profile });
  await transport.setViewport({ width: 1280, height: 860, dpr: 2, mobile: false });

  // 1) Ana has no password: the list shows a lock, and the prompt offers to ask.
  await as('qa-ana', '/sessions');
  await waitFor(() => evaluate(`!!document.querySelector('.table-subject')`), 'session list');
  await waitFor(() => evaluate(`!!document.querySelector('.table-subject + .session-lock, .table-subject .session-lock')`), 'lock beside the name');
  await shot('1-teammate-list-lock');
  await evaluate(`(() => { pw.navigate('/sessions?open=pw-test'); return true; })()`);
  await waitFor(() => evaluate(`!!document.querySelector('.pane-gate-ask .btn')`), 'ask button on the Decrypt form');
  assert.match(await evaluate(`document.querySelector('.pane-gate-ask .btn').textContent`), /Ask Olivia for the password/);
  for (const width of [320, 390]) {
    await transport.setViewport({ width, height: 650, dpr: 2, mobile: true });
    await delay(150);
    await evaluate(`document.querySelector('.pane-gate-ask .btn').scrollIntoView({block:'center'})`);
    await delay(100);
    const bounds = await evaluate(`(() => {
      const gate = document.querySelector('.pane-gate').getBoundingClientRect();
      const ask = document.querySelector('.pane-gate-ask .btn').getBoundingClientRect();
      return { reachable: ask.top >= gate.top - 1 && ask.bottom <= gate.bottom + 1,
        fits: ask.left >= -1 && ask.right <= innerWidth + 1, height: ask.height,
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    })()`);
    assert(bounds.reachable && bounds.fits && !bounds.overflow, `Phone password request is scroll-reachable at ${width}px: ${JSON.stringify(bounds)}`);
    assert(bounds.height >= 44, 'Password request remains a usable touch target');
  }
  await transport.setViewport({ width: 1280, height: 860, dpr: 2, mobile: false });
  await delay(150);
  console.log('PASS: password request is reachable on 320px and 390px phones');
  await shot('2-decrypt-form-ask');
  assert.equal(await evaluate(`pw.click('.pane-gate-ask .btn')`), true);
  await waitFor(() => evaluate(`document.querySelector('.pane-gate-ask')?.textContent.includes('Asked Olivia')`), 'asked state');
  await shot('3-decrypt-form-asked');
  await keep();
  console.log('PASS: teammate sees the lock, asks from the Decrypt form, and is told it asked');

  // Ben asks too, so the owner has two to answer.
  await as('qa-ben', '/sessions?open=pw-test');
  await waitFor(() => evaluate(`!!document.querySelector('.pane-gate-ask .btn')`), 'ben ask button');
  await evaluate(`pw.click('.pane-gate-ask .btn')`);
  await waitFor(() => evaluate(`document.querySelector('.pane-gate-ask')?.textContent.includes('Asked Olivia')`), 'ben asked');
  await keep();
  assert.equal(backend.requests.filter((request) => request.status === 'pending').length, 2);

  // 2) Olivia sees the count on Share, and in the Share menu.
  await as('qa-owner', '/sessions');
  await waitFor(() => evaluate(`document.querySelector('.clip-badge')?.textContent === '2'`), 'badge shows 2');
  assert.equal(await evaluate(`!!document.querySelector('.table-subject + .session-lock, .table-subject .session-lock')`), false,
    'the owner holds the password, so no lock');
  const badge = await evaluate(`(() => {
    const button = document.querySelector('.clip .session-copy').getBoundingClientRect();
    const dot = document.querySelector('.clip-badge').getBoundingClientRect();
    return { right: dot.right - button.right, top: dot.top - button.top };
  })()`);
  assert.ok(badge.right > 0 && badge.top < 0, `badge sits on the top right corner ${JSON.stringify(badge)}`);
  await shot('4-owner-share-badge');
  await evaluate(`pw.click('.clip .session-copy')`);
  await waitFor(() => evaluate(`!!document.querySelector('.clip-pop')`), 'share menu');
  const item = await evaluate(`[...document.querySelectorAll('.clip-item')].find((element) => element.textContent.includes('Password requests'))?.querySelector('.clip-count')?.textContent`);
  assert.equal(item, '2', 'menu item carries the same count');
  await shot('5-owner-share-menu');

  // 3) The item lands on the session page's section.
  await evaluate(`pw.click('.clip-item', 'Password requests')`);
  await waitFor(() => evaluate(`location.pathname === '/sessions/pw-test' && location.hash === '#password-requests'`), 'navigated to section');
  await waitFor(() => evaluate(`document.querySelectorAll('.password-requests-list li').length === 2`), 'two pending rows');
  await waitFor(() => evaluate(`(() => { const r = document.getElementById('password-requests').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; })()`), 'section scrolled into view');
  await waitFor(() => evaluate(`![...document.querySelectorAll('.password-requests-list .btn')].some((button) => button.disabled && button.textContent.includes('Accept'))`), 'accept enabled once the password is read');
  await shot('6-owner-requests-section');

  // 4) Accept Ana, decline Ben.
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.password-requests-list li')].find((li) => li.textContent.includes('Ana'));
    [...row.querySelectorAll('.btn')].find((button) => button.textContent.includes('Accept')).click();
    return true;
  })()`);
  await waitFor(() => evaluate(`pw.answers.length === 1`), 'accept sent');
  await waitFor(() => evaluate(`document.querySelectorAll('.password-requests-list li').length === 1`), 'one left');
  await evaluate(`(() => {
    const row = document.querySelector('.password-requests-list li');
    [...row.querySelectorAll('.btn')].find((button) => button.textContent.includes('Decline')).click();
    return true;
  })()`);
  await waitFor(() => evaluate(`pw.answers.length === 2`), 'decline sent');
  await waitFor(() => evaluate(`document.querySelectorAll('.password-requests-done li').length === 2`), 'both answered');
  await shot('7-owner-requests-answered');
  await keep();
  const [accepted, declined] = backend.answers;
  assert.equal(accepted.uid, 'qa-ana');
  assert.equal(accepted.decision, 'approve');
  assert.match(accepted.share.sealed, /^v2\./, 'sealed to the asker\'s vault');
  assert.ok(!JSON.stringify(accepted).includes('correct horse'), 'the password never leaves in the clear');
  assert.deepEqual(declined, { uid: 'qa-ben', decision: 'decline' });
  console.log('PASS: owner badge, menu count, section jump, accept seals, decline sends only the answer');

  // 5) Ben is told, and can ask again.
  await as('qa-ben', '/sessions?open=pw-test');
  await waitFor(() => evaluate(`document.querySelector('.pane-gate-ask')?.textContent.includes('declined')`), 'declined state');
  assert.match(await evaluate(`document.querySelector('.pane-gate-ask .btn').textContent`), /Ask again/);
  await shot('8-teammate-declined');
  console.log(`PASS: declined teammate can ask again; screenshots in ${shots}`);
} finally {
  await transport?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
