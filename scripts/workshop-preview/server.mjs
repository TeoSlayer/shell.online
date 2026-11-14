import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SandboxJobs, DRONE_ID, ORIGIN_KINDS } from './sandbox-jobs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const art = join(here, 'assets');

// Static CSP: connect-src is 'self' (not a wildcard) so the UI may POST jobs and
// open the SSE stream on this origin, and nothing else changes.
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'";
const STATIC_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': CSP,
};

const BODY_CAP = 2048; // 2KiB streaming body cap
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createApp() {
  // This developer preview serves only the selected bundled assets. The map
  // is an allowlist of exact paths — never a repository directory.
  const files = new Map([
    ['/', [join(here, 'index.html'), 'text/html; charset=utf-8']],
    ['/style.css', [join(here, 'style.css'), 'text/css; charset=utf-8']],
    ['/demo.js', [join(here, 'demo.js'), 'text/javascript; charset=utf-8']],
    ['/bench-layout.mjs', [join(here, 'bench-layout.mjs'), 'text/javascript; charset=utf-8']],
    ['/courier-flight.mjs', [join(here, 'courier-flight.mjs'), 'text/javascript; charset=utf-8']],
    ['/owner-palette.mjs', [join(here, 'owner-palette.mjs'), 'text/javascript; charset=utf-8']],
    ['/assets/drone.png', [join(art, 'drone.png'), 'image/png']],
    ['/assets/tree.png', [join(art, 'tree.png'), 'image/png']],
    ['/assets/desk.png', [join(art, 'desk.png'), 'image/png']],
    ['/assets/drone-atlas.png', [join(art, 'drone-atlas.png'), 'image/png']],
    ['/assets/owner.png', [join(art, 'owner.png'), 'image/png']],
    ['/assets/grass.png', [join(art, 'grass.png'), 'image/png']],
    ['/assets/path.png', [join(art, 'path.png'), 'image/png']],
    ['/daily-work.mjs', [join(here, 'daily-work.mjs'), 'text/javascript; charset=utf-8']],
    ['/assets/courier.png', [join(art, 'courier.png'), 'image/png']],
    ['/assets/gateway.png', [join(art, 'gateway.png'), 'image/png']],
    ['/assets/workstation.png', [join(art, 'workstation.png'), 'image/png']],
    ['/assets/workstation-typing.png', [join(art, 'workstation-typing.png'), 'image/png']],
  ]);

  const jobs = new SandboxJobs({ workerScript: join(here, 'sandbox-worker.mjs'), execPath: process.execPath });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const port = server.address()?.port;

    if (url.pathname.startsWith('/api/demo/jobs')) {
      try {
        await handleApi(req, res, url, { port, jobs });
      } catch {
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal"}'); }
        else res.end();
      }
      return;
    }

    const entry = files.get(url.pathname);
    if (!entry) { res.writeHead(404, STATIC_HEADERS); res.end('Not found'); return; }
    try {
      const content = await readFile(entry[0]);
      res.writeHead(200, { 'Content-Type': entry[1], ...STATIC_HEADERS });
      res.end(content);
    } catch { res.writeHead(404, STATIC_HEADERS); res.end('Asset not ready'); }
  });

  server.jobs = jobs; // shared by shutdown and tests
  return server;
}

function readBody(req, cap) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) { req.pause(); finish({ error: 'too_large', status: 413 }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ error: 'body', status: 400 }));
  });
}

function isSameOriginReferer(referer, sameOrigin) {
  return typeof referer === 'string' && (referer === sameOrigin || referer.startsWith(`${sameOrigin}/`));
}

