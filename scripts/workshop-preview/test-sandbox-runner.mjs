#!/usr/bin/env node
// Runner tests for the local sandbox preview. Loopback only, no external
// network, no credentials. Starts the app on an ephemeral 127.0.0.1 port and
// exercises security, limits, idempotency, cancellation, actual completion,
// SSE (EventSource.onmessage) and the static allowlist.
//
// Run:  node scripts/workshop-preview/test-sandbox-runner.mjs
// Exit 0 = all pass; exit 1 = at least one failure.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from './server.mjs';

const server = createApp();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function request({ method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, body: '' }));
    if (body != null) req.write(body);
    req.end();
  });
}

// Reads an SSE stream until it closes (or times out). Tracks whether any
// `event:` field was seen — EventSource.onmessage only fires for default
// (message) events, so a correct stream must have none.
function readSSE(path, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const events = [];
    let sawEventField = false;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) sawEventField = true;
            else if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* keep */ } }
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, events, sawEventField }));
      res.on('error', () => resolve({ status: 0, events, sawEventField }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, events, sawEventField }));
    const t = setTimeout(() => { req.destroy(); resolve({ status: 0, timeout: true, events, sawEventField }); }, timeoutMs);
    req.on('close', () => clearTimeout(t));
    req.end();
  });
}

const validBody = (overrides = {}) => ({
  operationId: randomUUID(),
  droneId: 'drone-1',
  task: 'fixture-check',
  origin: { kind: 'owner', id: 'owner-1' },
  ...overrides,
});
const postJob = (body, headers = {}) => request({
  method: 'POST',
  path: '/api/demo/jobs',
  headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
  body: JSON.stringify(body),
});
const cancelJob = (jobId) => request({ method: 'POST', path: `/api/demo/jobs/${jobId}/cancel`, headers: { Origin: base }, body: '' });
const parse = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A cancel now settles on child close (~200ms SIGTERM grace). Wait past that so
// the slot is released and activeCount is accurate before the next section.
const SETTLE_WAIT_MS = 600;

console.log(`sandbox runner test — ${base}\n`);

console.log('[static] allowlist routes + CSP');
{
  const home = await request({ path: '/' });
  check('GET / -> 200', home.status === 200);
  check('CSP connect-src is self (not wildcard/none)', /connect-src 'self'/.test(home.headers['content-security-policy'] ?? ''));
  check('CSP retained (default-src self, script-src self)', /default-src 'self'/.test(home.headers['content-security-policy'] ?? '') && /script-src 'self'/.test(home.headers['content-security-policy'] ?? ''));
  const bench = await request({ path: '/bench-layout.mjs' });
  check('GET /bench-layout.mjs -> 200 javascript', bench.status === 200 && /javascript/.test(bench.headers['content-type'] ?? ''));
  const owner = await request({ path: '/assets/owner.png' });
  check('GET /assets/owner.png -> 200 image/png', owner.status === 200 && /image\/png/.test(owner.headers['content-type'] ?? ''));
  // All selected preview art must be bundled; no external scratch directory.
  const assets = ['drone', 'drone-atlas', 'tree', 'desk', 'owner', 'grass', 'path',
    'courier', 'gateway', 'workstation', 'workstation-typing'];
  for (const asset of assets) {
    const route = `/assets/${asset}.png`;
    const r = await request({ path: route });
    check(`GET ${route} -> 200 image/png`, r.status === 200 && /image\/png/.test(r.headers['content-type'] ?? ''));
  }
  const missing = await request({ path: '/assets/nope.png' });
  check('GET unknown asset -> 404', missing.status === 404);
}

