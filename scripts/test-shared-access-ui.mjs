// Actual viewer and encryption form, with a synthetic relay. No real session.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChromeTransport } from './lib/browser-transport.mjs';

const profile = await mkdtemp(join(tmpdir(), 'shell-access-test-'));
const shots = await mkdtemp(join(tmpdir(), 'shell-access-preview-'));
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error',
  plugins: [{ name: 'synthetic-access-relay', transformIndexHtml() { return [{ tag: 'script', injectTo: 'head-prepend', children: `
    window.testSockets = [];
    window.WebSocket = class extends EventTarget {
      static OPEN = 1; readyState = 1;
      constructor(url) { super(); if (String(url).includes('/api/sessions/')) testSockets.push(this); }
      send() {} close() { this.readyState = 3; }
      status(status) { this.dispatchEvent(new MessageEvent('message', {data:JSON.stringify({type:'status',status,encrypted:true,readOnly:false})})); }
    };
  ` }]; } }],
});
let browser;
async function until(expression) {
  for (let i=0; i<300; i++) { if (await browser.evaluate(expression)) return; await delay(50); }
  throw new Error(`Timed out: ${expression}`);
}
try {
  await server.listen(); browser = await launchChromeTransport({ profile });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/s/${'a'.repeat(32)}#salt=AAAAAAAAAAAAAAAAAAAAAA`;
  for (const width of [320, 390, 768, 1440]) {
    await browser.navigate('about:blank');
    await until('location.href === "about:blank" && !document.querySelector("#encryption-gate")');
    await browser.setViewport({ width, height: 850, dpr: 1, mobile: width < 600 });
    await browser.navigate(url);
    await until('!!document.querySelector("#encryption-gate:not([hidden])") && document.fonts.status === "loaded"');
    assert.equal(await browser.evaluate('testSockets.length'), 0, 'password required before relay connection');
    assert.equal(await browser.evaluate('document.querySelector("#encryption-form button").textContent'), 'Open terminal');
    assert.equal(await browser.evaluate('document.querySelector("#session-status b").textContent'), 'Password needed');
    await browser.evaluate('document.querySelector(".encryption-help summary").click()');
    assert.equal(await browser.evaluate('document.querySelector(".encryption-panel").textContent.includes("shell password <ID>")'), true);
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector(".encryption-panel").scrollWidth <= document.querySelector(".encryption-panel").clientWidth + 1'), true, `${width}: recovery fits`);
    await writeFile(join(shots, `shared-access-${width}.png`), Buffer.from(await browser.screenshot(), 'base64'));
    await browser.evaluate('document.querySelector("#encryption-password").value="synthetic-pass"; document.querySelector("#encryption-form").requestSubmit()');
    await until('testSockets.length === 1');
    await browser.evaluate('testSockets[0].status("connected")');
    await until('document.querySelector("#session-status b").textContent === "Connected"');
    for (const [state,label] of [['waiting','Waiting for host'],['exited','Session ended'],['missing','Link unavailable']]) {
      await browser.call((state) => testSockets[0].status(state), state);
      await until(`document.querySelector("#session-status b").textContent === ${JSON.stringify(label)}`);
    }
    assert.equal(await browser.evaluate('document.querySelector("#issue-open").href'), 'https://app.shell.online/feedback?from=terminal');
    console.log(`PASS ${width}: password recovery, real key derivation, connection status, report destination`);
  }
  console.log(`Preview screenshots: ${shots}`);
} finally { await browser?.close(); await server.close(); await rm(profile, { recursive: true, force: true }); }
