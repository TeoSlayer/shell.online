// Local browser interaction canary. Uses synthetic props only; no login, relay, or deploy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

const profile = await mkdtemp(join(tmpdir(), 'shell-automation-ui-'));
const TEST_ENTRY_ID = 'virtual:session-automation-test-entry';
const testEntryPlugin = {
  name: 'session-automation-test-entry',
  resolveId(id) {
    return id === TEST_ENTRY_ID ? `\0${TEST_ENTRY_ID}.js` : null;
  },
  load(id) {
    if (id !== `\0${TEST_ENTRY_ID}.js`) return null;
    // Bare imports are rewritten by Vite to the same optimized-dep URLs the
    // app uses, so React and react-dom share one module instance.
    return `
      import * as ReactModule from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionAutomation } from '/src/components/SessionAutomation.tsx';
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, SessionAutomation };
    `;
  },
};
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [testEntryPlugin],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent',
});
let chrome, socket;
const pending = new Map();
let nextId = 0;
const waitFor = async (check, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
};
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) {
    // Synthetic local test only. Never print arbitrary page exception strings.
    const name = value.exceptionDetails.exception?.className ?? 'unknown';
    throw new Error(`Browser assertion setup failed (${name}, line ${value.exceptionDetails.lineNumber})`);
  }
  return value.result.value;
}
try {
  await server.listen();
  const port = server.httpServer.address().port;
  chrome = spawn(process.env.SHELL_CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError;
  chrome.on('error', (error) => { launchError = error; });
  let debuggingPort;
  await waitFor(async () => {
    if (launchError) throw new Error('Chrome could not start');
    try { debuggingPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return debuggingPort > 0; }
    catch { return false; }
  }, 'Chrome startup');
  const pages = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const value = JSON.parse(data);
    const handler = pending.get(value.id);
    if (!handler) return;
    pending.delete(value.id);
    if (value.error) handler.reject(new Error('CDP command failed'));
    else handler.resolve(value.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await request('Page.navigate', { url: `http://127.0.0.1:${port}/qa.html` });
  await waitFor(() => evaluate(`location.origin === 'http://127.0.0.1:${port}' && document.readyState === 'complete'`), 'page load');
  await evaluate(`(async () => {
    const {React, createRoot, SessionAutomation} = await import('/@id/__x00__${TEST_ENTRY_ID}.js');
    const container = document.createElement('div'); container.id = 'automation-test'; document.body.append(container);
    const test = globalThis.automationTest = {calls: [], fail: false, hold: false, release: null};
    function Harness({uid}) {
      const [session, setSession] = React.useState({id: 'synthetic-session', ownerUid: 'owner'});
      return React.createElement(SessionAutomation, {session, you: {uid, role: 'admin'}, onChange: async (changes) => {
        test.calls.push(changes);
        if (test.hold) await new Promise(resolve => {test.release = resolve;});
        if (test.fail) throw new Error('SECRET_SYNTHETIC_CREDENTIAL');
        setSession(current => ({...current, ...changes}));
      }});
    }
    const root = createRoot(container);
    test.render = uid => root.render(React.createElement(Harness, {key: uid, uid}));
    test.render('owner');
  })()`);
  const boxes = `document.querySelectorAll('#automation-test input[type="checkbox"]')`;
  await waitFor(() => evaluate(`${boxes}.length === 3`), 'owner controls');
  assert.deepEqual(await evaluate(`Array.from(${boxes}, el => el.checked)`), [false, false, false]);
  await evaluate(`automationTest.hold = true; ${boxes}[0].click()`);
  await waitFor(() => evaluate('automationTest.calls.length === 1'), 'save started');
  assert.equal(await evaluate(`${boxes}[1].matches(':disabled')`), true);
  await evaluate('automationTest.hold = false; automationTest.release()');
  await waitFor(() => evaluate(`${boxes}[0].checked && !${boxes}[0].matches(':disabled')`), 'save finished');
  assert.deepEqual(await evaluate('automationTest.calls[0]'), { mcpTeamAccess: true });
  assert.deepEqual(await evaluate(`Array.from(${boxes}, el => el.checked)`), [true, false, false]);
  await evaluate(`automationTest.fail = true; ${boxes}[0].click()`);
  await waitFor(() => evaluate(`!!document.querySelector('#automation-test [role="alert"]')`), 'safe failure state');
  assert.equal(await evaluate(`${boxes}[0].checked`), true);
  assert.equal(await evaluate(`document.querySelector('#automation-test').textContent.includes('SECRET_SYNTHETIC_CREDENTIAL')`), false);
  await evaluate(`automationTest.fail = false; ${boxes}[0].click()`);
  await waitFor(() => evaluate(`!${boxes}[0].checked && !${boxes}[0].matches(':disabled')`), 'owner disables');
  await evaluate(`automationTest.render('different-admin')`);
  await waitFor(() => evaluate(`${boxes}.length === 0`), 'non-owner controls hidden');
  console.log('PASS automation browser: default-off, owner enable/disable, independent consent, pending lock, safe failure, non-owner hidden');
} finally {
  for (const handler of pending.values()) handler.reject(new Error('Browser canary stopped'));
  pending.clear();
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await exited; }
  }
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
