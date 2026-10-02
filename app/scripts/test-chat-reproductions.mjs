// One unchanged fixture against either checkout. Every case gets a new browser
// so main's parser hang cannot prevent subsequent cases from being measured.
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { launchChromeTransport } from '../../scripts/lib/browser-transport.mjs';

const ownRoot = fileURLToPath(new URL('../..', import.meta.url));
const root = resolve(process.argv[2] || ownRoot);
const reportPath = process.argv[3] || join(tmpdir(), 'chat-reproductions.json');
const source = await readFile(new URL('./fixtures/chat-reproductions.ts', import.meta.url), 'utf8');
const bundle = await build({
  stdin: {contents: source, loader: 'ts', resolveDir: join(root, 'app/scripts/fixtures'), sourcefile: 'chat-reproductions.ts'},
  bundle: true, platform: 'browser', format: 'iife', write: false, outdir: '/fixture', external: ['/fonts/*'],
});
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).contents;
// ResizeObserver's deferred-delivery warning is not a thrown script exception.
// Retain it in the report separately; never let it overwrite an assertion result.
const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="fixture" style="height:700px;position:relative"></div><script>window.reproductionWarnings=[];window.reproductionErrors=[];addEventListener("error",e=>{if(e.message==="ResizeObserver loop completed with undelivered notifications."){reproductionWarnings.push(e.message);return;}reproductionErrors.push(e.message);});addEventListener("unhandledrejection",e=>reproductionErrors.push(String(e.reason)));</script><script src="/fixture.js"></script>';
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(js); }
  else if (path === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
  else if (path.startsWith('/fonts/') && !path.includes('..')) {
    try { res.end(await readFile(join(root, 'public', path))); } catch { res.writeHead(404).end(); }
  } else { res.setHeader('Content-Type', 'text/html'); res.end(html); }
});
const names = (process.env.CHAT_REPRO_CASES || 'raw_code,rich_metadata,rich_revision,standalone_table,padded_table,fenced_stream,blue_notice,cache_arrival,recorded_frames,recorded_bytes,orphan_pipe').split(',');
const results = [];
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const width of [1280, 390]) for (const name of names) {
    const profile = await mkdtemp(join(tmpdir(), 'shell-chat-proof-'));
    let browser;
    let result;
    try {
      browser = await launchChromeTransport({profile});
      await browser.setViewport({width, height: 844, dpr: width === 390 ? 3 : 1, mobile: width === 390});
      await browser.navigate(`http://127.0.0.1:${server.address().port}/?case=${name}`);
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        result = await browser.evaluate('window.reproduction && ({...window.reproduction, ...(reproductionErrors.length ? {status: "error", error: reproductionErrors.join("; ")} : {}), warnings: window.reproductionWarnings})');
        if (result && result.status !== 'running') break;
        await delay(50);
      }
      if (!result || result.status === 'running') result = {name, status: 'timeout'};
    } catch (error) { result = {name, status: 'error', error: error.message}; }
    finally {
      await browser?.close();
      await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    }
    results.push({width, ...result});
    console.log(`${width} ${name}: ${result.status}${result.error ? ' — ' + result.error : ''}`);
    await writeFile(reportPath, JSON.stringify({root, results}, null, 2));
  }
} finally { await new Promise(resolve => server.close(resolve)); }
if (results.some(result => result.status !== 'pass')) process.exitCode = 1;
