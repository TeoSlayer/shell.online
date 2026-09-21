// Synthetic browser fixture for the optional external-analysis panel.
//
// Mounts the real AssessPanel over the game's own stylesheet and checks the
// transitions a person actually sees: unavailable with no server key, consent
// off with its explicit copy, consented labels with source age and the
// inferred-not-verified wording, consent withdrawal clearing everything, and
// the request a click sends (metadata only, never an excerpt). Screenshots are
// written outside the repository; no login, provider, session content, key or
// deploy is involved.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shots = await mkdtemp(join(tmpdir(), 'shell-assess-shots-'));
const profile = await mkdtemp(join(tmpdir(), 'shell-assess-profile-'));
const TEST_ENTRY_ID = 'virtual:game-assess-test-entry';

const testEntryPlugin = {
  name: 'game-assess-test-entry',
  enforce: 'pre',
  resolveId(id) {
    if (id === TEST_ENTRY_ID) return `\0${TEST_ENTRY_ID}.js`;
    return null;
  },
  load(id) {
    if (id !== `\0${TEST_ENTRY_ID}.js`) return null;
    return `
      import * as ReactModule from 'react';
      import { createRoot } from 'react-dom/client';
      import { AssessPanel } from '/src/game/ui/AssessPanel.tsx';
      import { assessmentsForAccount, readAssessments } from '/src/game/state/assessments.ts';
      import '/src/styles/game.css';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, AssessPanel, assessmentsForAccount, readAssessments };
    `;
  },
};

