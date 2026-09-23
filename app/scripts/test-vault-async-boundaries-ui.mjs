// Vault async-boundary regression: drives the real VaultProvider's state logic
// (useState/useRef are never mocked) and delays ONLY external boundaries
// (ECDH deriveBits, the /api/vault PATCH). Covers the post-await publication
// boundaries the lifecycle baseline does not:
//   K1. keep()          — lock during ECDH; no share dispatch after.
//   K2. legacy openShare() — lock during ECDH; no password returned after.
//   K3. addPasskey()    — lock during the vault PATCH; no stale remote after.
//   K4. sealTeamKey()   — lock during ECDH; no sealed result after.
//   K5. openTeamKey()   — lock during ECDH; no opened key after.
//
// The provider's commit() requires the exact object from prepare(false, pw);
// setup uses that production path (never a bypass). Synthetic data only; no
// real account, network, secrets, commits or deploys.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const VAULT_PROVIDER = join(APP, 'src', 'vault', 'VaultProvider.tsx');
const sourceHash = createHash('sha256').update(readFileSync(VAULT_PROVIDER)).digest('hex');

const profile = await mkdtemp(join(tmpdir(), 'vault-async-'));
const ENTRY_ID = 'virtual:vault-async-entry';
const FIREBASE_STUB = join(here, 'fixtures', 'firebase-stub.ts');

const entryPlugin = {
  name: 'vault-async-entry',
  enforce: 'pre',
  resolveId(id, importer) {
    if (id === ENTRY_ID) return '\0' + ENTRY_ID + '.js';
    if (id === './firebase' && importer && importer.endsWith('/src/lib/api.ts')) return FIREBASE_STUB;
    return null;
  },
  load(id) {
    if (id !== '\0' + ENTRY_ID + '.js') return null;
    return `
      import * as ReactModule from 'react';
      import { createRoot } from 'react-dom/client';
      import { AuthContext } from '/src/auth/AuthProvider.tsx';
      import { VaultProvider, useVault } from '/src/vault/VaultProvider.tsx';
      import { clearLocalVault, loadLocalVault } from '/src/lib/vault-store.ts';
      import { ensureKeypair, sealForMembers } from '/src/lib/keypair.ts';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, AuthContext, VaultProvider, useVault, clearLocalVault, loadLocalVault, ensureKeypair, sealForMembers };
    `;
  },
};

const server = await createServer({
  root: APP,
  plugins: [entryPlugin],
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'silent',
});

