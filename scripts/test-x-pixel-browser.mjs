// Real vendor script, isolated Chrome profile, all collection intercepted.
// X_PIXEL_LIVE=1 uses deployed first-party assets. No synthetic events are sent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChromeTransport } from './lib/browser-transport.mjs';

const live = process.env.X_PIXEL_LIVE === '1';
const root = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(join(tmpdir(), 'shell-x-pixel-'));
const roots = { 'shell.online': join(root, 'dist'), 'app.shell.online': join(root, 'app/dist') };
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2' };
const marker = 'SYNTHETIC_PRIVATE_X_MARKER';
const email = 'synthetic-private-x-marker@example.test';
const clickId = 'synthetic_ad_click_123';
const collectors = new Set(['analytics.twitter.com', 't.co', 'ads-twitter.com', 'ads-api.twitter.com']);
const captures = [], scripts = [], own = [], google = [], product = [], errors = [], blocked = [];
let browser, socket, sequence = 0, phase = 'startup';
const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout')); }, 15000);
  pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
  socket.send(JSON.stringify({ id, method, params }));
});
async function wait(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await delay(80); }
  throw Error(`Timeout: ${label}`);
}
async function handle({ requestId, request }) {
  const url = new URL(request.url);
  const reply = (body = '', type = 'text/plain', status = 200) => cdp('Fetch.fulfillRequest', {
    requestId, responseCode: status, responseHeaders: [{ name:'Content-Type', value:type }, { name:'Access-Control-Allow-Origin', value:'*' }, { name:'Access-Control-Allow-Headers', value:'content-type' }, { name:'Referrer-Policy', value:'no-referrer' }],
    body: Buffer.from(body).toString('base64'),
  });
  if (url.hostname === 'static.ads-twitter.com' && url.pathname === '/uwt.js') {
    scripts.push({ phase, referrer: request.headers.Referer ?? '' });
    if (phase === 'blocked-tag') return cdp('Fetch.failRequest', { requestId, errorReason:'BlockedByClient' });
    // Seed sensitive DOM/dataLayer fixtures BEFORE the real vendor code runs.
    await browser.call(() => {
      const form = document.createElement('form');
      form.innerHTML = '<input name="email" type="email" value="synthetic-private-x-marker@example.test"><input name="password" value="SYNTHETIC_PRIVATE_X_MARKER"><button type="button" id="pixel-secret-button">SYNTHETIC_PRIVATE_X_MARKER</button>';
      document.body.appendChild(form);
      window.dataLayer ??= [];
      window.dataLayer.push({ event:'purchase', email:'synthetic-private-x-marker@example.test', value:42 });
    });
    return cdp('Fetch.continueRequest', { requestId });
  }
  if (collectors.has(url.hostname)) {
    captures.push({ phase, host:url.hostname, url:request.url, body:request.postData ?? '', headers:request.headers });
    return reply('', 'text/plain', 204);
  }
  if (url.hostname === 'www.googletagmanager.com' && url.pathname === '/gtag/js') return cdp('Fetch.continueRequest', { requestId });
  if (['www.google-analytics.com', 'region1.google-analytics.com', 'analytics.google.com'].includes(url.hostname)) {
    google.push({ phase, url:request.url, body:request.postData ?? '' }); return reply('', 'text/plain', 204);
  }
  if (url.hostname === 'us.i.posthog.com') {
    if (request.method === 'POST') product.push({ phase, payload:JSON.parse(request.postData) });
    return reply('1');
  }
  if (url.hostname === 'shell.online' && url.pathname === '/api/events') {
    own.push({ phase, ...JSON.parse(request.postData ?? '{}') }); return reply('', 'text/plain', 204);
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return reply('{}', 'application/json', 404);
  const assets = roots[url.hostname];
  if (assets) {
    if (live) return cdp('Fetch.continueRequest', { requestId, headers:[...Object.entries(request.headers).map(([name,value]) => ({ name,value:String(value) })), { name:'Purpose',value:'prefetch' }] });
    let path = resolve(assets, '.' + decodeURIComponent(url.pathname));
    assert(path === assets || path.startsWith(assets + sep));
    if (url.pathname === '/' || url.pathname.startsWith('/s/') || (url.hostname === 'app.shell.online' && !url.pathname.startsWith('/assets/'))) path = join(assets, 'index.html');
    else if (url.pathname.endsWith('/')) path = join(path, 'index.html');
    try { return reply(await readFile(path), mime[extname(path)] ?? 'application/octet-stream'); }
    catch { return reply('not found', 'text/plain', 404); }
  }
  blocked.push({ phase, host:url.hostname });
  return cdp('Fetch.failRequest', { requestId, errorReason:'BlockedByClient' });
}
async function blank() { await browser.navigate('about:blank'); await delay(250); }
try {
  browser = await launchChromeTransport({ profile });
  const port = browser.debuggingPort;
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(Error('CDP error')) : p.resolve(m.result); }
    if (m.method === 'Fetch.requestPaused') void handle(m.params).catch(e => errors.push(e.message));
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await cdp('Page.enable'); await cdp('Network.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled:true });
  await cdp('Network.setBlockedURLs', { urls:['ws://*', 'wss://*'] });
  await cdp('Fetch.enable', { patterns:[{ urlPattern:'*', requestStage:'Request' }] });
  phase = 'landing';
  await cdp('Page.navigate', { url:`https://shell.online/?utm_source=x&utm_medium=cpc&utm_campaign=${marker}&twclid=${clickId}`, referrer:`https://example.test/${marker}` });
  await wait(() => captures.some(c => c.phase === phase && c.host === 'analytics.twitter.com'), 'X base visit');
  await wait(() => google.some(c => c.phase === phase), 'Google base visit');
  await browser.call(() => {
    document.querySelector('#pixel-secret-button').click();
    window.dataLayer.push({ event:'sign_up', email:'synthetic-private-x-marker@example.test' });
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async () => {} } });
    document.querySelector('[data-copy=install]').click();
    document.querySelector('[data-cta=start_hero]').click();
  });
  await delay(11500); // Exceed vendor dwell threshold; it must remain disabled.
  assert.equal(await browser.evaluate('document.visibilityState === "visible" && document.hasFocus()'),true,'foreground engagement fixture');
  await blank(); await delay(1000);
  const landing = captures.filter(c => c.phase === 'landing');
  assert.equal(landing.filter(c => c.host === 'analytics.twitter.com').length, 1, 'one base event, no automatic conversions');
  assert(landing.filter(c => c.host === 't.co').length <= 1, 'no duplicate cookie-sync base request');
  for (const c of landing) {
    const params = new URLSearchParams(new URL(c.url).search);
    for (const [k,v] of new URLSearchParams(c.body)) params.set(k,v);
    assert.equal(params.get('txn_id'), 'rfilf');
    assert.equal(params.get('twclid'), clickId);
    assert.equal(params.get('tw_document_href'), 'https://shell.online/');
    assert([null, '', 'https://shell.online/'].includes(params.get('tw_document_referrer')));
    assert(!params.get('events')); assert(!params.get('email_address')); assert(!params.get('phone_number'));
    assert(!c.headers.Referer);
  }
  const encoded = JSON.stringify(captures);
  for (const secret of [marker, email, createHash('sha256').update(email).digest('hex')]) assert(!encoded.includes(secret), 'sensitive fixture leaked');
  assert.deepEqual(scripts.map(s => s.referrer), ['']);
  for (const event of ['page_loaded', 'copy', 'cta_click']) assert.equal(own.filter(e => e.phase === 'landing' && e.event === event).length, 1);
  for (const event of ['$pageview', 'command_copy', 'landing_cta']) assert.equal(product.filter(e => e.phase === 'landing' && e.payload.event === event).length, 1, event);
  assert.equal(product.filter(e=>e.phase==='landing'&&e.payload.event==='page_engaged').length,1,'one genuine foreground reading milestone');
  assert(product.some(e=>e.phase==='landing'&&e.payload.event==='$pageleave'&&e.payload.properties.active_ms>=10000),'PostHog foreground duration');
  const ga = google.filter(c => c.phase === 'landing').flatMap(c => (c.body ? c.body.split(/\r?\n/) : ['']).map(line => ({ ...Object.fromEntries(new URL(c.url).searchParams), ...Object.fromEntries(new URLSearchParams(line)) })));
  for (const event of ['page_view', 'command_copy', 'landing_cta']) assert.equal(ga.filter(e => e.en === event).length, 1);
  assert(ga.some(e => Number(e._et) >= 10_000), 'GA4 must report actual foreground engagement, not just page views');
  assert(ga.some(e => e.seg === '1'), 'GA4 must mark the genuinely engaged session');
  assert(ga.every(e => e.tid === 'G-101HMD03VD' && e.dl === 'https://shell.online/'));
  assert(!JSON.stringify([google, own, product]).includes(marker));
  for (const [label, url] of [
    ['docs', 'https://shell.online/cli/'], ['terminal', `https://shell.online/s/abcdefghijklmnopqrstuvwxyz012345#salt=${marker}`],
    ['app', 'https://app.shell.online/login'], ['query', `https://shell.online/?password=${marker}`], ['fragment', `https://shell.online/#salt=${marker}`],
  ]) {
    phase = label; await browser.navigate(url); await delay(1000); await blank();
    assert.equal(scripts.filter(s => s.phase === phase).length, 0, `${label}: no X script`);
    assert.equal(captures.filter(c => c.phase === phase).length, 0, `${label}: no X events`);
  }
  for (const [label, source] of [
    ['gpc', "Object.defineProperty(navigator,'globalPrivacyControl',{get:()=>true})"],
    ['dnt', "Object.defineProperty(navigator,'doNotTrack',{get:()=> '1'})"],
    ['optout', "document.cookie='shell_analytics_opt_out=1; Path=/; Secure; SameSite=Lax'"],
  ]) {
    phase = label;
    const override = await cdp('Page.addScriptToEvaluateOnNewDocument', { source });
    await browser.navigate('https://shell.online/'); await delay(1000); await blank();
    assert.equal(scripts.filter(s => s.phase === phase).length, 0, label);
    assert.equal(captures.filter(c => c.phase === phase).length, 0, label);
    await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier:override.identifier });
  }
  await cdp('Network.deleteCookies', { name:'shell_analytics_opt_out', url:'https://shell.online/' });
  phase = 'blocked-tag'; await browser.navigate('https://shell.online/'); await delay(1500);
  assert(await browser.evaluate("!!document.querySelector('[data-copy=install]') && !!document.querySelector('[data-cta=start_hero]')"));
  assert.equal(captures.filter(c => c.phase === phase).length, 0);
  assert.deepEqual(errors, []);
  assert(!blocked.some(b => /twitter|ads-twitter|ads-api\.x/.test(b.host)), 'unexpected X destination');
  console.log(JSON.stringify({ mode:live ? 'live' : 'candidate', pixel:'rfilf', passed:['real base request', 'one visit', 'click attribution', 'no form/raw-URL/referrer capture', 'no automatic or timed events', 'GA4/PostHog/first-party compatibility', 'docs/private exclusions', 'GPC/DNT/opt-out', 'blocked tag leaves page usable'], syntheticEventsSent:0 }, null, 2));
} finally {
  socket?.close(); await browser?.close(); await rm(profile, { recursive:true, force:true });
}
