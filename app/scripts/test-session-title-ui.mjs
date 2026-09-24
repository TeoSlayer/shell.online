// Local browser canary for the compact session title/summary layout.
// Synthetic data only; no login, relay, or deploy. Carries its own copy of the
// CDP + Vite transport test-session-automation-ui.mjs also uses. Proves, in a
// real browser at desktop and narrow widths, that a long command renders as a
// short title with
// the raw command behind a disclosure, a truthful empty summary, and no
// horizontal overflow.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { chromeStartup } from '../../scripts/lib/browser-transport.mjs';

const profile = await mkdtemp(join(tmpdir(), 'shell-title-ui-'));
const TEST_ENTRY_ID = 'virtual:session-title-test-entry';
const testEntryPlugin = {
  name: 'session-title-test-entry',
  resolveId(id) {
    return id === TEST_ENTRY_ID ? `\0${TEST_ENTRY_ID}.js` : null;
  },
  load(id) {
    if (id !== `\0${TEST_ENTRY_ID}.js`) return null;
    // The real helpers and the real stylesheets, so the layout measured here is
    // the one the page ships.
    return `
      import * as ReactModule from 'react';
      import { createRoot } from 'react-dom/client';
      import { sessionTitle, sessionSummary } from '/src/lib/session-title.ts';
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
      export const React = ReactModule.default ?? ReactModule;
      export { createRoot, sessionTitle, sessionSummary };
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
    const name = value.exceptionDetails.exception?.className ?? 'unknown';
    throw new Error(`Browser assertion setup failed (${name}, line ${value.exceptionDetails.lineNumber})`);
  }
  return value.result.value;
}
// The exact shape of the user's complaint: a long agent command, no name, no
// generated summary.
const SYNTHETIC_COMMAND =
  '/opt/homebrew/bin/opencode -s ses_0123abc -m calin/Qwen3.8-27B --print "a very long quoted argument with spaces" --extra-flag value';

try {
  await server.listen();
  const port = server.httpServer.address().port;
  chrome = spawn(process.env.SHELL_CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
    /* Piped so the port can be read from what Chrome says; see chromeStartup. */
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debuggingPort = await chromeStartup(chrome, profile).port();
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

  // Mount a harness that renders the real detail layout (same markup and classes
  // as the Session route) with the real title/summary helpers.
  await evaluate(`(async () => {
    const {React, createRoot, sessionTitle, sessionSummary} = await import('/@id/__x00__${TEST_ENTRY_ID}.js');
    const session = {
      id: 'ses_0123abc',
      command: ${JSON.stringify(SYNTHETIC_COMMAND)},
      name: undefined,
      description: undefined,
    };
    const container = document.createElement('div');
    container.id = 'title-harness';
    container.style.cssText = 'width:100%;';
    document.body.append(container);
    const root = createRoot(container);
    root.render(React.createElement('div', { className: 'detail' },
      React.createElement('section', { className: 'detail-main' },
        React.createElement('div', { className: 'detail-title' },
          React.createElement('h2', { className: 'detail-name', title: session.name?.trim() || session.command },
            sessionTitle(session))),
        React.createElement('p', { className: 'detail-summary' },
          sessionSummary(session) ?? 'No description.'),
        React.createElement('div', { className: 'detail-head' },
          React.createElement('span', { className: 'detail-status is-live' }, 'Running'),
          React.createElement('details', { className: 'detail-command-details' },
            React.createElement('summary', null, 'Command'),
            React.createElement('code', { className: 'detail-command-full' }, session.command)))),
      React.createElement('aside', { className: 'detail-side' },
        React.createElement('h2', { className: 'detail-heading' }, 'Details'))));
  })()`);

  const name = `document.querySelector('#title-harness .detail-name')`;
  const summary = `document.querySelector('#title-harness .detail-summary')`;
  const details = `document.querySelector('#title-harness .detail-command-details')`;
  const full = `document.querySelector('#title-harness .detail-command-full')`;

  await waitFor(() => evaluate(`${name} && ${name}.textContent.trim() !== ''`), 'title rendered');

  // The title is the short derived label, not the giant command.
  assert.equal(await evaluate(`${name}.textContent.trim()`), 'opencode');
  assert.ok(!(await evaluate(`${name}.textContent`)).includes('ses_0123abc'), 'title must not carry the command');
  // No generated summary exists, so the honest empty state shows.
  assert.equal(await evaluate(`${summary}.textContent.trim()`), 'No description.');
  // The raw command is behind a closed disclosure, not always visible. Closed,
  // the disclosure is just its summary line.
  assert.equal(await evaluate(`${details}.open`), false);
  const closedHeight = await evaluate(`${details}.getBoundingClientRect().height`);
  assert.ok(closedHeight < 40, `closed disclosure is just the summary line (got ${closedHeight}px)`);

  // Desktop: no horizontal overflow.
  await request('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await delay(120);
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'no overflow at desktop width');

  // Narrow: still no horizontal overflow, title and command stay contained.
  await request('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(120);
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'no overflow at narrow width');
  assert.ok(await evaluate(`${name}.scrollWidth <= ${name}.clientWidth + 1 || ${name}.offsetWidth <= 390`), 'title contained at narrow width');

  // Expanding the disclosure reveals the full command, and it wraps rather than
  // widening the page.
  await evaluate(`${details}.open = true; void 0;`);
  await waitFor(() => evaluate(`${details}.getBoundingClientRect().height > 40`), 'command revealed');
  assert.ok(await evaluate(`${full}.textContent.includes('Qwen3.8-27B')`), 'full command present when open');
  assert.ok(await evaluate(`${full}.scrollWidth <= ${full}.clientWidth + 1`), 'command wraps, does not overflow');
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'no overflow with command open');

  console.log('PASS title/summary browser: short title, empty summary, command behind disclosure, no overflow desktop+narrow');
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