const SETUP = `
  globalThis.vt = { error: undefined };
  window.addEventListener('error', (event) => { vt.error = (vt.error ? vt.error + ' | ' : '') + 'window: ' + (event.error ? event.error.name + ': ' + event.error.message : event.message); });
  window.addEventListener('unhandledrejection', (event) => { const reason = event.reason; vt.error = (vt.error ? vt.error + ' | ' : '') + 'rejection: ' + (reason ? (reason.name || 'Error') + ': ' + reason.message : String(reason)); });
  try {
    const { React, createRoot, AuthContext, VaultProvider, useVault, clearLocalVault, loadLocalVault, ensureKeypair, sealForMembers } =
      await import('/@id/__x00__${ENTRY_ID}.js');
    Object.assign(globalThis.vt, {
      currentUid: 'account-a', vaults: {}, vault: null,
      accountVersions: { 'account-a': 11, 'account-b': 22 },
      shareCalls: [], unlockCalls: [],
      clearLocalVault, loadLocalVault, ensureKeypair, sealForMembers,
      gateEntered: () => !!(globalThis.__gateState && globalThis.__gateState.entered),
    });
    const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      const method = (init.method ?? 'GET').toUpperCase();
      const uid = vt.currentUid;
      if (url.pathname === '/api/vault') {
        if (method === 'POST') {
          const body = JSON.parse(init.body);
          vt.vaults[uid] = { uid, publicKey: body.public_key, encryptedPrivateKey: body.encrypted_private_key, recoveryWrap: body.recovery_wrap, version: vt.accountVersions[uid] ?? 1, createdAt: Date.now(), updatedAt: Date.now() };
        }
        if (method === 'PATCH') {
          vt.unlockCalls.push(uid);
          const gate = globalThis.__unlockGate;
          if (gate && gate.armed) { gate.armed = false; gate.entered = true; await gate.wait; }
          return json({ vault: { uid, publicKey: (vt.vaults[uid] || {}).publicKey || 'stale-key', encryptedPrivateKey: '', recoveryWrap: '', version: 999, createdAt: 0, updatedAt: 0 } });
        }
        return json({ vault: vt.vaults[uid] ?? null });
      }
      if (url.pathname === '/api/sessions') return json({ sessions: [] });
      if (method === 'PUT' && url.pathname.includes('/api/sessions/') && url.pathname.endsWith('/keys')) {
        vt.shareCalls.push(url.pathname);
        return json({ shared: 1 });
      }
      return json({});
    };
    globalThis.WebSocket = class extends EventTarget { readyState = 0; send() {} close() { this.readyState = 3; } };
    const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    globalThis.__armGate = (mode) => { let release; const wait = new Promise((resolve) => { release = resolve; }); globalThis.__gateState = { mode, entered: false, wait, release }; };
    globalThis.__releaseGate = () => { const gate = globalThis.__gateState; if (gate) { gate.mode = null; gate.release(); } };
    crypto.subtle.deriveBits = async (algorithm, ...rest) => { const gate = globalThis.__gateState; if (gate && gate.mode === 'ecdh' && algorithm && algorithm.name === 'ECDH') { gate.mode = null; gate.entered = true; await gate.wait; } return realDeriveBits(algorithm, ...rest); };
    globalThis.__armUnlockGate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); globalThis.__unlockGate = { armed: true, entered: false, wait, release }; };
    globalThis.__releaseUnlockGate = () => { const gate = globalThis.__unlockGate; if (gate) { gate.armed = false; gate.release(); } };
    /* Synthetic WebAuthn so addPasskey reaches its network boundary without a real authenticator. */
    Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create: async () => ({ rawId: crypto.getRandomValues(new Uint8Array(16)), getClientExtensionResults: () => ({ prf: { results: { first: crypto.getRandomValues(new Uint8Array(32)) } } }) }) } });
    function VaultProbe() { vt.vault = useVault(); return null; }
    function Harness() {
      const [user, setUser] = React.useState({ uid: 'account-a', email: 'account-a@test', displayName: 'account-a', emailVerified: true, providerData: [] });
      const [mountKey, setMountKey] = React.useState(0);
      globalThis.__harness = {
        switchAccount: (uid) => { vt.currentUid = uid; setUser({ uid, email: uid + '@test', displayName: uid, emailVerified: true, providerData: [] }); },
        remount: () => setMountKey((value) => value + 1),
      };
      const auth = { mode: 'firebase', user, initializing: false, signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {}, signInWithProvider: async () => {}, resetPassword: async () => {}, resendVerification: async () => {}, signOutUser: async () => {}, deleteAccount: async () => {} };
      return React.createElement(AuthContext.Provider, { value: auth }, React.createElement(VaultProvider, { key: mountKey }, React.createElement(VaultProbe)));
    }
    const mount = document.createElement('div');
    mount.id = 'vault-async-test';
    document.body.append(mount);
    createRoot(mount).render(React.createElement(Harness));
    vt.switchAccount = (uid) => globalThis.__harness.switchAccount(uid);
  } catch (error) { globalThis.vt.error = error.name + ': ' + error.message; }
  return true;
`;

let transport;
const evaluate = (expression) => transport.evaluate(expression);
const waitFor = async (check, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { if (await check()) return; last = undefined; } catch (error) { last = error; }
    await delay(50);
  }
  throw new Error(last ? 'Timed out: ' + label + ' (' + last.message + ')' : 'Timed out: ' + label);
};
const settle = () => delay(150);
const results = [];

