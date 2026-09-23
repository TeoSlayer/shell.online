// Vault lifecycle regression: drives the real VaultProvider's state logic
// (useState/useRef are never mocked) and delays ONLY external boundaries:
//   - crypto.subtle.digest("SHA-256")  -> fingerprint await in becomeUnlocked
//   - crypto.subtle.deriveKey(PBKDF2)  -> expensive crypto in openVaultWithPassword
//   - saveLocalVault, before it opens IndexedDB -> storage write boundary
//   - /api/vault POST response -> remote save boundary
//
// Twelve independent cases:
//   B. fingerprint-after-lock: lock() during fingerprint; stale continuation
//      must not publish "unlocked".
//   A. password-before-guard: lock() while PBKDF2 is running; stale key must
//      not be reinstalled or repopulated.
//   C. stale-save-after-lock: hold saveLocalVault, lock, release; memory stays
//      locked, storage not repopulated, remount does not auto-unlock.
//   D. stale-save-after-newer-unlock: hold old save, lock, newer unlock
//      completes, release old; newer key must survive.
//   E. stale-save-cross-account: hold A's save, switch to B, unlock B,
//      release A's save; A must not regain authorization, B intact.
//   E2. stale-fingerprint-cross-account: hold A's fingerprint, switch to B,
//      unlock B, release; live fingerprint must be B's.
//   F. stale-save-same-owner-new-key: hold old-gen save, commit new key,
//      release old; newer key must not be overwritten.
//   G. stale-remote-cross-account: delayed saveVault must not publish A's
//      remote onto B after an account switch.
//   H. sync-uid-boundary-layout-effect: child layout effect on account switch
//      must see the new uid with no leaked key/status.
//   I. delayed-open-share-after-lock: openShare held on ECDH, lock, release;
//      must return null.
//   I2. delayed-open-share-cross-account: openShare held on ECDH, switch
//      account, release; must return null.
//   J. unmount-invalidates-pending-save: hold save, unmount, release; storage
//      not repopulated, later legit unlock still works.
//
// Mutation isolation (in-memory Vite transforms):
//   --mutation=fingerprint-guard: disables becomeUnlocked post-await guard; B fails.
//   --mutation=precapture: drops pre-await capture in unlockWithPassword; A fails.
//   --mutation=storage-admission: removes isCurrent check in saveLocalVault; F fails.
//   --mutation=sync-guard: disables render-phase UID boundary; H fails.
//   --mutation=unmount-invalidate: removes unmount invalidation; J fails.
//
// No real account, no commits/deploys. Synthetic data only.
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

const mutationArg = process.argv.find((value) => value.startsWith('--mutation='));
const mutation = mutationArg ? mutationArg.slice('--mutation='.length) : null;
if (mutation !== null && !['fingerprint-guard', 'precapture', 'storage-admission', 'sync-guard', 'unmount-invalidate'].includes(mutation)) {
  throw new Error('unknown mutation: ' + mutation);
}

const profile = await mkdtemp(join(tmpdir(), 'vault-lifecycle-'));
const ENTRY_ID = 'virtual:vault-lifecycle-entry';
const FIREBASE_STUB = join(here, 'fixtures', 'firebase-stub.ts');

const entryPlugin = {
  name: 'vault-lifecycle-entry',
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
      import { createVault, fingerprint, sealToAccount } from '/src/lib/vault-crypto.ts';
      import { clearLocalVault, loadLocalVault } from '/src/lib/vault-store.ts';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, AuthContext, VaultProvider, useVault, createVault, fingerprint, sealToAccount, clearLocalVault, loadLocalVault };
    `;
  },
};

const overlayPlugin = {
  name: 'vault-lifecycle-overlay',
  enforce: 'pre',
  transform(code, id) {
    if (id.includes('vault-store.ts') && !id.includes('?overlay')) {
      const marker = 'export async function saveLocalVault';
      if (!code.includes(marker)) throw new Error('storage overlay target not found');
      let transformed = code.replace(marker, 'async function __realSaveLocalVault');
      if (mutation === 'storage-admission') {
        transformed = transformed.split('if (isCurrent && !isCurrent()) return false;').join('if (false && isCurrent && !isCurrent()) return false;');
      }
      const clearTarget = 'await enqueue(uid, async () => {\n    try {\n      const database = await openDatabase();';
      if (transformed.includes(clearTarget)) {
        transformed = transformed.replace(clearTarget, 'await enqueue(uid, async () => {\n    try {\n      const __cg = globalThis.__clearGate;\n      if (__cg && __cg.armed) { __cg.armed = false; __cg.entered = true; await __cg.wait; }\n      const database = await openDatabase();');
      }
      return transformed + `
