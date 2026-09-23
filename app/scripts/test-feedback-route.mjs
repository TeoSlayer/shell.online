// Real route/provider/sheet/API client in an isolated browser. Only identity
// and HTTP responses are synthetic; no feedback is sent to a live service.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = 'virtual:feedback-route-test';
const profile = await mkdtemp(join(tmpdir(), 'shell-feedback-test-'));
let browser;
const server = await createServer({
  root,
  plugins: [{
    name: 'feedback-route-test', enforce: 'pre',
    resolveId(id, importer) {
      if (id === entry) return `\0${entry}.js`;
      if (id === './firebase' && importer?.endsWith('/src/lib/api.ts')) {
        return join(root, 'scripts/fixtures/firebase-stub.ts');
      }
    },
    load(id) {
      if (id !== `\0${entry}.js`) return;
      return `
        import '/src/styles/tokens.css';
        import '/src/styles/base.css';
        import '/src/styles/auth.css';
        import '/src/styles/shell.css';
        import '/src/styles/collab.css';
        import '/src/styles/terminal.css';
        import '/src/styles/feedback.css';
        import * as ReactModule from 'react';
        export const React = ReactModule.default ?? ReactModule;
        export { createRoot } from 'react-dom/client';
        export { BrowserRouter } from 'react-router-dom';
        export { SignedInApp } from '/src/App.tsx';
        export { AuthContext } from '/src/auth/AuthProvider.tsx';
      `;
    },
  }],
  server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error',
});
const check = async (expression, label) => {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await browser.evaluate(expression)) return;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
};

