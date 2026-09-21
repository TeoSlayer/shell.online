// Real Go host + local workerd canary. Synthetic data only; no deployment or linked account.
// Run after npm run build:web. Output contains fixed check names, never credentials or raw logs.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { parseJsonc } from "./wrangler-config-contract.mjs";

if (process.platform === "win32") throw new Error("local PTY canary requires a POSIX shell");
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync("/tmp/shell-mcp-canary-");
const configPath = join(temp, "wrangler.jsonc");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, name) => { if (!ok) throw new Error(name); console.log("PASS " + name); };
const reservation = createServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
process.env.SHELL_STAGING_URL = "http://127.0.0.1:" + port;
const h = await import("./staging-harness/lib.mjs");
let runtime, session, bearer, failed = false;
let accountServer, credentialPath;
const flowEvents = [];
const accountToken = randomUUID();
let stage = "runtime setup";
try {
  const config = parseJsonc(readFileSync(join(root, "wrangler.example.jsonc"), "utf8"));
  config.name = "shell-online-mcp-local-canary";
  config.main = join(root, "worker/index.ts");
  config.assets.directory = join(root, "dist");
  config.vars.MCP_CONTROL_ENABLED = "1";
  for (const key of ["MCP_ROUTE_KEY", "MCP_FRAME_KEY"]) {
    const pair = await generateKeyPair("ECDH-ES", { extractable: true });
    config.vars[key] = JSON.stringify({ ...await exportJWK(pair.privateKey), kid: key + "-local" });
  }
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  runtime = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
    "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", configPath,
    "--persist-to", join(temp, "state"), "--log-level", "error"], {
    cwd: root, detached: true, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (runtime.exitCode !== null) throw new Error("local runtime exited before readiness");
    try { ready = (await fetch(h.STAGING + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await pause(200);
  }
  check(ready, "local runtime ready");
  // A synthetic account collector verifies real Worker→Go→HTTP delivery without
  // linking to the operator's account. Authorization/store semantics are covered
  // separately by app route + PostgreSQL conformance tests.
  accountServer = createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${accountToken}`) {
      res.writeHead(401).end('{}'); return;
    }
    if (req.url === '/api/account/key') { res.writeHead(404).end('{}'); return; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 32768) { res.writeHead(413).end('{}'); return; } }
    if (req.method === 'POST' && /^\/api\/cli\/sessions\/[^/]+\/mcp-flows$/.test(req.url ?? '')) {
      try { flowEvents.push(...JSON.parse(raw).events); } catch { res.writeHead(400).end('{}'); return; }
    }
    res.end('{}');
  });
  await new Promise((resolve) => accountServer.listen(0, '127.0.0.1', resolve));
  credentialPath = join(dirname(h.buildCli()), 'unlinked-account.json');
  writeFileSync(credentialPath, JSON.stringify({server: `http://127.0.0.1:${accountServer.address().port}`,
    access_token: accountToken, refresh_token: randomUUID(), uid: 'synthetic-flow-owner',
    expires_at: new Date(Date.now() + 3600000).toISOString(), remote_start_asked: true}), {mode: 0o600});
  stage = "create synthetic session";
  session = await h.createSession(["sh"]);
  check(!!session.session_id, "synthetic session created");
  stage = "issue control grant";
  bearer = await h.grant(session.session_id, "local-canary", "control", 120);
  check(!!bearer, "control grant issued");
  stage = "seed encrypted screen";
  let screen = await h.mcpCall(bearer, "shell_screen", {});
  check(screen.status === 200 && !screen.error, "encrypted snapshot seeded");
  const operationId = randomUUID();
  const artifact = join(temp, "result");
  const args = { text: "printf mcp-port-ok >> " + artifact, enter: true, operation_id: operationId };
  const sent = await h.mcpCall(bearer, "shell_send", args);
  check(sent.toolResult?.delivered === true, "encrypted host acknowledgement");
  await pause(200);
  check(readFileSync(artifact, "utf8") === "mcp-port-ok", "independent command completion");
  const replay = await h.mcpCall(bearer, "shell_send", args);
  await pause(100);
  check(replay.toolResult?.delivered === true && readFileSync(artifact, "utf8") === "mcp-port-ok", "no duplicate PTY write");
  stage = 'host flow reporting';
  for (let i = 0; i < 40 && !flowEvents.some(e => e.tool === 'shell_send' && e.outcome === 'delivered'); i++) await pause(100);
  const completed = flowEvents.find(e => e.tool === 'shell_send' && e.phase === 'settled' && e.outcome === 'delivered');
  check(!!completed && flowEvents.some(e => e.id === completed.id && e.phase === 'started'), 'real host reports correlated start and delivered outcome');
  check(flowEvents.every(e => Object.keys(e).every(k => ['id','tool','phase','at','outcome'].includes(k))) &&
    !JSON.stringify(flowEvents).includes(args.text) && !JSON.stringify(flowEvents).includes(bearer), 'flow reports contain no input or bearer');
  const rotation = await h.cli(["password", "rotate", session.session_id]);
  check(rotation.code === 0, "live password rotation");
  check((await h.mcpCall(bearer, "shell_status", {})).status === 401, "old MCP bearer revoked by rotation");
  bearer = await h.grant(session.session_id, "rotated-canary", "control", 120);
  screen = await h.mcpCall(bearer, "shell_screen", {});
  check(screen.status === 200 && !screen.error, "new grant decrypts rotated snapshot");
  const next = await h.mcpCall(bearer, "shell_send", {
    text: "printf rotated >> " + artifact, enter: true, operation_id: randomUUID(),
  });
  await pause(200);
  check(next.toolResult?.delivered === true && readFileSync(artifact, "utf8") === "mcp-port-okrotated", "send after key rotation");
  await h.revokeAll(session.session_id);
  check((await h.mcpCall(bearer, "shell_status", {})).status === 401, "explicit revocation denies access");
} catch (error) {
  failed = true;
  // Raw exceptions can include request URLs or tokens: deliberately do not print them.
  console.error("FAIL local MCP canary: " + stage);
  const diagnostic = h.redact(error?.message ?? "failed", [bearer, session?.session_id, session?.share_url, session?.e2ee_password].filter(Boolean));
  console.error(diagnostic.slice(0, 300));
} finally {
  if (session) {
    const cleanup = await h.cleanupSession(session.session_id, { verifyBearer: bearer });
    if (!cleanup.clean) { failed = true; console.error("FAIL verified session cleanup"); }
    else console.log("PASS verified session cleanup");
  }
  if (runtime) {
    try { process.kill(-runtime.pid, "SIGTERM"); } catch {}
    await pause(300);
  }
  if (accountServer) await new Promise(resolve => accountServer.close(resolve));
  if (credentialPath) rmSync(credentialPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