console.log('\n[security] host / origin / content-type / body cap');
{
  const wrongHost = await postJob(validBody(), { Host: '127.0.0.1:9999' });
  check('POST wrong Host -> 403', wrongHost.status === 403);
  const wrongOrigin = await postJob(validBody(), { Origin: 'http://127.0.0.1:1234' });
  check('POST wrong Origin -> 403', wrongOrigin.status === 403);
  const wrongCt = await request({ method: 'POST', path: '/api/demo/jobs', headers: { 'Content-Type': 'text/plain', Origin: base }, body: JSON.stringify(validBody()) });
  check('POST non-JSON content-type -> 415', wrongCt.status === 415);
  const big = await postJob({ ...validBody(), pad: 'x'.repeat(2200) });
  check('POST body > 2KiB -> 413', big.status === 413);
  const badJson = await request({ method: 'POST', path: '/api/demo/jobs', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{not json' });
  check('POST invalid JSON -> 400', badJson.status === 400);
  const badDrone1 = await postJob(validBody({ droneId: 'drone-abc' }));
  check('POST droneId "drone-abc" -> 400', badDrone1.status === 400);
  const badDrone2 = await postJob(validBody({ droneId: 'drone-12345' }));
  check('POST droneId "drone-12345" (5 digits) -> 400', badDrone2.status === 400);
  const noOriginSSE = await readSSE(`/api/demo/jobs/${randomUUID()}/events`);
  check('SSE GET without Origin/Referer -> 403', noOriginSSE.status === 403);
}

console.log('\n[idempotency] same operationId -> same job; conflict -> 409');
{
  const opA = randomUUID();
  const first = await postJob(validBody({ operationId: opA, droneId: 'drone-5' }));
  check('POST opA drone-5 -> 202', first.status === 202);
  const jobA = parse(first)?.jobId;
  const again = await postJob(validBody({ operationId: opA, droneId: 'drone-5' }));
  check('re-POST opA drone-5 -> 202 same jobId', again.status === 202 && parse(again)?.jobId === jobA);
  const opB = randomUUID();
  const b1 = await postJob(validBody({ operationId: opB, droneId: 'drone-6' }));
  check('POST opB drone-6 -> 202', b1.status === 202);
  const b2 = await postJob(validBody({ operationId: opB, droneId: 'drone-7' }));
  check('re-POST opB drone-7 (conflict) -> 409', b2.status === 409);
  const cA = await cancelJob(jobA);
  check('cancel jobA -> 200 cancelling', cA.status === 200 && parse(cA)?.status === 'cancelling');
  const cB = await cancelJob(parse(b1).jobId);
  check('cancel jobB -> 200 cancelling', cB.status === 200 && parse(cB)?.status === 'cancelling');
  await sleep(SETTLE_WAIT_MS); // let both children settle so capacity frees
}

console.log('\n[limits] at most 2 active, one per drone');
{
  const c1 = await postJob(validBody({ droneId: 'drone-1' }));
  const c2 = await postJob(validBody({ droneId: 'drone-2' }));
  check('POST drone-1 -> 202', c1.status === 202);
  check('POST drone-2 -> 202', c2.status === 202);
  const sameDrone = await postJob(validBody({ droneId: 'drone-1' }));
  check('POST drone-1 again (busy) -> 409', sameDrone.status === 409);
  const third = await postJob(validBody({ droneId: 'drone-3' }));
  check('POST drone-3 (at capacity) -> 409', third.status === 409);
  await cancelJob(parse(c1).jobId);
  await cancelJob(parse(c2).jobId);
  await sleep(SETTLE_WAIT_MS); // let both children settle before the next section
}

console.log('\n[cancel] intent now, terminal on child close; slot held while stopping');
{
  const e = await postJob(validBody({ droneId: 'drone-8' }));
  check('POST drone-8 -> 202', e.status === 202);
  const jobId = parse(e).jobId;
  await sleep(300); // let the child spawn and be running before we cancel it
  const r = await cancelJob(jobId);
  check('cancel POST -> 200 cancelling (terminal arrives on the stream)', r.status === 200 && parse(r)?.status === 'cancelling');
  // Slot is NOT reusable while the child is still stopping.
  const busy = await postJob(validBody({ droneId: 'drone-8' }));
  check('drone-8 not reusable while child stopping -> 409', busy.status === 409);
  // The terminal is observed on the stream, and only after the child closes.
  const sse = await readSSE(`/api/demo/jobs/${jobId}/events`, { Origin: base }, 5000);
  const types = sse.events.map((ev) => ev.type);
  check('terminal observed is cancelled (after child close)', types[types.length - 1] === 'cancelled');
  check('no post-terminal events (cancelled is last, no output after it)',
    types.lastIndexOf('cancelled') === types.length - 1
    && !types.slice(types.indexOf('cancelled') + 1).includes('output'));
  // Slot is reusable only after the child has actually settled.
  const free = await postJob(validBody({ droneId: 'drone-8' }));
  check('drone-8 reusable after child settled -> 202', free.status === 202);
  await cancelJob(parse(free).jobId);
  await sleep(SETTLE_WAIT_MS);
  const missing = await cancelJob(randomUUID());
  check('cancel unknown -> 404', missing.status === 404);
}

console.log('\n[completion] actual child exit 0 + validated report, not output alone');
{
  const f = await postJob(validBody({ droneId: 'drone-9' }));
  check('POST drone-9 -> 202', f.status === 202);
  const jobId = parse(f).jobId;
  const sse = await readSSE(`/api/demo/jobs/${jobId}/events`, { Origin: base }, 20000);
  check('SSE -> 200', sse.status === 200);
  check('SSE uses default data events (no event: field, for onmessage)', sse.sawEventField === false);
  const ev = sse.events;
  check('replays accepted first', ev.length > 0 && ev[0].type === 'accepted');
  const types = ev.map((e) => e.type);
  check('started follows accepted', types[1] === 'started');
  check('has output progress events', types.filter((t) => t === 'output').length >= 3);
  check('terminal is completed (not failed)', types[types.length - 1] === 'completed' && !types.includes('failed'));
  const completed = ev[ev.length - 1];
  check('completed detail is validated summary (stage summary, checks 4)', completed.detail?.stage === 'summary' && completed.detail?.checks === 4);
  check('output detail bounded (stage/checks only, no raw stdout)', ev.filter((e) => e.type === 'output').every((e) =>
    Object.keys(e.detail).every((k) => k === 'stage' || k === 'checks')
    && (!e.detail.stage || ['fixture', 'validate', 'digest'].includes(e.detail.stage))));
  check('every event has required fields + source local-sandbox', ev.every((e) =>
    typeof e.id === 'string' && e.jobId === jobId && e.droneId === 'drone-9'
    && e.source === 'local-sandbox' && typeof e.at === 'number' && typeof e.detail === 'object'));
  check('event "at" non-decreasing (order preserved)', ev.every((e, i) => i === 0 || e.at >= ev[i - 1].at));
  check('no premature completion right after first output', types.indexOf('completed') > types.indexOf('output'));
}

console.log('\n----------------------------------------');
server.jobs.shutdown();
await new Promise((resolve) => server.close(resolve));
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASSED: all ${passed} checks`);
process.exit(0);
