// Real DOM + real xterm parser, exercised with synthetic session bytes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const profile = await mkdtemp(join(tmpdir(), 'shell-chat-regression-'));
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent',
});
let transport;
try {
  await server.listen();
  transport = await launchChromeTransport({ profile });
  for (const width of [1280, 390]) {
    await transport.setViewport({width, height: 844, dpr: width === 390 ? 3 : 1, mobile: width === 390});
    await transport.navigate(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/chat-regression.html`);
    const deadline = Date.now() + 20000;
    let started = false;
    let status = '';
    while (Date.now() < deadline) {
      if (!started) started = await transport.evaluate(`(() => { const button = document.querySelector('#run'); if (!button?.onclick) return false; button.click(); return true; })()`);
      status = await transport.evaluate(`document.querySelector('#result')?.textContent ?? ''`);
      if (/^(PASS|FAIL):/.test(status)) break;
      await delay(50);
    }
    assert.match(status, /^PASS:/, `${width}px: ${status}`);
    console.log(`${width}px ${status}`);
  }
} finally {
  await transport?.close();
  await server.close();
  await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
}
