// Real account API + Go requester/host + workerd. Synthetic localhost sessions only.
// Run after npm run build:web. Never prints credentials or raw process output.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { build } from "esbuild";
import { parseJsonc } from "./wrangler-config-contract.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync("/tmp/shell-mcp-team-canary-");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, name) => { if (!ok) throw new Error(name); console.log("PASS " + name); };
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
process.env.SHELL_STAGING_URL = "http://127.0.0.1:" + port;
const h = await import("./staging-harness/lib.mjs");
let runtime, session, teamBearer, accountServer, credentialPath;
let failed = false;
let stage = "account API setup";
const routeStatuses = {};
try {
  const modulePath = join(temp, "accounts.mjs");
  await build({ stdin: { contents: `export { createApp } from './app/server/app.ts';
    export { MemoryStore } from './app/server/lib/store-memory.ts';
    export { issueTokens } from './app/server/lib/tokens.ts';`, resolveDir: root },
    bundle: true, platform: "node", format: "esm", outfile: modulePath, logLevel: "silent" });
  const { createApp, MemoryStore, issueTokens } = await import(pathToFileURL(modulePath));
  const storePath = join(temp, "accounts.json");
  const store = new MemoryStore(storePath);
  const now = Date.now();
  await store.putOrganization({ id: "org_canary", name: "Synthetic", createdAt: now, createdBy: "owner" });
  for (const uid of ["owner", "teammate"]) {
    await store.putMembership({ orgId: "org_canary", uid, email: uid + "@example.invalid", name: uid,
      role: uid === "owner" ? "owner" : "member", joinedAt: now });
  }
  const owner = await issueTokens(store, { uid: "owner", email: "owner@example.invalid", name: "Owner", label: "canary" });
  const teammate = await issueTokens(store, { uid: "teammate", email: "teammate@example.invalid", name: "Teammate", label: "canary" });
  const teamCheckToken = randomUUID();
  let persistenceChecked = false;
  const reportGrant = store.reportMcpTeamGrant.bind(store);
  store.reportMcpTeamGrant = async (...args) => {
    const result = await reportGrant(...args);
    if (result === "stored") {
      check(!readFileSync(storePath, "utf8").includes(args[5].bearer), "real host bearer is absent from persisted account data");
      persistenceChecked = true;
    }
    return result;
  };
  const accountApp = createApp({ store, verifyIdToken: async () => ({ ok: false }),
    allowedOrigins: [], mcpTeamCheckToken: teamCheckToken, log: () => {} });
  accountServer = createServer((request, response) => {
    const endpoint = request.url?.endsWith("/mcp/team") ? "request" :
      request.url?.endsWith("/team-requests") ? "host-poll" :
      request.url?.endsWith("/grant") ? "host-report" : "other";
    response.once("finish", () => { const key = endpoint + ":" + response.statusCode;
      routeStatuses[key] = (routeStatuses[key] ?? 0) + 1; });
    return accountApp(request, response);
  });
  await new Promise((resolve) => accountServer.listen(0, "127.0.0.1", resolve));
  const accountOrigin = `http://127.0.0.1:${accountServer.address().port}`;
  const writeCredentials = (path, uid, tokens) => writeFileSync(path, JSON.stringify({
    server: accountOrigin, uid, access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
    expires_at: new Date(now + 3600000).toISOString(), remote_start_asked: true,
  }), { mode: 0o600 });
  credentialPath = join(dirname(h.buildCli()), "unlinked-account.json");
  writeCredentials(credentialPath, "owner", owner);
  const teammatePath = join(temp, "teammate.json");
  writeCredentials(teammatePath, "teammate", teammate);
  const config = parseJsonc(readFileSync(join(root, "wrangler.example.jsonc"), "utf8"));
  config.name = "shell-online-mcp-team-local-canary";
  config.main = join(root, "worker/index.ts");
  config.assets.directory = join(root, "dist");
  config.vars.MCP_CONTROL_ENABLED = "1";
  config.vars.MCP_TEAM_CHECK_TOKEN = teamCheckToken;
  config.vars.MCP_TEAM_ALLOW_LOCAL_HTTP = "1";
  config.vars.APP_STATS_URL = accountOrigin;
  for (const key of ["MCP_ROUTE_KEY", "MCP_FRAME_KEY"]) {
    const pair = await generateKeyPair("ECDH-ES", { extractable: true });
    config.vars[key] = JSON.stringify({ ...await exportJWK(pair.privateKey), kid: key + "-local" });
  }
  const configPath = join(temp, "wrangler.jsonc");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  stage = "runtime setup";
  runtime = spawn(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
    "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", configPath,
    "--persist-to", join(temp, "state"), "--log-level", "error"],
    { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (runtime.exitCode !== null) break;
    try { ready = (await fetch(h.STAGING + "/api/health", { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await pause(200);
  }
  check(ready, "local team runtime ready");
  stage = "host publication";
  session = await h.createSession(["sh"]);
  check(!!(await store.sessionInOrg("org_canary", session.session_id)), "real host registered with synthetic account");
  const consent = async (enabled) => {
    const response = await fetch(`${accountOrigin}/api/cli/sessions/${session.session_id}/automation`, {
      method: "PUT", headers: { Authorization: `Bearer ${owner.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mcpTeamAccess: enabled }), signal: AbortSignal.timeout(2000),
    });
    check(response.ok, "owner team consent updated");
  };
  await consent(true);
  stage = "protected team CLI delivery";
  const result = await new Promise((resolve) => {
    const child = spawn(h.buildCli(), ["mcp", "team", session.session_id], {
      cwd: root, env: { ...process.env, SHELL_ONLINE_CONFIG: teammatePath,
        SHELL_ONLINE_RUNTIME_DIR: join(temp, "teammate-runtime") }, timeout: 30000,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on("error", () => resolve({ code: -1 }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
  check(result.code === 0 && result.stdout.trim().split(".").length === 5, "team CLI decrypts actual host-issued bearer");
  teamBearer = result.stdout.trim();
  check(persistenceChecked, "mandatory sealing exercised through the actual report endpoint");
  stage = "team observation";
  const screen = await h.mcpCall(teamBearer, "shell_screen", {});
  if (screen.status !== 200 || screen.error) console.error(`Team observation status: ${screen.status}; tool error: ${screen.toolError === true}`);
  check(screen.status === 200 && !screen.error, "team bearer observes encrypted screen");
  const send = await h.mcpCall(teamBearer, "shell_send", { text: "echo denied", enter: true, operation_id: randomUUID() });
  check(!!send.error, "team observe grant cannot send input");
  const requests = store.data.mcpTeamGrants;
  const delivered = requests.find((entry) => entry.requesterUid === "teammate");
  const secondFetch = await fetch(`${accountOrigin}/api/cli/sessions/${session.session_id}/mcp/team/${delivered.requestId}`, {
    headers: { Authorization: `Bearer ${teammate.accessToken}` }, signal: AbortSignal.timeout(2000),
  });
  check(secondFetch.status === 410, "protected delivery is consumed once");
  stage = "live authorization";
  const ownerBearer = await h.grant(session.session_id, "synthetic-owner", "control", 120);
  const output = await h.mcpCall(teamBearer, "shell_output", {});
  const marker = "team-revoked-" + randomUUID();
  const waiting = h.mcpCall(teamBearer, "shell_wait", { pattern: marker, timeout_ms: 3000,
    cursor: { epoch: output.toolResult.epoch, offset: output.toolResult.offset } });
  await pause(250);
  // Isolate account authorization from the host's eventual revocation poll.
  const listWork = store.listMcpTeamRequests;
  store.listMcpTeamRequests = async () => { throw new Error("synthetic host poll outage"); };
  await consent(false);
  const sent = await h.mcpCall(ownerBearer, "shell_send", { text: "printf " + marker, enter: true, operation_id: randomUUID() });
  check(sent.toolResult?.delivered === true, "owner produced output while team host polling was unavailable");
  const late = await waiting;
  check(!!late.error && !JSON.stringify(late.rpc).includes(marker), "mid-wait consent revocation withholds newly produced output");
  check([401, 403].includes((await h.mcpCall(teamBearer, "shell_status", {})).status), "consent removal denies the next request");
  await consent(true);
  check([401, 403].includes((await h.mcpCall(teamBearer, "shell_status", {})).status), "restoring consent does not revive the old grant");
  store.listMcpTeamRequests = listWork;
} catch {
  failed = true;
  console.error("FAIL local team MCP canary: " + stage);
  console.error("Account endpoint status counts: " + JSON.stringify(routeStatuses));
} finally {
  if (session) {
    const cleanup = await h.cleanupSession(session.session_id, { verifyBearer: teamBearer });
    if (!cleanup.clean) { failed = true; console.error("FAIL verified team session cleanup"); }
    else console.log("PASS verified team session cleanup");
  }
  if (runtime) { try { process.kill(-runtime.pid, "SIGTERM"); } catch {} await pause(300); }
  if (accountServer) await new Promise((resolve) => accountServer.close(resolve));
  if (credentialPath) rmSync(credentialPath, { force: true });
  rmSync(temp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