try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = await launchChromeTransport({ profile });
  await transport.setViewport({ width: 1000, height: 800, dpr: 1, mobile: false });
  await transport.navigate('http://127.0.0.1:' + port + '/scripts/fixtures/route-test.html?vault-async=' + Date.now());
  await waitFor(() => evaluate("document.readyState !== 'loading'"), 'page load');
  await evaluate('(async () => { ' + SETUP + ' })()');
  const setupError = await evaluate('vt.error');
  if (setupError) throw new Error('Setup error: ' + setupError);
  await waitFor(() => evaluate("vt.vault && vt.vault.status !== 'loading'"), 'initial vault load');

  const switchTo = async (uid) => {
    await evaluate(`vt.switchAccount(${JSON.stringify(uid)})`);
    await waitFor(() => evaluate(`vt.vault && vt.vault.uid === ${JSON.stringify(uid)}`), 'rendered uid ' + uid);
    await waitFor(() => evaluate("vt.vault.status !== 'loading'"), 'settled for ' + uid);
  };
  const resetAccount = async (uid) => {
    await switchTo(uid);
    await evaluate(`(async () => {
      delete vt.vaults[${JSON.stringify(uid)}];
      await vt.clearLocalVault(${JSON.stringify(uid)});
      vt.vault.retry();
      for (let i = 0; i < 300 && vt.vault.status === 'loading'; i++) await new Promise((r) => setTimeout(r, 10));
      return vt.vault.status;
    })()`);
    await waitFor(() => evaluate(`vt.vault.uid === ${JSON.stringify(uid)} && ['setup','locked'].includes(vt.vault.status)`), 'account reset to locked/setup');
  };
  // Production unlock: prepare(false, pw) then commit(the exact prepared object).
  const unlockFreshA = async () => {
    await resetAccount('account-a');
    await evaluate(`(async () => {
      const made = await vt.vault.prepare(false, 'pw-a');
      await vt.vault.commit(made);
      return vt.vault.status;
    })()`);
    await waitFor(() => evaluate("vt.vault.status === 'unlocked'"), 'A unlocked');
  };

  // ---- K1: keep() delayed by ECDH, lock before release -> no share dispatch ----
  await unlockFreshA();
  await evaluate('(async () => { vt.shareCalls = []; __armGate("ecdh"); vt.keepDone = false; vt.keepValue = "pending"; vt.vault.keep("extra-keep-session", "pw-keep").then((kept) => { vt.keepDone = true; vt.keepValue = kept; }, () => { vt.keepDone = true; vt.keepValue = "error"; }); return true; })()');
  await waitFor(() => evaluate('vt.gateEntered()'), 'keep ECDH reached');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.keepDone === true'), 'keep settled');
  await settle();
  const k1 = await evaluate('JSON.stringify({ kept: vt.keepValue, shares: vt.shareCalls.length, status: vt.vault.status })').then(JSON.parse);
  results.push({ scenario: 'keep-after-lock-no-dispatch', kept: k1.kept, shareDispatches: k1.shares, status: k1.status, pass: k1.kept === false && k1.shares === 0 && k1.status === 'locked' });

  // ---- K2: legacy openShare() delayed by ECDH, lock before release -> null ----
  await unlockFreshA();
  await evaluate('(async () => { vt.legacy = await vt.ensureKeypair().then((kp) => vt.sealForMembers([{ uid: "account-a", publicKey: kp.publicKey }], "legacy-pw")).then((shares) => shares[0]); return true; })()');
  const k2share = await evaluate('JSON.stringify(vt.legacy)').then(JSON.parse);
  await evaluate('(async () => { __armGate("ecdh"); vt.shareDone = false; vt.shareValue = "pending"; vt.vault.openShare("legacy-session", { senderPublicKey: vt.legacy.senderPublicKey, sealed: vt.legacy.sealed }).then((value) => { vt.shareDone = true; vt.shareValue = value; }, () => { vt.shareDone = true; vt.shareValue = "error"; }); return true; })()');
  await waitFor(() => evaluate('vt.gateEntered()'), 'legacy openSealed ECDH reached');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.shareDone === true'), 'legacy openShare settled');
  await settle();
  const k2 = await evaluate('JSON.stringify({ value: vt.shareValue, status: vt.vault.status })').then(JSON.parse);
  results.push({ scenario: 'legacy-open-share-after-lock', isLegacy: !k2share.sealed.startsWith('v2.'), actual: k2.value, status: k2.status, pass: k2.value === null && k2.status === 'locked' });

  // ---- K3: addPasskey() delayed at the vault PATCH, lock before release -> no stale remote ----
  await unlockFreshA();
  await evaluate('(async () => { __armUnlockGate(); vt.passkeyDone = false; vt.unlockCalls = []; vt.vault.addPasskey("pw-a", "Extra").then(() => { vt.passkeyDone = true; }, () => { vt.passkeyDone = true; }); return true; })()');
  await waitFor(() => evaluate('globalThis.__unlockGate && globalThis.__unlockGate.entered'), 'passkey vault PATCH reached');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseUnlockGate()');
  await waitFor(() => evaluate('vt.passkeyDone === true'), 'addPasskey settled');
  await settle();
  const k3 = await evaluate('JSON.stringify({ version: vt.vault.version, status: vt.vault.status, patched: vt.unlockCalls.length })').then(JSON.parse);
  results.push({ scenario: 'add-passkey-after-lock-no-stale-remote', version: k3.version, status: k3.status, patched: k3.patched, pass: k3.version !== 999 && k3.status === 'locked' });

  // ---- K4: sealTeamKey() delayed by ECDH, lock before release -> null ----
  await unlockFreshA();
  const k4pub = await evaluate('vt.vault.publicKey');
  await evaluate('(async () => { __armGate("ecdh"); vt.teamSealDone = false; vt.teamSealed = "pending"; vt.vault.sealTeamKey({ uid: "peer", accountKey: ' + JSON.stringify(k4pub) + ' }, { orgId: "org-extra", version: 1 }, new Uint8Array(32)).then((sealed) => { vt.teamSealDone = true; vt.teamSealed = sealed; }, () => { vt.teamSealDone = true; vt.teamSealed = "error"; }); return true; })()');
  await waitFor(() => evaluate('vt.gateEntered()'), 'sealTeamKey ECDH reached');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.teamSealDone === true'), 'sealTeamKey settled');
  await settle();
  const k4 = await evaluate('JSON.stringify({ sealed: vt.teamSealed, status: vt.vault.status })').then(JSON.parse);
  results.push({ scenario: 'seal-team-key-after-lock', actual: k4.sealed, status: k4.status, pass: k4.sealed === null && k4.status === 'locked' });

  // ---- K5: openTeamKey() delayed by ECDH, lock before release -> null ----
  await unlockFreshA();
  await evaluate('(async () => { vt.teamSealed = await vt.vault.sealTeamKey({ uid: "peer", accountKey: vt.vault.publicKey }, { orgId: "org-extra", version: 1 }, new Uint8Array(32)); vt.teamSender = vt.vault.publicKey; return true; })()');
  await evaluate('(async () => { __armGate("ecdh"); vt.teamOpenDone = false; vt.teamOpened = "pending"; vt.vault.openTeamKey({ senderUid: "peer", sealed: vt.teamSealed }, vt.teamSender, { orgId: "org-extra", version: 1 }).then((key) => { vt.teamOpenDone = true; vt.teamOpened = key ? "key" : null; }, () => { vt.teamOpenDone = true; vt.teamOpened = "error"; }); return true; })()');
  await waitFor(() => evaluate('vt.gateEntered()'), 'openTeamKey ECDH reached');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.teamOpenDone === true'), 'openTeamKey settled');
  await settle();
  const k5 = await evaluate('JSON.stringify({ opened: vt.teamOpened, status: vt.vault.status })').then(JSON.parse);
  results.push({ scenario: 'open-team-key-after-lock', actual: k5.opened, status: k5.status, pass: k5.opened === null && k5.status === 'locked' });

  const ok = results.every((result) => result.pass);
  console.log(JSON.stringify({ test: 'vault-async-boundaries', ok, sourceSha256: sourceHash, results }));
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error('FAIL vault-async-boundaries: ' + error.message);
  process.exitCode = 1;
} finally {
  try { await transport?.close?.(); } catch { /* best effort */ }
  try { await server.close(); } catch { /* best effort */ }
  try { await rm(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