export async function saveLocalVault(...args) {
  const gate = globalThis.__saveGate;
  if (gate && gate.armed) { gate.armed = false; gate.entered = true; await gate.wait; }
  return __realSaveLocalVault(...args);
}
`;
    }
    if (mutation && mutation !== 'storage-admission' && id.includes('VaultProvider.tsx')) {
      const targets = {
        'fingerprint-guard': ['if (lifecycle.current.generation !== myGen) return;', 'if (false && lifecycle.current.generation !== myGen) return;'],
        precapture: ['const gen = lifecycle.current.generation;\n    const next = await openVaultWithPassword(uid, remote, password);\n    if (lifecycle.current.generation !== gen) return;', 'const next = await openVaultWithPassword(uid, remote, password);\n    const gen = lifecycle.current.generation;\n    if (lifecycle.current.generation !== gen) return;'],
        'sync-guard': ['if (lifecycle.current.uid !== uid) {', 'if (false && lifecycle.current.uid !== uid) {'],
        'unmount-invalidate': ['lifecycle.current.generation++;\n    opened.current = null;\n  }, []);', '/* mutation: no unmount invalidation */\n  }, []);'],
      };
      const [needle, replacement] = targets[mutation];
      if (!code.includes(needle)) throw new Error('mutation target not found: ' + mutation);
      return code.replace(needle, replacement);
    }
    return null;
  },
};

const server = await createServer({
  root: APP,
  plugins: [entryPlugin, overlayPlugin],
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'silent',
});

const SETUP = `
  globalThis.vt = { error: undefined };
  window.addEventListener('error', (event) => { vt.error = (vt.error ? vt.error + ' | ' : '') + 'window: ' + (event.error ? event.error.name + ': ' + event.error.message : event.message); });
  window.addEventListener('unhandledrejection', (event) => { const reason = event.reason; vt.error = (vt.error ? vt.error + ' | ' : '') + 'rejection: ' + (reason ? (reason.name || 'Error') + ': ' + reason.message : String(reason)); });
  try {
    const { React, createRoot, AuthContext, VaultProvider, useVault, createVault, fingerprint, sealToAccount, clearLocalVault, loadLocalVault } =
      await import('/@id/__x00__${ENTRY_ID}.js');
    Object.assign(globalThis.vt, {
      currentUid: 'account-a', vaults: {}, keys: {}, made: {}, vault: null,
      accountVersions: { 'account-a': 11, 'account-b': 22 },
      layoutProbe: null, keepProbe: [],
      fingerprint, createVault, sealToAccount, clearLocalVault, loadLocalVault,
      gateEntered: () => !!(globalThis.__gateState && globalThis.__gateState.entered),
      saveGateEntered: () => !!(globalThis.__saveGate && globalThis.__saveGate.entered),
      clearGateEntered: () => !!(globalThis.__clearGate && globalThis.__clearGate.entered),
      vaultPostGateEntered: () => !!(globalThis.__vaultPostGate && globalThis.__vaultPostGate.entered),
      rememberedPublicKey: async (uid) => { const local = await loadLocalVault(uid); return local ? local.publicKey : null; },
    });
    const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      const method = (init.method ?? 'GET').toUpperCase();
      const uid = vt.currentUid;
      if (url.pathname === '/api/vault') {
        if (method === 'POST') {
          const body = JSON.parse(init.body);
          vt.vaults[uid] = {
            publicKey: body.public_key, encryptedPrivateKey: body.encrypted_private_key,
            recoveryWrap: body.recovery_wrap, version: vt.accountVersions[uid] ?? 1,
            createdAt: Date.now(), updatedAt: Date.now(),
          };
          const gate = globalThis.__vaultPostGate;
          if (gate && gate.armed) { gate.armed = false; gate.entered = true; await gate.wait; }
        }
        return json({ vault: vt.vaults[uid] ?? null });
      }
      if (url.pathname === '/api/sessions') return json({ sessions: [] });
      return json({});
    };
    globalThis.WebSocket = class extends EventTarget { readyState = 0; send() {} close() { this.readyState = 3; } };
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const realDeriveKey = crypto.subtle.deriveKey.bind(crypto.subtle);
    const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    globalThis.__armGate = (mode) => { let release; const wait = new Promise((resolve) => { release = resolve; }); globalThis.__gateState = { mode, entered: false, wait, release }; };
    globalThis.__releaseGate = () => { const gate = globalThis.__gateState; if (gate) { gate.mode = null; gate.release(); } };
    crypto.subtle.digest = async (...args) => { const gate = globalThis.__gateState; if (gate && gate.mode === 'digest') { gate.mode = null; gate.entered = true; await gate.wait; } return realDigest(...args); };
    crypto.subtle.deriveKey = async (algorithm, ...rest) => { const gate = globalThis.__gateState; if (gate && gate.mode === 'pbkdf2' && algorithm && algorithm.name === 'PBKDF2') { gate.mode = null; gate.entered = true; await gate.wait; } return realDeriveKey(algorithm, ...rest); };
    crypto.subtle.deriveBits = async (algorithm, ...rest) => { const gate = globalThis.__gateState; if (gate && gate.mode === 'ecdh' && algorithm && algorithm.name === 'ECDH') { gate.mode = null; gate.entered = true; await gate.wait; } return realDeriveBits(algorithm, ...rest); };
    globalThis.__armSaveGate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); globalThis.__saveGate = { armed: true, entered: false, wait, release }; };
    globalThis.__releaseSaveGate = () => { const gate = globalThis.__saveGate; if (gate) { gate.armed = false; gate.release(); } };
    globalThis.__armClearGate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); globalThis.__clearGate = { armed: true, entered: false, wait, release }; };
    globalThis.__releaseClearGate = () => { const gate = globalThis.__clearGate; if (gate) { gate.armed = false; gate.release(); } };
    globalThis.__armVaultPostGate = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); globalThis.__vaultPostGate = { armed: true, entered: false, wait, release }; };
    globalThis.__releaseVaultPostGate = () => { const gate = globalThis.__vaultPostGate; if (gate) { gate.armed = false; gate.release(); } };
    function VaultProbe() {
      const vault = useVault();
      vt.vault = vault;
      const lastUid = React.useRef(vault.uid);
      React.useLayoutEffect(() => {
        if (lastUid.current === vault.uid) return;
        lastUid.current = vault.uid;
        vt.layoutProbe = {
          uid: vault.uid,
          status: vault.status,
          publicKeyPrefix: vault.publicKey ? vault.publicKey.slice(0, 8) : null,
        };
        const uidAt = vault.uid;
        vault.keep('probe-session', 'probe-pw').then(
          (kept) => vt.keepProbe.push({ uid: uidAt, kept }),
          () => vt.keepProbe.push({ uid: uidAt, kept: 'error' }),
        );
      }, [vault]);
      return null;
    }
    function Harness() {
      const [user, setUser] = React.useState({ uid: 'account-a', email: 'account-a@test', displayName: 'account-a', emailVerified: true, providerData: [] });
      const [mountKey, setMountKey] = React.useState(0);
      const [hidden, setHidden] = React.useState(false);
      globalThis.__harness = {
        switchAccount: (uid) => { vt.currentUid = uid; setUser({ uid, email: uid + '@test', displayName: uid, emailVerified: true, providerData: [] }); },
        remount: () => { setHidden(false); setMountKey((value) => value + 1); },
        hide: () => setHidden(true),
      };
      const auth = { mode: 'firebase', user, initializing: false,
        signIn: async () => {}, signUp: async () => {}, signInWithGoogle: async () => {}, signInWithProvider: async () => {},
        resetPassword: async () => {}, resendVerification: async () => {}, signOutUser: async () => {}, deleteAccount: async () => {} };
      return React.createElement(AuthContext.Provider, { value: auth },
        hidden ? null : React.createElement(VaultProvider, { key: mountKey }, React.createElement(VaultProbe)));
    }
    const mount = document.createElement('div');
    mount.id = 'vault-lifecycle-test';
    document.body.append(mount);
    createRoot(mount).render(React.createElement(Harness));
    vt.switchAccount = (uid) => globalThis.__harness.switchAccount(uid);
    vt.remount = () => globalThis.__harness.remount();
    vt.hide = () => globalThis.__harness.hide();
  } catch (error) { globalThis.vt.error = error.name + ': ' + error.message; }
  return true;