async function mount(signedIn, path, returnFrom) {
  await browser.navigate(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/route-test.html`);
  await check('document.readyState === "complete"', 'fixture page');
  const result = await browser.call(async function (entry, signedIn, path, returnFrom) {
    try {
    const { React, createRoot, BrowserRouter, SignedInApp, AuthContext } = await import(entry);
    const user = { uid: 'feedback-qa', email: 'reporter@example.test', displayName: 'Reporter', emailVerified: true };
    const you = { ...user, name: 'Reporter', role: 'owner' };
    window.feedbackTest = { posts: [], fail: false };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (url.pathname === '/api/feedback') {
        feedbackTest.posts.push({ method: init.method, payload: JSON.parse(init.body),
          authorization: new Headers(init.headers).get('Authorization'), credentials: init.credentials });
        return feedbackTest.fail ? json({ error: 'Synthetic failure. Try again.' }, 503)
          : json({ feedback: { id: 'synthetic-feedback', at: Date.now() } }, 201);
      }
      if (url.pathname === '/api/vault') return json({ vault: null });
      if (url.pathname === '/api/team-key') return json({ teamKey: null, share: null, missing: [], you });
      if (url.pathname === '/api/sessions') return json({ sessions: [], members: [you], you });
      if (url.pathname === '/api/inbox') return json({ items: [], unread: 0 });
      return json({});
    };
    // Never connect to a relay, even if an unrelated component is mounted.
    window.WebSocket = class extends EventTarget { readyState = 0; send() {} close() {} };
    function TestAuth() {
      const [identity, setIdentity] = React.useState(signedIn ? user : null);
      const signIn = async () => {
        setIdentity(user);
        // Auth listeners may publish before the sign-in promise returns.
        await new Promise(resolve => setTimeout(resolve, 100));
      };
      feedbackTest.signIn = signIn;
      const value = { mode: 'firebase', user: identity, initializing: false,
        signIn, signInWithGoogle: signIn, signInWithProvider: signIn,
        signUp: signIn, resetPassword: async () => {}, resendVerification: async () => {},
        signOutUser: async () => setIdentity(null), deleteAccount: async () => {} };
      return React.createElement(AuthContext.Provider, { value },
        React.createElement(BrowserRouter, null, React.createElement(SignedInApp)));
    }
    history.replaceState(returnFrom ? { usr: { from: returnFrom } } : null, '', path);
    const node = document.createElement('div');
    document.body.append(node);
    createRoot(node).render(React.createElement(TestAuth));
    return true;
    } catch (error) { return String(error); }
  }, `/@id/__x00__${entry}.js`, signedIn, path, returnFrom);
  assert.equal(result, true, 'synthetic fixture mounts');
}

try {
  await server.listen();
  browser = await launchChromeTransport({ profile });
  for (const width of [390, 1280]) {
    await browser.setViewport({ width, height: 900, dpr: 1, mobile: width < 600 });
    await mount(true, '/feedback?from=terminal&session=PRIVATE_SESSION#PRIVATE_KEY');
    await check('!!document.querySelector("#feedback-text")', 'authenticated feedback form');
    assert.equal(await browser.evaluate('feedbackTest.posts.length'), 0, 'opening never submits');
    assert.equal(await browser.evaluate('document.querySelector("[role=radio][aria-checked=true]").textContent'), 'Something broke');
    assert.equal(await browser.evaluate('document.querySelector(".feedback-attached").textContent.includes("a shared terminal")'), true);
    assert.equal(await browser.evaluate(`(() => {
      const r = document.querySelector('.feedback-sheet').getBoundingClientRect();
      return r.width > 250 && r.left >= 0 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
    })()`), true, 'form fits viewport');

    await browser.call(() => {
      feedbackTest.fail = true;
      const box = document.querySelector('#feedback-text');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Report control did not respond.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.feedback-contact input').click();
    });
    await browser.evaluate('document.querySelector(".feedback-form").requestSubmit()');
    await check('document.body.textContent.includes("Synthetic failure")', 'failure shown');
    assert.equal(await browser.evaluate('document.querySelector("#feedback-text").value'), 'Report control did not respond.');
    await browser.evaluate('feedbackTest.fail = false; document.querySelector(".feedback-form").requestSubmit()');
    await check('document.body.textContent.includes("Sent. Thank you.")', 'retry success');
    const posts = await browser.evaluate('feedbackTest.posts');
    assert.equal(posts.length, 2);
    for (const post of posts) {
      assert.equal(post.method, 'POST');
      assert.equal(post.authorization, 'Bearer route-test-token');
      assert.deepEqual(post.payload, {
        kind: 'problem', body: 'Report control did not respond.', surface: 'shared-terminal',
        route: '/feedback', app_version: post.payload.app_version, can_reply: false, context: {},
      });
      assert.ok(!JSON.stringify(post).includes('PRIVATE_'), 'no URL/session/key attached');
    }
    await browser.evaluate('document.querySelector(".feedback-sent button").click()');
    await check('!document.querySelector(".feedback-sheet")', 'close success');
    await browser.evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "Open feedback form").click()');
    await check('!!document.querySelector("#feedback-text")', 'reopen');
    assert.equal(await browser.evaluate('document.querySelector("#feedback-text").value'), '');
    await browser.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}))');
    await check('!document.querySelector(".feedback-sheet")', 'escape closes');
    console.log(`PASS feedback route ${width}px: shared form, authenticated API, privacy, retry, close/reopen`);
  }

  for (const signedIn of [false, true]) {
    for (const width of [320, 390, 1280]) {
      await browser.setViewport({ width, height: 650, dpr: 1, mobile: width < 600 });
      await mount(signedIn, '/feedback?from=terminal&session=PRIVATE_SESSION#PRIVATE_KEY');
      await check('!!document.querySelector("#feedback-text")', 'anonymous feedback available');
      assert.equal(await browser.evaluate('location.pathname'), '/feedback');
      assert.equal(await browser.evaluate('feedbackTest.posts.length'), 0);
      await browser.call((signedIn) => {
        if (signedIn) document.querySelector('.feedback-anonymous input').click();
        const box = document.querySelector('#feedback-text');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Anonymous mobile report.');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }, signedIn);
      assert.equal(await browser.call(async () => {
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
        const send = document.querySelector('.feedback-form button[type=submit]');
        send.scrollIntoView({ block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 100));
        const r = send.getBoundingClientRect();
        const visible = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth &&
          send.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        if (visible) send.click();
        return visible;
      }), true, 'anonymous Send button is scroll-reachable and unobstructed');
      await check('document.body.textContent.includes("Sent. Thank you.")', 'anonymous send');
      const posts = await browser.evaluate('feedbackTest.posts');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].authorization, null);
      assert.equal(posts[0].credentials, 'omit');
      assert.equal(posts[0].payload.can_reply, false);
      assert.deepEqual(posts[0].payload.context, {});
      assert.ok(!JSON.stringify(posts).includes('PRIVATE_'));
      console.log(`PASS anonymous feedback ${width}px, signedIn=${signedIn}: no credentials or identity attached`);
    }
  }

  await mount(false, '/login', '/feedback?from=terminal');
  await check('!!document.querySelector("form")', 'login form');
  // Simulates a provider restoring an identity before the login handler returns.
  await browser.evaluate('feedbackTest.signIn()');
  await check('location.pathname === "/feedback" && !!document.querySelector("#feedback-text")', 'sign-in return to feedback');
  assert.equal(await browser.evaluate('feedbackTest.posts.length'), 0);
  console.log('PASS optional sign-in return (no automatic report)');

  await mount(false, '/login', '/feedback?from=terminal');
  await check('location.pathname === "/login" && !!document.querySelector("input[type=password]")', 'email sign-in form');
  await browser.call(() => {
    for (const [selector, value] of [['input[type=email]', 'reporter@example.test'], ['input[type=password]', 'synthetic-password']]) {
      const input = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await browser.evaluate('document.querySelector("form").requestSubmit()');
  await check('location.pathname === "/feedback" && !!document.querySelector("#feedback-text")', 'email sign-in return');
  assert.equal(await browser.evaluate('feedbackTest.posts.length'), 0);
  console.log('PASS actual sign-in form with early auth-listener update');

  for (const returnFrom of [undefined, 'https://example.invalid/feedback', '//example.invalid/feedback']) {
    await mount(true, '/login', returnFrom);
    await check('location.pathname === "/sessions"', 'safe default return');
  }
  console.log('PASS login default and external return paths stay inside the app');

  await mount(true, '/feedback?from=PRIVATE_SOURCE&body=PRIVATE_BODY');
  await check('!!document.querySelector("#feedback-text")', 'generic form');
  assert.equal(await browser.evaluate('document.querySelector("#feedback-text").value'), '');
  assert.equal(await browser.evaluate('document.querySelector(".feedback-attached").textContent.includes("the feedback page")'), true);
  console.log('PASS unknown source/query cannot populate feedback');
} finally {
  await browser?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
