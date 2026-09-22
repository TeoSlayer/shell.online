// Real UI/providers, synthetic account and relay only. No user sessions touched.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'shell-clarity-browser-'));
const shots = await mkdtemp(join(tmpdir(), 'shell-clarity-preview-'));
const entry = 'virtual:clarity-test';
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: entry, enforce: 'pre', resolveId(id, importer) {
    if (id === entry) return `\0${entry}.js`;
    if (id === './firebase' && importer?.endsWith('/src/lib/api.ts')) return join(root, 'scripts/fixtures/firebase-stub.ts');
  }, load(id) {
    if (id !== `\0${entry}.js`) return;
    return `
      import '/src/styles/tokens.css'; import '/src/styles/base.css'; import '/src/styles/auth.css';
      import '/src/styles/shell.css'; import '/src/styles/terminal.css'; import '/src/styles/people.css';
      import '/src/styles/collab.css'; import '/src/styles/vault.css'; import '/src/styles/feedback.css';
      export { default as React } from 'react'; export { createRoot } from 'react-dom/client';
      export { BrowserRouter } from 'react-router-dom'; export { AuthContext } from '/src/auth/AuthProvider.tsx';
      export { SignedInApp } from '/src/App.tsx';
    `;
  } }],
});
let browser;
async function until(expression) {
  for (let i = 0; i < 300; i++) { if (await browser.evaluate(expression)) return; await delay(50); }
  throw new Error(`Timed out: ${expression}`);
}
async function mount(path) {
  await browser.navigate(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/route-test.html`);
  await until('document.readyState === "complete"');
  await browser.call(async function (path, entry) {
    const { React, createRoot, BrowserRouter, AuthContext, SignedInApp } = await import(entry);
    const user = { uid: 'clarity-owner', email: 'qa@example.test', displayName: 'Demo owner', emailVerified: true };
    const you = { ...user, name: user.displayName, role: 'owner' };
    window.clarity = { copies: [], writes: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => clarity.copies.push(value) } });
    const session = { id: 'clarity-session', uid: you.uid, ownerUid: you.uid, orgId: 'qa',
      name: 'Review checkout', command: '/opt/bin/opencode --session really-long-conversation --model remote',
      shareUrl: 'https://shell.online/s/' + 'a'.repeat(32) + '#salt=AAAAAAAAAAAAAAAAAAAAAA',
      readOnly: false, encrypted: true, persistent: false, startedAt: Date.now() - 60000,
      relayStatus: 'connected', deviceId: 'qa-machine', host: 'Demo computer', dailyBriefingEnabled: false };
    const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (init.method && init.method !== 'GET') clarity.writes.push(url.pathname);
      if (url.pathname === '/api/vault') return json({ vault: null });
      if (url.pathname === '/api/team-key') return json({ teamKey: null, share: null, missing: [], you });
      if (url.pathname === '/api/sessions') return json({ sessions: [], members: [you], you });
      if (url.pathname === '/api/devices') return json({ devices: [] });
      if (url.pathname === '/api/sessions/clarity-session') return json({ session, members: [you], you, comments: [] });
      if (url.pathname === '/api/inbox') return json({ items: [], unread: 0 });
      return json({});
    };
    window.WebSocket = class extends EventTarget { readyState = 0; send() {} close() {} };
    const auth = { mode: 'firebase', user, initializing: false, signOutUser: async () => {} };
    history.replaceState(null, '', path);
    const node = document.createElement('div'); document.body.append(node);
    createRoot(node).render(React.createElement(AuthContext.Provider, { value: auth },
      React.createElement(BrowserRouter, null, React.createElement(SignedInApp))));
  }, path, `/@id/__x00__${entry}.js`);
}
try {
  await server.listen(); browser = await launchChromeTransport({ profile });
  for (const width of [320, 390, 768, 1440]) {
    await browser.setViewport({ width, height: 900, dpr: 1, mobile: width < 600 });
    await mount('/sessions'); await until('!!document.querySelector(".session-start-guide") && document.fonts.status === "loaded"');
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${width}: onboarding fits`);
    await browser.evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "Windows PowerShell").click()');
    assert.equal(await browser.evaluate('document.querySelector(".start-command code").textContent'), 'irm https://shell.online/install.ps1 | iex');
    await browser.evaluate('document.querySelector(".start-command button").click()');
    await until('clarity.copies.length === 1');
    assert.equal(await browser.evaluate('clarity.copies[0]'), 'irm https://shell.online/install.ps1 | iex');
    assert.equal(await browser.evaluate('document.querySelector(".start-command button").textContent'), 'Copied');
    assert.equal(await browser.evaluate('[...document.querySelectorAll(".start-command, .session-start-guide, .shell-content")].every(e => e.scrollWidth <= e.clientWidth + 1)'), true, `${width}: command text wraps inside its panel`);
    await writeFile(join(shots, `onboarding-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'));
    await mount('/sessions/clarity-session'); await until('!!document.querySelector(".detail-name") && document.fonts.status === "loaded"');
    assert.equal(await browser.evaluate('document.querySelector(".detail-name").textContent'), 'Review checkout');
    assert.equal(await browser.evaluate('document.querySelector(".detail-command-details").open'), false);
    await browser.evaluate('document.querySelector(".clip .session-copy").click()');
    await until('!!document.querySelector(".clip-help")');
    assert.equal(await browser.evaluate('document.querySelector(".clip-help a").getAttribute("href")'), '/account');
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${width}: sharing fits`);
    assert.equal(await browser.evaluate('clarity.writes.length'), 0, 'viewing does not change permissions');
    await writeFile(join(shots, `sharing-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'));
    console.log(`PASS ${width}: setup, Windows copy, detail, vault guidance, unchanged permissions`);
  }
  console.log(`Preview screenshots: ${shots}`);
} finally { await browser?.close(); await server.close(); await rm(profile, { recursive: true, force: true }); }