`;

let transport;
const evaluate = async (expression) => {
  try {
    return await transport.evaluate(expression);
  } catch (error) {
    console.error('EVAL FAIL head=' + JSON.stringify(String(expression).slice(0, 140)));
    throw error;
  }
};
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
const prefix = (value) => (typeof value === 'string' ? value.slice(0, 10) : value);
const blob = (expression) => evaluate('JSON.stringify(' + expression + ')').then((text) => JSON.parse(text));

try {
  await server.listen();
  const port = server.httpServer.address().port;
  transport = await launchChromeTransport({ profile });
  await transport.setViewport({ width: 1000, height: 800, dpr: 1, mobile: false });
  await transport.navigate('http://127.0.0.1:' + port + '/scripts/fixtures/route-test.html?vault-lifecycle=' + Date.now());
  await waitFor(() => evaluate("document.readyState !== 'loading'"), 'page load');
  await evaluate('(async () => { ' + SETUP + ' })()');
  const setupError = await evaluate('vt.error');
  if (setupError) throw new Error('Setup error: ' + setupError);
  await waitFor(() => evaluate("vt.vault && vt.vault.status !== 'loading'"), 'initial vault load');

  const status = () => evaluate('vt.vault.status');
  const liveKey = () => evaluate('vt.vault.publicKey');
  const switchTo = async (uid) => {
    await evaluate(`vt.switchAccount(${JSON.stringify(uid)})`);
    await waitFor(() => evaluate(`vt.vault && vt.vault.uid === ${JSON.stringify(uid)}`), 'provider rendered uid ' + uid);
    await waitFor(() => evaluate(`vt.vault.status !== 'loading'`), 'provider settled for ' + uid);
  };
  const readAccountState = async (uid) => evaluate(
    `(async () => JSON.stringify({ uid: vt.vault.uid, status: vt.vault.status, publicKey: vt.vault.publicKey, version: vt.vault.version, fingerprint: vt.vault.fingerprint, remembered: await vt.rememberedPublicKey(${JSON.stringify(uid)}) }))()`,
  ).then((text) => JSON.parse(text));
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

  // ---- Case B: lock while becomeUnlocked is awaiting fingerprint ----
  await resetAccount('account-a');
  await evaluate(`(async () => {
    const made = await vt.createVault('account-a');
    __armGate('digest');
    vt.commitDone = false;
    vt.pendingCommit = vt.vault.commit(made).then(() => { vt.commitDone = true; }, () => { vt.commitDone = true; });
    return true;
  })()`);
  await waitFor(() => evaluate('vt.gateEntered()'), 'fingerprint await reached');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.commitDone === true'), 'commit settlement observed');
  await settle();
  const bStatus = await status();
  const bKeyHeld = await evaluate("vt.vault.keep('lifecycle-session', 'pw')");
  const bRemembered = await evaluate('(async () => (await vt.loadLocalVault(vt.currentUid)) !== null)()');
  results.push({ scenario: 'fingerprint-after-lock', expectedStatus: 'locked', actualStatus: bStatus, actualKeyHeld: bKeyHeld, actualRemembered: bRemembered, pass: bStatus === 'locked' && bKeyHeld === false });

  // ---- Case A: lock while PBKDF2 crypto is still running ----
  await resetAccount('account-a');
  await evaluate(`(async () => {
    const made = await vt.createVault('account-a', 'pw-canary');
    await vt.vault.commit(made);
    await vt.vault.lock();
    __armGate('pbkdf2');
    vt.unlockDone = false;
    vt.pendingUnlock = vt.vault.unlockWithPassword('pw-canary').then(() => { vt.unlockDone = true; }, () => { vt.unlockDone = true; });
    return vt.vault.status;
  })()`);
  await waitFor(() => evaluate('vt.gateEntered()'), 'password crypto reached');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.unlockDone === true'), 'unlock settlement observed');
  await settle();
  const aStatus = await status();
  const aKeyHeld = await evaluate("vt.vault.keep('lifecycle-session', 'pw')");
  const aRemembered = await evaluate('(async () => (await vt.loadLocalVault(vt.currentUid)) !== null)()');
  results.push({ scenario: 'password-before-guard', expectedStatus: 'locked', actualStatus: aStatus, actualKeyHeld: aKeyHeld, actualRemembered: aRemembered, pass: aStatus === 'locked' && aKeyHeld === false && aRemembered === false });

  // ---- Case C: stale saveLocalVault completing after lock/clear ----
  await resetAccount('account-a');
  await evaluate(`(async () => {
    const made = await vt.createVault('account-a', 'pw-canary');
    await vt.vault.commit(made);
    await vt.vault.lock();
    __armSaveGate();
    vt.unlockDone = false;
    vt.pendingUnlock = vt.vault.unlockWithPassword('pw-canary').then(() => { vt.unlockDone = true; }, () => { vt.unlockDone = true; });
    return vt.vault.status;
  })()`);
  await waitFor(() => evaluate('vt.saveGateEntered()'), 'saveLocalVault reached before its write');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseSaveGate()');
  await waitFor(() => evaluate('vt.unlockDone === true'), 'unlock settlement observed');
  await settle();
  const cStatus = await status();
  const cKeyHeld = await evaluate("vt.vault.keep('lifecycle-session', 'pw')");
  const cRemembered = await evaluate('(async () => (await vt.loadLocalVault(vt.currentUid)) !== null)()');
  await evaluate('vt.remount()');
  await waitFor(() => evaluate("vt.vault && vt.vault.status !== 'loading'"), 'remounted provider settled');
  const cRemountStatus = await status();
  results.push({ scenario: 'stale-save-after-lock', actualStatus: cStatus, actualKeyHeld: cKeyHeld, actualRemembered: cRemembered, actualRemountStatus: cRemountStatus, pass: cStatus === 'locked' && cKeyHeld === false && cRemembered === false && cRemountStatus === 'locked' });

  // ---- Case D: stale older save must not delete a newer live vault ----
  await resetAccount('account-a');
  await evaluate(`(async () => {
    const made = await vt.createVault('account-a', 'pw-canary');
    await vt.vault.commit(made);
    await vt.vault.lock();
    __armSaveGate();
    vt.oldDone = false; vt.newDone = false;
    vt.pendingOld = vt.vault.unlockWithPassword('pw-canary').then(() => { vt.oldDone = true; }, () => { vt.oldDone = true; });
    return vt.vault.status;
  })()`);
  await waitFor(() => evaluate('vt.saveGateEntered()'), 'older save held before its write');
  await evaluate('vt.vault.lock()');
  await evaluate(`(async () => {
    vt.pendingNew = vt.vault.unlockWithPassword('pw-canary').then(() => { vt.newDone = true; }, () => { vt.newDone = true; });
    return true;
  })()`);
  await waitFor(() => evaluate('vt.newDone === true'), 'newer unlock settled while older save still held');
  await settle();
  await evaluate('__releaseSaveGate()');
  await waitFor(() => evaluate('vt.oldDone === true'), 'older save settled after release');
  await settle();
  const dStatus = await status();
  const dKeyHeld = await evaluate("vt.vault.keep('lifecycle-session', 'pw')");
  const dRemembered = await evaluate('(async () => (await vt.loadLocalVault(vt.currentUid)) !== null)()');
  await evaluate('vt.remount()');
  await waitFor(() => evaluate("vt.vault && vt.vault.status !== 'loading'"), 'case D remount settled');
  const dRemountStatus = await status();
  results.push({ scenario: 'stale-save-after-newer-unlock', actualStatus: dStatus, actualKeyHeld: dKeyHeld, actualRemembered: dRemembered, actualRemountStatus: dRemountStatus, pass: dStatus === 'unlocked' && dKeyHeld === true && dRemembered === true && dRemountStatus === 'unlocked' });

  // Fixed per-account keys, created once with real WebCrypto.
  const keysDiffer = await evaluate(`(async () => {
    const a = await vt.createVault('account-a', 'pw-a');
    const b = await vt.createVault('account-b', 'pw-b');
    vt.made = { a, b };
    vt.keys = { a: a.bundle.publicKey, b: b.bundle.publicKey };
    return a.bundle.publicKey !== b.bundle.publicKey;
  })()`);
  if (keysDiffer !== true) throw new Error('account keys are not distinct');
  const keys = await blob('({ a: vt.keys.a, b: vt.keys.b })');

  // ---- Case E: account A stale save held across a switch to account B ----
  await resetAccount('account-a');
  await evaluate('(async () => { await vt.vault.commit(vt.made.a); await vt.vault.lock(); return true; })()');
  await evaluate(`(async () => {
    __armSaveGate();
    vt.aDone = false;
    vt.pendingA = vt.vault.unlockWithPassword('pw-a').then(() => { vt.aDone = true; }, () => { vt.aDone = true; });
    return true;
  })()`);
  await waitFor(() => evaluate('vt.saveGateEntered()'), 'account A save held');
  await switchTo('account-b');
  await evaluate(`(async () => {
    await vt.vault.commit(vt.made.b);
    await vt.vault.lock();
    vt.bDone = false;
    vt.pendingB = vt.vault.unlockWithPassword('pw-b').then(() => { vt.bDone = true; }, () => { vt.bDone = true; });
    for (let i = 0; i < 300 && !vt.bDone; i++) await new Promise((r) => setTimeout(r, 10));
    return vt.vault.status;
  })()`);
  await evaluate('__releaseSaveGate()');
  await waitFor(() => evaluate('vt.aDone === true'), 'account A save settled after release');
  await settle();
  const eLiveUid = await evaluate('vt.currentUid');
  const eLiveKey = await liveKey();
  const eARemembered = await evaluate("(async () => await vt.rememberedPublicKey('account-a'))()");
  const eBRemembered = await evaluate("(async () => await vt.rememberedPublicKey('account-b'))()");
  await evaluate(`(async () => {
    vt.switchAccount('account-a');
    vt.remount();
    for (let i = 0; i < 300 && (!vt.vault || vt.vault.status === 'loading'); i++) await new Promise((r) => setTimeout(r, 10));
    return true;
  })()`);
  await waitFor(() => evaluate("vt.vault && vt.vault.status !== 'loading'"), 'account A remount settled');
  const eRemountAStatus = await status();
  const eRemountAKey = await liveKey();
  results.push({
    scenario: 'stale-save-cross-account', liveUid: eLiveUid,
    expectedBLiveKey: prefix(keys.b), actualBLiveKey: prefix(eLiveKey),
    expectedARemembered: null, actualARemembered: prefix(eARemembered),
    expectedBRemembered: prefix(keys.b), actualBRemembered: prefix(eBRemembered),
    expectedARemountStatus: 'locked', actualARemountStatus: eRemountAStatus, actualARemountKey: prefix(eRemountAKey),
    pass: eLiveUid === 'account-b' && eLiveKey === keys.b && eARemembered === null && eBRemembered === keys.b && eRemountAStatus === 'locked' && eRemountAKey !== keys.a,
  });

  // ---- Case E2: account A stale fingerprint must not publish after switching to B ----
  await resetAccount('account-a');
  await evaluate('(async () => { await vt.vault.commit(vt.made.a); await vt.vault.lock(); __armGate("digest"); vt.aDone = false; vt.pendingA = vt.vault.unlockWithPassword("pw-a").then(() => { vt.aDone = true; }, () => { vt.aDone = true; }); return true; })()');
  await waitFor(() => evaluate('vt.gateEntered()'), 'account A fingerprint held');
  await switchTo('account-b');
  await evaluate(`(async () => {
    await vt.vault.commit(vt.made.b);
    await vt.vault.lock();
    vt.bDone = false;
    vt.pendingB = vt.vault.unlockWithPassword('pw-b').then(() => { vt.bDone = true; }, () => { vt.bDone = true; });
    for (let i = 0; i < 300 && !vt.bDone; i++) await new Promise((r) => setTimeout(r, 10));
    return vt.vault.status;
  })()`);
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.aDone === true'), 'account A stale fingerprint settled');
  await settle();
  const e2LiveKey = await liveKey();
  const e2Print = await evaluate('vt.vault.fingerprint');
  const expectedPrintB = await evaluate('vt.fingerprint(vt.keys.b)');
  const expectedPrintA = await evaluate('vt.fingerprint(vt.keys.a)');
  results.push({
    scenario: 'stale-fingerprint-cross-account', liveUid: await evaluate('vt.currentUid'),
    expectedLiveKey: prefix(keys.b), actualLiveKey: prefix(e2LiveKey),
    expectedFingerprint: expectedPrintB, actualFingerprint: e2Print, staleFingerprint: expectedPrintA,
    pass: e2LiveKey === keys.b && e2Print === expectedPrintB && e2Print !== expectedPrintA,
  });

  // ---- Case F: same owner, genuinely different new key generation ----
  await resetAccount('account-a');
  const fKeys = await evaluate(`(async () => {
    const v1 = await vt.createVault('account-a', 'pw-v1');
    vt.v1 = v1.bundle.publicKey;
    await vt.vault.commit(v1);
    await vt.vault.lock();
    __armSaveGate();
    vt.oldDone = false;
    vt.pendingOld = vt.vault.unlockWithPassword('pw-v1').then(() => { vt.oldDone = true; }, () => { vt.oldDone = true; });
    return v1.bundle.publicKey;
  })()`);
  await waitFor(() => evaluate('vt.saveGateEntered()'), 'old-generation save held');
  const fKeyV2 = await evaluate(`(async () => {
    const prepared = await vt.vault.prepare(true, 'pw-v2');
    vt.v2 = prepared.bundle.publicKey;
    await vt.vault.commit(prepared);
    return prepared.bundle.publicKey;
  })()`);
  if (fKeyV2 === fKeys) throw new Error('new key generation is not distinct from the old one');
  await evaluate('__releaseSaveGate()');
  await waitFor(() => evaluate('vt.oldDone === true'), 'old-generation save settled after release');
  await settle();
  const fLiveKey = await liveKey();
  const fRemembered = await evaluate("(async () => await vt.rememberedPublicKey('account-a'))()");
  await evaluate('vt.remount()');
  await waitFor(() => evaluate("vt.vault && vt.vault.status !== 'loading'"), 'case F remount settled');
  const fRemountStatus = await status();
  const fRemountKey = await liveKey();
  results.push({
    scenario: 'stale-save-same-owner-new-key', oldKey: prefix(fKeys), newKey: prefix(fKeyV2),
    expectedLiveKey: prefix(fKeyV2), actualLiveKey: prefix(fLiveKey),
    expectedRemembered: prefix(fKeyV2), actualRemembered: prefix(fRemembered),
    expectedRemountStatus: 'unlocked', actualRemountStatus: fRemountStatus, actualRemountKey: prefix(fRemountKey),
    pass: fLiveKey === fKeyV2 && fRemembered === fKeyV2 && fRemountStatus === 'unlocked' && fRemountKey === fKeyV2,
  });

  // ---- Case G: delayed saveVault + account switch must not publish A's remote onto B ----
  await resetAccount('account-a');
  await evaluate('(async () => { await vt.vault.commit(vt.made.a); await vt.vault.lock(); return true; })()');
  await switchTo('account-b');
  await evaluate('(async () => { await vt.vault.commit(vt.made.b); await vt.vault.lock(); return true; })()');
  await switchTo('account-a');
  await evaluate(`(async () => {
    __armVaultPostGate();
    vt.remoteDone = false;
    vt.pendingRemote = (async () => {
      const prepared = await vt.vault.prepare(true, 'pw-a2');
      await vt.vault.commit(prepared);
    })().then(() => { vt.remoteDone = true; }, () => { vt.remoteDone = true; });
    return true;
  })()`);
  await waitFor(() => evaluate('vt.vaultPostGateEntered()'), 'delayed saveVault held');
  await switchTo('account-b');
  const gPre = await readAccountState('account-b');
  if (!(gPre.uid === 'account-b' && gPre.version === 22 && gPre.status === 'locked')) {
    throw new Error('pre-release: account B remote not intact: ' + JSON.stringify({ uid: gPre.uid, status: gPre.status, version: gPre.version }));
  }
  await evaluate('__releaseVaultPostGate()');
  await waitFor(() => evaluate('vt.remoteDone === true'), 'delayed saveVault settled');
  await settle();
  const gState = await readAccountState('account-b');
  results.push({
    scenario: 'stale-remote-cross-account', liveUid: gState.uid,
    expectedVersion: 22, actualVersion: gState.version, expectedStatus: 'locked', actualStatus: gState.status,
    pass: gState.uid === 'account-b' && gState.version === 22 && gState.status === 'locked',
  });

  // ---- Case H: synchronous UID boundary, observed at a child layout effect ----
  await resetAccount('account-a');
  await evaluate('(async () => { const made = await vt.createVault("account-a", "pw-a"); await vt.vault.commit(made); return vt.vault.status; })()');
  await waitFor(() => evaluate("vt.vault.status === 'unlocked'"), 'A unlocked for boundary probe');
  await evaluate("(async () => { vt.layoutProbe = null; vt.keepProbe = []; vt.switchAccount('account-b'); return true; })()");
  await waitFor(() => evaluate('vt.layoutProbe !== null'), 'layout probe captured');
  await waitFor(() => evaluate("vt.keepProbe.some((entry) => entry.uid === 'account-b')"), 'boundary keep probe resolved');
  await waitFor(() => evaluate("vt.vault && vt.vault.uid === 'account-b' && vt.vault.status !== 'loading'"), 'B settled after probe');
  const hBoundary = await blob('({ probe: vt.layoutProbe, keep: vt.keepProbe.filter((entry) => entry.uid === "account-b") })');
  results.push({
    scenario: 'sync-uid-boundary-layout-effect',
    probeUid: hBoundary.probe.uid, probeStatus: hBoundary.probe.status, probePublicKey: hBoundary.probe.publicKeyPrefix,
    keepAtBoundary: hBoundary.keep.map((entry) => entry.kept),
    pass: hBoundary.probe.uid === 'account-b' && hBoundary.probe.status !== 'unlocked' && hBoundary.probe.publicKeyPrefix === null &&
      hBoundary.keep.length > 0 && hBoundary.keep.every((entry) => entry.kept === false),
  });

  // ---- Case I: a delayed openShare must not return a password after lock ----
  await resetAccount('account-a');
  await evaluate('(async () => { const made = await vt.createVault("account-a", "pw-share"); await vt.vault.commit(made); vt.share = await vt.sealToAccount(made.bundle.publicKey, "share-session", "account-a", "share-password"); return vt.vault.status; })()');
  await waitFor(() => evaluate("vt.vault.status === 'unlocked'"), 'A unlocked for share');
  await evaluate("(async () => { __armGate('ecdh'); vt.shareDone = false; vt.shareValue = 'pending'; vt.vault.openShare('share-session', vt.share).then((value) => { vt.shareDone = true; vt.shareValue = value; }, () => { vt.shareDone = true; vt.shareValue = 'error'; }); return true; })()");
  await waitFor(() => evaluate('vt.gateEntered()'), 'share decrypt held');
  await evaluate('vt.vault.lock()');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.shareDone === true'), 'share settled after lock');
  const iValue = await evaluate('vt.shareValue');
  results.push({ scenario: 'delayed-open-share-after-lock', expected: null, actual: iValue, pass: iValue === null });

  // ---- Case I2: a delayed openShare must not return a password after an account switch ----
  await resetAccount('account-a');
  await evaluate('(async () => { const made = await vt.createVault("account-a", "pw-share"); await vt.vault.commit(made); vt.share = await vt.sealToAccount(made.bundle.publicKey, "share-session", "account-a", "share-password"); return vt.vault.status; })()');
  await waitFor(() => evaluate("vt.vault.status === 'unlocked'"), 'A unlocked for share switch');
  await evaluate("(async () => { __armGate('ecdh'); vt.shareDone = false; vt.shareValue = 'pending'; vt.vault.openShare('share-session', vt.share).then((value) => { vt.shareDone = true; vt.shareValue = value; }, () => { vt.shareDone = true; vt.shareValue = 'error'; }); return true; })()");
  await waitFor(() => evaluate('vt.gateEntered()'), 'share decrypt held for switch');
  await switchTo('account-b');
  await evaluate('__releaseGate()');
  await waitFor(() => evaluate('vt.shareDone === true'), 'share settled after switch');
  const i2Value = await evaluate('vt.shareValue');
  results.push({ scenario: 'delayed-open-share-cross-account', expected: null, actual: i2Value, pass: i2Value === null });

  // ---- Case J: provider disposal invalidates a pending save ----
  await resetAccount('account-a');
  await evaluate('(async () => { const made = await vt.createVault("account-a", "pw-canary"); await vt.vault.commit(made); await vt.vault.lock(); __armSaveGate(); vt.unlockDone = false; vt.pendingUnlock = vt.vault.unlockWithPassword("pw-canary").then(() => { vt.unlockDone = true; }, () => { vt.unlockDone = true; }); return true; })()');
  await waitFor(() => evaluate('vt.saveGateEntered()'), 'save held before disposal');
  await evaluate('vt.hide()');
  await evaluate('__releaseSaveGate()');
  await waitFor(() => evaluate('vt.unlockDone === true'), 'pending unlock settled after disposal');
  await settle();
  const jPendingRemembered = await evaluate("(async () => (await vt.loadLocalVault('account-a')) !== null)()");
  await evaluate('vt.remount()');
  await waitFor(() => evaluate("vt.vault && vt.vault.uid === 'account-a' && vt.vault.status !== 'loading'"), 'remount after disposal');
  if (await evaluate("vt.vault.status === 'locked'")) {
    await evaluate("(async () => { await vt.vault.unlockWithPassword('pw-canary'); return true; })()");
  }
  await settle();
  const jLegitRemembered = await evaluate("(async () => (await vt.loadLocalVault('account-a')) !== null)()");
  results.push({
    scenario: 'unmount-invalidates-pending-save',
    expectedPendingRemembered: false, actualPendingRemembered: jPendingRemembered,
    expectedLegitRemembered: true, actualLegitRemembered: jLegitRemembered,
    pass: jPendingRemembered === false && jLegitRemembered === true,
  });

  // ---- Case K: clear held in queue across account switch must still delete ----
  await resetAccount('account-a');
  await evaluate('(async () => { const made = await vt.createVault("account-a", "pw-clear"); await vt.vault.commit(made); return vt.vault.status; })()');
  await waitFor(() => evaluate("vt.vault.status === 'unlocked'"), 'A unlocked for clear race');
  await evaluate('(async () => { __armClearGate(); vt.lockDone = false; vt.vault.lock().then(() => { vt.lockDone = true; }, () => { vt.lockDone = true; }); return true; })()');
  await waitFor(() => evaluate('vt.clearGateEntered()'), 'clear held inside queue');
  await switchTo('account-b');
  await evaluate('__releaseClearGate()');
  await waitFor(() => evaluate('vt.lockDone === true'), 'clear settled after release');
  await settle();
  await evaluate(`(async () => {
    vt.switchAccount('account-a');
    vt.remount();
    for (let i = 0; i < 300 && (!vt.vault || vt.vault.status === 'loading'); i++) await new Promise((r) => setTimeout(r, 10));
    return true;
  })()`);
  await waitFor(() => evaluate("vt.vault && vt.vault.uid === 'account-a' && vt.vault.status !== 'loading'"), 'A remounted after clear race');
  const kStatus = await status();
  const kRemembered = await evaluate("(async () => (await vt.loadLocalVault('account-a')) !== null)()");
  results.push({
    scenario: 'clear-held-across-account-switch',
    expectedStatus: 'locked', actualStatus: kStatus,
    expectedRemembered: false, actualRemembered: kRemembered,
    pass: kStatus === 'locked' && kRemembered === false,
  });

  const pageError = await evaluate('vt.error');
  if (pageError) throw new Error('Page error: ' + pageError);

  for (const result of results) console.log(JSON.stringify(result));

  if (!mutation) {
    const ok = results.every((result) => result.pass);
    console.log(JSON.stringify({ test: 'vault-lifecycle', mode: 'baseline', sourceSha256: sourceHash, ok, results }));
    process.exitCode = ok ? 0 : 1;
  } else {
    const TARGETS = {
      'fingerprint-guard': 'fingerprint-after-lock',
      precapture: 'password-before-guard',
      'storage-admission': 'stale-save-same-owner-new-key',
      'sync-guard': 'sync-uid-boundary-layout-effect',
      'unmount-invalidate': 'unmount-invalidates-pending-save',
    };
    const targeted = TARGETS[mutation];
    const observed = results.find((result) => result.scenario === targeted);
    const mutationVisible = observed.pass === false;
    console.log(JSON.stringify({ test: 'vault-lifecycle', mode: 'mutation', mutation, sourceSha256: sourceHash, targeted, mutationVisible, ok: mutationVisible }));
    process.exitCode = mutationVisible ? 0 : 1;
  }
} catch (error) {
  console.error('FAIL vault-lifecycle: ' + (error && error.message ? error.message : error));
  process.exitCode = 1;
} finally {
  await transport?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
