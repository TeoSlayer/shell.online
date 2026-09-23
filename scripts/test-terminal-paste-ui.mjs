// Actual xterm and Refstream paste paths, synthetic clipboard/permission state.
// No relay, real clipboard, account, analytics collection or user terminal.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchChromeTransport, launchSafariTransport } from './lib/browser-transport.mjs';

const profile = await mkdtemp(join(tmpdir(), 'shell-paste-test-'));
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [{ name: 'isolated-paste-fixture', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/qa-paste')) return next();
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>');
    });
  } }],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  browser = process.env.SHELL_BROWSER === 'safari' ? await launchSafariTransport() : await launchChromeTransport({ profile });
  await browser.navigate(`http://127.0.0.1:${server.httpServer.address().port}/qa-paste`);
  for (const renderer of ['xterm', 'refstream']) {
    for (const theme of ['light', 'dark']) {
      const viewport = await browser.setViewport({ width: 390, height: 650, mobile: true, dpr: 2 });
      const result = await browser.call(async (renderer, theme) => {
        const { createTerminal } = await import('/web/terminal-renderer.ts');
        const { mountTerminalPaste } = await import('/web/terminal-paste.ts');
        await import('/web/terminal-paste.css');
        await import('/web/session-theme.css');
        await import('/node_modules/@xterm/xterm/css/xterm.css');
        await import('/web/vendor/refstream/v0.1.0-alpha.5/refstream.css');
        document.body.replaceChildren();
        document.body.className = `session-page theme-${theme}`;
        const toolbar = document.createElement('div');
        const mount = document.createElement('div');
        document.body.append(toolbar, mount);
        const term = createTerminal(renderer, { cols: 40, rows: 8 });
        term.open(mount);
        const sent = [];
        term.onData(text => sent.push(text));
        await new Promise(resolve => term.write('\x1b[?2004h', resolve));
        let allowed = true, reads = 0, release;
        let mode = 'ok';
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText() {
          reads++;
          if (mode === 'denied') return Promise.reject(new Error('denied'));
          if (mode === 'pending') return new Promise(resolve => { release = resolve; });
          return Promise.resolve('echo first\necho second');
        } } });
        const ui = mountTerminalPaste({ toolbar, overlay: document.body, canPaste: () => allowed, paste: text => term.paste(text) });
        const button = toolbar.querySelector('button');
        const dialog = document.querySelector('.terminal-paste-dialog');
        const field = dialog.querySelector('textarea');
        const form = dialog.querySelector('form');
        const errors = [];
        const check = (ok, name) => { if (!ok) errors.push(name); };
        const tick = () => new Promise(resolve => setTimeout(resolve, 20));
        button.click(); await tick();
        check(field.value === 'echo first\necho second' && sent.length === 0, 'preview before sending');
        const rect = dialog.getBoundingClientRect();
        check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, 'dialog fits');
        check(parseFloat(getComputedStyle(field).fontSize) >= 16, 'native input avoids mobile zoom');
        check(getComputedStyle(dialog).backgroundColor === (theme === 'dark' ? 'rgb(29, 32, 27)' : 'rgb(252, 251, 247)'), 'theme');
        form.requestSubmit(); await tick();
        check(sent.length === 1 && sent[0] === '\x1b[200~echo first\recho second\x1b[201~', 'renderer bracketed paste; no added Enter');
        check(!dialog.open && field.value === '', 'plaintext cleared on send');
        mode = 'denied'; button.click(); await tick();
        check(dialog.textContent.includes('Touch and hold'), 'denied clipboard fallback');
        field.value = 'native mobile paste'; field.dispatchEvent(new Event('input'));
        form.requestSubmit(); await tick();
        check(sent.length === 2 && sent[1].includes('native mobile paste'), 'manual paste sends');
        mode = 'pending'; button.click(); ui.close(); release('late secret'); await tick();
        check(field.value === '' && !dialog.open, 'closed dialog ignores pending clipboard');
        button.click(); field.value = 'edited'; field.dispatchEvent(new Event('input')); release('overwrite'); await tick();
        check(field.value === 'edited', 'clipboard cannot overwrite manual edit'); ui.close();
        const before = reads; allowed = false; button.click(); await tick();
        check(reads === before, 'read-only does not read clipboard');
        field.value = 'blocked'; form.requestSubmit();
        check(sent.length === 2 && dialog.open, 'read-only cannot send'); ui.close();
        allowed = true; button.click(); allowed = false; release('revoked'); await tick();
        check(field.value === '', 'revocation during clipboard read');
        field.value = 'not allowed'; form.requestSubmit();
        check(sent.length === 2, 'revocation rechecked at Insert'); ui.close();
        allowed = true; mode = 'denied'; button.click(); await tick();
        field.value = '🌳'.repeat(4000); form.requestSubmit();
        check(sent.length === 2 && dialog.textContent.includes('smaller selection'), 'UTF-8 byte limit');
        ui.dispose();
        check(!document.querySelector('.terminal-paste-dialog') && !toolbar.children.length, 'dispose removes UI');
        // Model iOS's keyboard shrinking/panning the visual viewport while the
        // layout viewport remains tall. This is synthetic, not an iPhone run.
        const realViewport = window.visualViewport;
        const keyboard = new EventTarget();
        keyboard.height = 300; keyboard.offsetTop = 60;
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: keyboard });
        const smallUi = mountTerminalPaste({ toolbar, overlay: document.body, canPaste: () => true, paste: () => {} });
        toolbar.querySelector('button').click();
        const small = document.querySelector('.terminal-paste-dialog');
        let bounds = small.getBoundingClientRect();
        check(bounds.top >= 60 && bounds.bottom <= 360 && small.scrollHeight > small.clientHeight, 'keyboard dialog remains visible and scrollable');
        keyboard.offsetTop = 90; keyboard.dispatchEvent(new Event('scroll'));
        bounds = small.getBoundingClientRect();
        check(bounds.top >= 90 && bounds.bottom <= 390, 'keyboard pan remains visible');
        small.scrollTop = small.scrollHeight;
        const submit = small.querySelector('button[type=submit]').getBoundingClientRect();
        check(submit.bottom <= bounds.bottom && submit.top >= bounds.top, 'Insert reachable after scrolling');
        smallUi.dispose();
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: realViewport });
        term.dispose();
        return errors;
      }, renderer, theme);
      assert.deepEqual(result, [], `${renderer}/${theme}`);
      console.log(`PASS ${renderer}/${theme} paste: preview, framing, fallback, cancellation, access, size, cleanup; viewport ${JSON.stringify(viewport)}`);
    }
  }
} finally {
  await browser?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