function validateJobBody(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'shape' };
  if (Object.keys(obj).some((k) => !['operationId', 'droneId', 'task', 'origin'].includes(k))) return { ok: false, error: 'unknown_key' };
  if (typeof obj.operationId !== 'string' || !UUID_V4.test(obj.operationId)) return { ok: false, error: 'operationId' };
  if (typeof obj.droneId !== 'string' || !DRONE_ID.test(obj.droneId)) return { ok: false, error: 'droneId' };
  if (obj.task !== 'fixture-check') return { ok: false, error: 'task' };
  const origin = obj.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return { ok: false, error: 'origin' };
  if (Object.keys(origin).some((k) => !['kind', 'id'].includes(k))) return { ok: false, error: 'origin_key' };
  if (typeof origin.kind !== 'string' || !ORIGIN_KINDS.has(origin.kind)) return { ok: false, error: 'origin_kind' };
  if (typeof origin.id !== 'string' || origin.id.length < 1 || origin.id.length > 64) return { ok: false, error: 'origin_id' };
  return {
    ok: true,
    value: {
      operationId: obj.operationId,
      droneId: obj.droneId,
      task: obj.task,
      origin: { kind: origin.kind, id: origin.id },
    },
  };
}

async function handleApi(req, res, url, { port, jobs }) {
  const sameOrigin = `http://127.0.0.1:${port}`;
  const hostOk = req.headers.host === `127.0.0.1:${port}`;

  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  };

  // POST /api/demo/jobs
  if (url.pathname === '/api/demo/jobs' && req.method === 'POST') {
    if (!hostOk) return send(403, { error: 'host' });
    if (req.headers.origin !== sameOrigin) return send(403, { error: 'origin' });
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) return send(415, { error: 'content_type' });
    const body = await readBody(req, BODY_CAP);
    if (body.error) return send(body.status, { error: body.error });
    let parsed;
    try { parsed = JSON.parse(body.text || '{}'); } catch { return send(400, { error: 'json' }); }
    const v = validateJobBody(parsed);
    if (!v.ok) return send(400, { error: v.error });
    const { job, error, existing } = jobs.admit(v.value);
    if (error === 'conflict') return send(409, { error: 'conflict' });
    if (error === 'capacity') return send(409, { error: 'capacity' });
    if (!existing) jobs.start(job);
    return send(202, { jobId: job.jobId });
  }

  // POST /api/demo/jobs/:id/cancel
  const cancelMatch = url.pathname.match(/^\/api\/demo\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    if (!hostOk) return send(403, { error: 'host' });
    if (req.headers.origin !== sameOrigin) return send(403, { error: 'origin' });
    const body = await readBody(req, BODY_CAP);
    if (body.error) return send(body.status, { error: body.error });
    const jobId = decodeURIComponent(cancelMatch[1]);
    const { job, error, status } = jobs.cancel(jobId);
    if (error === 'not_found') return send(404, { error: 'not_found' });
    // `cancelling` while the child settles; the terminal `cancelled` arrives on
    // the event stream. Already-terminal jobs report their terminal status.
    return send(200, { jobId: job.jobId, status });
  }

  // GET /api/demo/jobs/:id/events  (SSE)
  const eventsMatch = url.pathname.match(/^\/api\/demo\/jobs\/([^/]+)\/events$/);
  if (eventsMatch && req.method === 'GET') {
    if (!hostOk) return send(403, { error: 'host' });
    const originOk = req.headers.origin === sameOrigin;
    const refererOk = isSameOriginReferer(req.headers.referer, sameOrigin);
    if (!originOk && !refererOk) return send(403, { error: 'origin' });
    const job = jobs.get(decodeURIComponent(eventsMatch[1]));
    if (!job) return send(404, { error: 'not_found' });
    return streamEvents(res, job);
  }

  return send(404, { error: 'not_found' });
}

function streamEvents(res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  const writeEvent = (event) => {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  let emitted = 0;
  for (const event of job.events) { writeEvent(event); emitted += 1; }
  const isTerminal = (s) => s === 'completed' || s === 'failed' || s === 'cancelled';
  if (isTerminal(job.status)) { res.end(); return; }
  const interval = setInterval(() => {
    while (emitted < job.events.length) { writeEvent(job.events[emitted]); emitted += 1; }
    if (isTerminal(job.status)) { clearInterval(interval); res.end(); }
  }, 100);
  res.on('close', () => clearInterval(interval));
}

function installShutdown(server, jobs) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    jobs.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  installShutdown(server, server.jobs);
  server.listen(Number(process.env.WORKSHOP_DEMO_PORT ?? 0), '127.0.0.1', () => console.log(`Workshop demo: http://127.0.0.1:${server.address().port}/\nPID: ${process.pid}\nDirectory: ${here}`));
}

export { createApp };