const server = await createServer({
  root: join(here, '..'),
  plugins: [testEntryPlugin],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'silent',
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

const SETUP = `
  const { React, createRoot, AssessPanel, assessmentsForAccount, readAssessments } = await import('/@id/__x00__${TEST_ENTRY_ID}.js');
  const e = React.createElement;
  globalThis.assessFixtures = {
    unavailable: { configured: false, consent: false, consentUpdatedAt: 0, assessments: [] },
    off: { configured: true, consent: false, consentUpdatedAt: 0, assessments: [] },
    on: () => ({
      configured: true, consent: true, consentUpdatedAt: 5,
      assessments: [{
        sessionId: 'sess001', observedAt: Date.now() - 45_000, expiresAt: Date.now() + 60_000,
        labels: ['needs_attention', 'possible_loop'], modelVersion: 'jev-1.13.0', confidenceFloor: 0.7,
      }],
    }),
  };
  globalThis.assessBackend = { calls: [] };
  globalThis.fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    globalThis.assessBackend.calls.push({ path, method: (init && init.method) || 'GET', body: (init && init.body) || null });
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const stage = document.createElement('div');
  stage.style.cssText = 'position: fixed; inset: 0; background: #15212c;';
  const keep = document.createElement('div');
  keep.className = 'keep';
  keep.style.cssText = 'position: absolute; inset: 0;';
  stage.append(keep);
  document.body.append(stage);
  const root = createRoot(keep);
  globalThis.assessParsed = (payload) => readAssessments(payload, new Set(['sess001']), Date.now());
  globalThis.assessAccountGuard = (feed, stateUid, currentUid) => assessmentsForAccount(feed, stateUid, currentUid);
  globalThis.assessRender = (feed) => {
    const targets = [{ sessionId: 'sess001', flows: 3 }];
    const onConsent = (enabled) => { globalThis.fetch('/api/game/assessments/consent', { method: 'PUT', body: JSON.stringify({ enabled }) }); };
    const onAssess = (sessionId, observed) => { globalThis.fetch('/api/game/sessions/' + sessionId + '/assess', { method: 'POST', body: JSON.stringify({ observed }) }); };
    root.render(e(AssessPanel, { feed, targets, busy: false, error: '', now: Date.now(), onConsent, onAssess }));
    return true;
  };
  globalThis.assessDom = () => {
    const panel = document.querySelector('.keep-assess');
    const button = document.querySelector('.keep-assess-target button');
    const consent = document.querySelector('.keep-assess-consent input');
    return {
      text: panel ? panel.textContent : '',
      chips: [...document.querySelectorAll('.keep-assess-chip')].map((node) => node.textContent),
      age: document.querySelector('.keep-assess-age') ? document.querySelector('.keep-assess-age').textContent : '',
      inferred: document.querySelector('.keep-assess-inferred') ? document.querySelector('.keep-assess-inferred').textContent : '',
      unavailable: document.querySelector('.keep-assess-unavailable') ? document.querySelector('.keep-assess-unavailable').textContent : '',
      buttonDisabled: button ? button.disabled : null,
      consentChecked: consent ? consent.checked : null,
      hasExcerptField: !!document.querySelector('.keep-assess textarea, .keep-assess input[type="text"]'),
    };
  };
  globalThis.assessAct = (what) => {
    if (what === 'assess') document.querySelector('.keep-assess-target button').click();
    if (what === 'revoke') document.querySelector('.keep-assess-consent input').click();
    return true;
  };
`;

async function shot(label) {
  const data = await transport.screenshot();
  const path = join(shots, `assess-${label}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  assert.ok(data.length > 2_000, `${label}: screenshot has pixels`);
  return path;
}

try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = await launchChromeTransport({ profile });
  evaluate = (expression) => transport.evaluate(expression);
  await transport.setViewport({ width: 1280, height: 900, dpr: 2, mobile: false });
  await transport.navigate(`http://127.0.0.1:${port}/scripts/fixtures/route-test.html?assess=${Date.now()}`);
  await waitFor(() => evaluate(`document.readyState === 'complete'`), 'page load');
  await evaluate(`(async () => { try { ${SETUP} } catch (error) { globalThis.setupError = String((error && error.stack) || error); } })()`);
  const setupError = await evaluate(`globalThis.setupError ?? null`);
  if (setupError) throw new Error(`fixture setup: ${String(setupError).slice(0, 300)}`);

  /* 1. No server key: the panel says so and cannot ask for anything. */
  await evaluate(`assessRender(assessFixtures.unavailable)`);
  await waitFor(() => evaluate(`!!document.querySelector('.keep-assess')`), 'panel mounted');
  let dom = await evaluate(`assessDom()`);
  assert.ok(dom.unavailable.includes('no server-side analysis key'), `unavailable copy: ${JSON.stringify(dom.unavailable)}`);
  assert.equal(dom.buttonDisabled, true, 'assess must be disabled while unavailable');
  assert.equal(dom.chips.length, 0, 'no labels while unavailable');
  const shot1 = await shot('1-unavailable');
  console.log(`PASS unavailable: explicit copy, disabled action; shot ${shot1}`);

  /* 2. Consented: labels with source age, unverified wording, metadata-only request. */
  await evaluate(`assessRender(assessFixtures.on())`);
  await waitFor(() => evaluate(`assessDom().chips.length === 2`), 'labels rendered');
  dom = await evaluate(`assessDom()`);
  assert.deepEqual(dom.chips, ['needs attention', 'possible loop']);
  assert.equal(dom.age, 'assessed 45s ago');
  assert.equal(dom.inferred, 'inferred · not verified');
  assert.ok(dom.text.includes('Metadata only'));
  assert.ok(!dom.text.toLowerCase().includes('completed'), 'no completion wording');
  assert.equal(dom.buttonDisabled, false);
  assert.equal(dom.hasExcerptField, false, 'metadata-only panel has no pane-text field');
  await evaluate(`assessAct('assess')`);
  await waitFor(() => evaluate(`assessBackend.calls.some((call) => call.method === 'POST')`), 'assess request');
  const assessCall = await evaluate(`assessBackend.calls.find((call) => call.method === 'POST')`);
  assert.equal(assessCall.path, '/api/game/sessions/sess001/assess');
  const assessBody = JSON.parse(assessCall.body);
  assert.deepEqual(assessBody, { observed: { flows: 3 } });
  assert.ok(!('excerpt' in assessBody), 'no excerpt leaves the panel');
  const shot2 = await shot('2-consented');
  console.log(`PASS consented: labels, source age, inferred wording, metadata-only body; shot ${shot2}`);

  /* 3. Withdrawal: the click revokes, and an off feed shows no labels at all. */
  await evaluate(`assessAct('revoke')`);
  await waitFor(() => evaluate(`assessBackend.calls.some((call) => call.method === 'PUT')`), 'consent request');
  const consentCall = await evaluate(`assessBackend.calls.find((call) => call.method === 'PUT')`);
  assert.equal(JSON.parse(consentCall.body).enabled, false);
  await evaluate(`assessRender(assessFixtures.off)`);
  await waitFor(() => evaluate(`assessDom().unavailable.includes('external analysis is off')`), 'off copy');
  dom = await evaluate(`assessDom()`);
  assert.equal(dom.chips.length, 0, 'no labels once consent is off');
  assert.equal(dom.inferred, '', 'no inferred line without a row');
  const shot3 = await shot('3-revoked');
  console.log(`PASS revoked: withdrawal request sent, feed emptied; shot ${shot3}`);

  /* 4. A payload that claims consent is off must render no rows at all, and a
     feed that belongs to another account must render nothing while the new
     account's first read is in flight. */
  const parsedOff = await evaluate(`assessParsed({
    configured: true,
    consent: { externalAnalysis: false, updatedAt: 9 },
    assessments: [{ sessionId: 'sess001', observedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      model: { kind: 'advisory', labels: ['needs_attention'], modelVersion: 'jev-1.13.0', verified: false, confidenceFloor: 0.7 },
      observed: {}, disclaimer: '' }],
  })`);
  assert.equal(parsedOff.consent, false);
  assert.equal(parsedOff.assessments.length, 0, 'consent-off payload must drop every row');
  await evaluate(`assessRender(assessParsed({
    configured: true,
    consent: { externalAnalysis: false, updatedAt: 9 },
    assessments: [{ sessionId: 'sess001', observedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      model: { kind: 'advisory', labels: ['needs_attention'], modelVersion: 'jev-1.13.0', verified: false, confidenceFloor: 0.7 },
      observed: {}, disclaimer: '' }],
  }))`);
  await waitFor(() => evaluate(`assessDom().unavailable.includes('external analysis is off')`), 'off after a lying payload');
  dom = await evaluate(`assessDom()`);
  assert.equal(dom.chips.length, 0, 'no chips from a consent-off payload');
  const guard = await evaluate(`assessAccountGuard(assessFixtures.on(), 'owner-1', 'owner-2')`);
  assert.equal(guard.configured, false, 'another account gets the off feed synchronously');
  assert.equal(guard.assessments.length, 0);
  const shot4 = await shot('4-consent-off-account-guard');
  console.log(`PASS consent-off payload and account guard render nothing; shot ${shot4}`);
  console.log(`screenshots in ${shots}`);
} finally {
  await transport?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
