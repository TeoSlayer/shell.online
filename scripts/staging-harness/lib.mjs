// Core for the bounded staging test harness (P02: repeatable runtime regressions).
//
// Each case gets an ISOLATED session running SYNTHETIC content, mints its own grants, and
// revokes/kills in a finally block. Bearers live in memory only; evidence records metadata,
// never bearer contents (a final scan enforces this before anything is written).
//
// No production credentials, no production writes, no local model inference: the harness drives
// the deployed staging Worker over real HTTP with deterministic assertions. Model-backed client
// checks (OpenCode/Codex/Claude) are separate and must select the remote GH200 explicitly.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "../wrangler-config-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");

// The ONE pinned staging origin. An unrelated account's shell-online-staging.*.workers.dev is a
// different deployment, so the pattern is not accepted — only this exact HTTPS origin.
const STAGING_ORIGIN = "https://shell-online-staging.vulturelabs01.workers.dev";

// The staging URL override is pinned to the exact staging HTTPS origin. HTTP is allowed ONLY for
// explicit loopback testing (local wrangler dev). Userinfo, query, and fragment are rejected
// (they can carry or mask credentials / a different path).
export function validateStagingUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`SHELL_STAGING_URL is not a valid URL: ${url}`);
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new Error(`SHELL_STAGING_URL must not contain userinfo, query, or fragment: ${url}`);
  }
  const isLoopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (isLoopback) {
    // Explicit loopback testing (local wrangler dev): http or https, any port.
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`SHELL_STAGING_URL loopback must be http(s): ${url}`);
    }
    return url;
  }
  // Non-loopback: pin the exact staging HTTPS origin (https, exact host, no other account).
  if (u.origin !== STAGING_ORIGIN) {
    throw new Error(
      `SHELL_STAGING_URL must be the exact staging origin ${STAGING_ORIGIN}, or an explicit ` +
        `loopback http(s) URL (localhost/127.0.0.1/::1) for local testing; got: ${url}`,
    );
  }
  return url;
}

export const STAGING = validateStagingUrl(process.env.SHELL_STAGING_URL ?? STAGING_ORIGIN);
export const MCP_URL = `${STAGING}/mcp`;

// Redact secrets and URLs from free-text (stderr/body excerpts) before it is recorded or thrown.
// Strips the E2EE password field, any http(s) URL (the share link), and any explicitly-passed
// secret (bearer, session id).
export function redact(text, secrets = []) {
  if (text == null) return "";
  let out = String(text);
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  out = out.replace(/"e2ee_password"\s*:\s*"[^"]*"/g, '"e2ee_password":"[REDACTED]"');
  out = out.replace(/https?:\/\/[^\s"'<>]+/g, "[URL]");
  return out;
}

// Synthetic content: a deterministic 1 Hz tick. Gives waits a live stream to time out against
// without any external dependency, and makes cursor/epoch behavior observable.
export const SYNTHETIC_COMMAND = [
  "sh",
  "-c",
  'while true; do date -u +%Y-%m-%dT%H:%M:%SZ; echo tick; sleep 1; done',
];

// --- CLI (built once, fast) ---------------------------------------------------------------

let cliBin = null;
let cliEnvironment;

export function buildCli() {
  if (cliBin) return cliBin;
  // Unix socket paths have a small platform limit; macOS's long TMPDIR exceeds it.
  const dir = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "shell-harness-"));
  // Never publish synthetic test sessions into the operator's linked production account,
  // or mix test sockets with a running machine daemon.
  cliEnvironment = {
    ...process.env,
    SHELL_ONLINE_CONFIG: path.join(dir, "unlinked-account.json"),
    SHELL_ONLINE_RUNTIME_DIR: path.join(dir, "runtime"),
  };
  cliBin = path.join(dir, "shell");
  execFileSync("go", ["build", "-o", cliBin, "./cmd/shell"], { cwd: REPO, stdio: "pipe", timeout: 180000 });
  return cliBin;
}

export function cli(args, { timeout = 120000 } = {}) {
  const bin = buildCli();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: REPO, timeout, env: cliEnvironment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// --- session lifecycle ---------------------------------------------------------------------

// Create an isolated session on staging. The CLI prints the session event JSON on stderr.
export async function createSession(command = SYNTHETIC_COMMAND) {
  const { code, stderr } = await cli(["--server", STAGING, "--json", "--", ...command]);
  if (code !== 0) throw new Error(`session create failed (exit ${code}): ${redact(stderr).slice(0, 300)}`);
  const lines = stderr.trim().split("\n").filter(Boolean);
  let event = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === "session" && parsed.session_id) event = parsed;
    } catch {
      // not the session event line
    }
  }
  if (!event) throw new Error(`no session event in CLI output: ${redact(stderr).slice(0, 300)}`);
  return event;
}

export async function killSession(sessionId) {
  // `shell kill` uses flag.Parse, which treats a session id starting with "-" as a flag; the "--"
  // ends flag parsing so the id is always a positional argument.
  const { code, stderr } = await cli(["kill", "--", sessionId]);
  if (code !== 0) throw new Error(`kill failed (exit ${code}): ${redact(stderr, [sessionId]).slice(0, 200)}`);
}

export async function grant(sessionId, label, scopes = "observe", ttl = 900) {
  const { code, stdout, stderr } = await cli(["mcp", "grant", sessionId, label, scopes, String(ttl)]);
  if (code !== 0) throw new Error(`grant failed (exit ${code}): ${redact(stderr, [sessionId]).slice(0, 300)}`);
  const bearer = stdout.trim();
  if (!bearer) throw new Error("grant produced no bearer");
  return bearer;
}

export async function revokeAll(sessionId) {
  const { code, stderr } = await cli(["mcp", "revoke-all", sessionId]);
  if (code !== 0) throw new Error(`revoke-all failed (exit ${code}): ${redact(stderr, [sessionId]).slice(0, 200)}`);
}

// Bounded, VERIFIED session cleanup. Revokes all grants and kills the session with bounded
// retries, then VERIFIES the outcome by probing with a bearer: the credentials must no longer
// authorize (401 revoked / 404-gone / connection-closed), not a live 200. A timeout or error is
// NOT assumed to mean the revocation failed or succeeded — the verification probe decides, and an
// ambiguous result (e.g. a rate-limiter 429) is reported as UNCERTAIN rather than guessed.
// Returns { clean, verified, notes }: clean = killed AND verified gone; verified = the probe
// confirmed the credentials no longer authorize; notes = a redacted step log for the evidence.
export async function cleanupSession(sessionId, { verifyBearer = null, retries = 3 } = {}) {
  const notes = [];
  let killed = false;
  // 1. Revoke all grants (bounded retries).
  for (let i = 1; i <= retries; i += 1) {
    try {
      await revokeAll(sessionId);
      notes.push(`revoke-all ok (attempt ${i})`);
      break;
    } catch (err) {
      notes.push(`revoke-all attempt ${i}/${retries}: ${redact(err?.message ?? err, [sessionId]).slice(0, 120)}`);
    }
  }
  // 2. Kill the session (bounded retries).
  for (let i = 1; i <= retries && !killed; i += 1) {
    try {
      await killSession(sessionId);
      killed = true;
      notes.push(`kill ok (attempt ${i})`);
    } catch (err) {
      notes.push(`kill attempt ${i}/${retries}: ${redact(err?.message ?? err, [sessionId]).slice(0, 120)}`);
    }
  }
  // 3. Verify: the credentials no longer authorize. A live 200 means cleanup is incomplete; a
  // Only explicit auth denial or gone proves revocation. A network error, 500 or 429 is
  // ambiguous and is retried, then reported as uncertain.
  let verified = false;
  if (verifyBearer) {
    for (let i = 1; i <= retries; i += 1) {
      const probe = await mcpCall(verifyBearer, "shell_status", {});
      if (probe.status === 200 && probe.toolResult?.status) {
        notes.push(`verify attempt ${i}: session still LIVE (status=${probe.toolResult.status}) — not clean`);
        verified = false;
        break; // a live session is definitive; no point retrying
      }
      if (probe.status === 401 || probe.status === 404 || probe.status === 410) {
        verified = true;
        notes.push(`verify attempt ${i}: credentials no longer authorize (status=${probe.status || "connection-closed"})`);
        break;
      }
      // 429 (rate-limited) or other: ambiguous, retry.
      notes.push(`verify attempt ${i}/${retries}: ambiguous (status=${probe.status})`);
    }
    if (!verified && !(notes.some((n) => n.includes("still LIVE")))) {
      notes.push("verify: UNCERTAIN (could not confirm the credentials stopped authorizing)");
    }
  } else if (killed) {
    // No credentials were minted on this session (no grant to verify) and the kill succeeded:
    // there is nothing left that could authorize access, so the cleanup is clean.
    verified = true;
    notes.push("verify: N/A (no credentials minted; session killed)");
  } else {
    notes.push("verify: skipped (no bearer provided and kill not confirmed)");
  }
  const clean = killed && verified;
  return { clean, verified, killed, notes };
}

// --- MCP client ----------------------------------------------------------------------------

function parseSse(body) {
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice("data: ".length));
  } catch {
    return null;
  }
}

// Pure response classification (no network) so the classification rules can be regression-tested
// in isolation. Returns the normalized result shape (minus `ms`, which mcpCall adds).
export function classifyMcpResponse(status, bodyText, { retryAfter = null } = {}) {
  if (status === 429) {
    // Two distinct 429 sources: the Worker's per-IP rate limiter (Retry-After 60, "too many MCP
    // requests") and the DO's concurrency cap (Retry-After 1, "too many concurrent MCP requests").
    // Distinguish them so a case can assert on the concurrency cap specifically.
    let kind = "unknown";
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed?.error === "too many concurrent MCP requests") kind = "concurrency";
      else if (parsed?.error === "too many MCP requests") kind = "rate_limiter";
      else kind = "other";
    } catch {
      kind = retryAfter === "1" ? "concurrency" : "rate_limiter";
    }
    return { status: 429, rpc: null, toolResult: null, error: redact(bodyText).slice(0, 120), busy: kind, aborted: false, toolError: false };
  }
  const rpc = parseSse(bodyText);
  if (!rpc) {
    return { status, rpc: null, toolResult: null, error: `unparseable response: ${redact(bodyText).slice(0, 200)}`, aborted: false, toolError: false };
  }
  if (rpc.error) {
    return { status, rpc, toolResult: null, error: redact(rpc.error.message ?? "rpc error"), aborted: false, toolError: false };
  }
  // A tool can return a JSON-RPC success with result.isError: true (the tool ran but reported an
  // error). That is a tool error, NOT a success — surface it so callers don't treat it as ok.
  if (rpc.result?.isError) {
    const text = rpc.result?.content?.[0]?.text;
    return { status, rpc, toolResult: null, error: redact(`tool error: ${text ?? "unknown"}`), aborted: false, toolError: true };
  }
  const text = rpc.result?.content?.[0]?.text;
  let toolResult = null;
  try {
    toolResult = text ? JSON.parse(text) : null;
  } catch {
    toolResult = null;
  }
  return { status, rpc, toolResult, error: null, aborted: false, toolError: false };
}

// Pure classification of a fetch rejection (no network). Distinguishes an INTENTIONAL abort (the
// caller's abortAfterMs fired) from a GUARD timeout (timeoutMs fired): a guard timeout is a
// timeout, not an intentional cancellation, and must not be reported as `aborted: true`.
export function classifyAbort(err, { abortReason = null } = {}) {
  if (err?.name === "AbortError") {
    if (abortReason === "intentional") {
      return { status: 0, rpc: null, toolResult: null, error: null, aborted: true, abortedBy: "intentional", toolError: false };
    }
    return { status: 0, rpc: null, toolResult: null, error: "timeout", aborted: false, abortedBy: abortReason ?? "guard", toolError: false };
  }
  return { status: 0, rpc: null, toolResult: null, error: redact(String(err)), aborted: false, abortedBy: abortReason, toolError: false };
}

// One MCP call against staging. Returns a normalized result:
//   { status, ms, rpc, toolResult, error, aborted, toolError }
// - toolResult: the parsed JSON the tool returned (for successful tools/call)
// - error: JSON-RPC error, tool error, HTTP-level error text, or "timeout"
// - aborted: true only if the caller's intentional abort fired (not a guard timeout)
// - toolError: true if the tool returned result.isError: true
export async function mcpCall(bearer, tool, args, { id = 1, abortAfterMs = 0, timeoutMs = 60000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  let abortTimer = null;
  // Which timer actually fired: "intentional" (the caller's abortAfterMs) or "guard" (timeoutMs).
  let abortReason = null;
  if (abortAfterMs > 0) {
    abortTimer = setTimeout(() => {
      if (!abortReason) abortReason = "intentional";
      controller.abort();
    }, abortAfterMs);
  }
  const guard = setTimeout(() => {
    if (!abortReason) abortReason = "guard";
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: controller.signal,
    });
    const body = await res.text();
    const ms = Date.now() - started;
    return { ...classifyMcpResponse(res.status, body, { retryAfter: res.headers.get("Retry-After") }), ms };
  } catch (err) {
    const ms = Date.now() - started;
    return { ...classifyAbort(err, { abortReason }), ms };
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    clearTimeout(guard);
  }
}

// The Worker rate-limits MCP at 60 req/60s per IP (a 429 with Retry-After 60), distinct from the
// DO concurrency cap (429, Retry-After 1). A burst case needs a clean rate-limiter state so its
// 429s are the concurrency cap, not the limiter. Poll a cheap call until the limiter is clear.
export async function waitForRateLimiter(bearer, { tries = 20, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const res = await mcpCall(bearer, "shell_status", {});
    if (res.status === 200) return true;
    if (res.status === 429 && res.busy === "rate_limiter") {
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    return false; // a non-limiter failure (e.g. 401) means waiting won't help
  }
  return false;
}

// The MCP_LIMITER is a fixed 60s window (60 req/60s per IP). Two burst cases run back-to-back
// exceed one window, so each burst case waits out a full period at its start: every MCP request it
// makes then lands in a fresh window with the full 60-request budget. Overridable for CI.
const RATE_COOLDOWN_MS = Number(process.env.SHELL_HARNESS_COOLDOWN_MS ?? 65_000);
export async function cooldown(label = "rate-limiter window") {
  if (RATE_COOLDOWN_MS <= 0) return;
  console.log(`  cooldown: waiting ${Math.round(RATE_COOLDOWN_MS / 1000)}s for a fresh ${label}`);
  await new Promise((r) => setTimeout(r, RATE_COOLDOWN_MS));
}

// tools/list for the grant's bearer. Returns the parsed tool list (or throws). The error messages
// redact with the caller's secret registry (so a tools/list failure can never leak a bearer or
// nested-session credential) and use a fixed code + status rather than a raw body excerpt.
export async function mcpToolsList(bearer, secrets = []) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await res.text();
  const rpc = parseSse(body);
  if (!rpc) throw new Error(`tools/list: unparseable response (status ${res.status})`);
  if (rpc.error) throw new Error(`tools/list: rpc error code=${rpc.error.code ?? "?"} ${redact(rpc.error.message ?? "", secrets).slice(0, 120)}`);
  return rpc.result?.tools ?? [];
}

// A request whose BODY is held open (chunked, no bytes sent yet). The server registers the
// request in-flight BEFORE reading the body, so a held body occupies a concurrency slot without
// being admitted to any tool. `release(payload)` completes the body; `drop()` aborts it.
export function heldMcpRequest(bearer, { id = 1 } = {}) {
  let controller;
  let dropped = false;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  // The fetch promise is GUARDED so a drop() (which rejects it by erroring the body stream) is
  // never an unhandled rejection — Node would otherwise crash the process on the rejection. A drop
  // resolves to { status: 0, dropped: true }; a release resolves to the real response.
  const promise = (async () => {
    try {
      const res = await fetch(MCP_URL, {
        method: "POST",
        duplex: "half",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Protocol-Version": "2025-06-18",
        },
        body,
      });
      const text = await res.text();
      return { status: res.status, body: text, dropped: false };
    } catch {
      return { status: 0, body: "", dropped };
    }
  })();
  return {
    promise,
    release(payload) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      controller.close();
    },
    drop() {
      dropped = true;
      try {
        controller.error(new Error("dropped"));
      } catch {
        // already closed
      }
    },
  };
}

// --- evidence --------------------------------------------------------------------------------

export class Evidence {
  constructor(name, identity) {
    this.data = {
      case: name,
      startedAt: new Date().toISOString(),
      identity,
      steps: [],
      failures: [],
      // Inconclusive: the case could not EXERCISE the thing under test (e.g. the concurrency cap
      // was not reached). This is a test-harness limitation, NOT a product failure and NOT a pass.
      inconclusive: [],
    };
  }
  step(name, data = {}) {
    this.data.steps.push({ step: name, ...data });
  }
  fail(message) {
    this.data.failures.push(message);
  }
  inconclusive(message) {
    this.data.inconclusive.push(message);
  }
  get ok() {
    return this.data.failures.length === 0;
  }
  // True when there are no failures but the case could not fully exercise its target.
  get inconclusiveOnly() {
    return this.data.failures.length === 0 && this.data.inconclusive.length > 0;
  }
  // Write the evidence file, refusing to persist if any secret (bearer, share link, E2EE
  // password) leaked into it. The session id is intentionally recorded, so it is not scanned.
  write(dir, secrets = []) {
    const json = JSON.stringify(this.data, null, 2);
    for (const s of secrets) {
      if (s && json.includes(s)) throw new Error("secret leaked into evidence; refusing to write");
    }
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `harness-${this.data.case}-${Date.now()}.json`);
    writeFileSync(file, json + "\n");
    return file;
  }
}

// --- identity --------------------------------------------------------------------------------

// Build/source identity that describes the SAME target the harness runs against (STAGING). For a
// loopback target the runtime flags come from the LOCAL config (not the staging config) and the
// "deployment" is the local source; for the staging origin the flags are DECLARED in
// wrangler.staging.jsonc (an approximation of what is deployed) and the deployed version is the
// newest staging deployment. An unknown deployment version is surfaced (deployedVersionKnown:false)
// rather than silently tolerated.
export async function identity() {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: REPO, stdio: "pipe" }).toString().trim();
    } catch {
      return "unknown";
    }
  };
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
  let isLoopback = false;
  try {
    const h = new URL(STAGING).hostname;
    isLoopback = h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    isLoopback = false;
  }
  let deployedVersion = "unknown";
  let deployedVersionKnown = false;
  let runtimeFlags = [];
  let runtimeFlagsSource = "none";
  if (isLoopback) {
    // Local wrangler dev: the "deployment" is the local source; runtime flags are the LOCAL
    // config's, not the staging config's.
    deployedVersion = "local-dev";
    deployedVersionKnown = true;
    try {
      const config = parseJsonc(readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8"));
      runtimeFlags = config?.compatibility_flags ?? [];
      runtimeFlagsSource = "wrangler.jsonc (local)";
    } catch {
      runtimeFlagsSource = "wrangler.jsonc (local, unreadable)";
    }
  } else {
    // Staging origin: newest staging deployment; flags are DECLARED in wrangler.staging.jsonc.
    try {
      const out = execFileSync(
        "npx",
        ["wrangler", "deployments", "list", "--json", "--config", "wrangler.staging.jsonc"],
        { cwd: REPO, stdio: "pipe", timeout: 90000 },
      ).toString();
      const deployments = JSON.parse(out);
      // The list is ascending by created_on; the newest deployment (last element) is what serves.
      const newest = deployments?.[deployments.length - 1];
      deployedVersion = newest?.versions?.[0]?.version_id ?? "unknown";
      deployedVersionKnown = deployedVersion !== "unknown";
    } catch {
      deployedVersionKnown = false;
    }
    try {
      const config = parseJsonc(readFileSync(path.join(REPO, "wrangler.staging.jsonc"), "utf8"));
      runtimeFlags = config?.compatibility_flags ?? [];
      runtimeFlagsSource = "wrangler.staging.jsonc (declared)";
    } catch {
      runtimeFlagsSource = "wrangler.staging.jsonc (unreadable)";
    }
  }
  return {
    git: { rev: git(["rev-parse", "HEAD"]), dirtyFiles: dirty },
    target: STAGING,
    targetKind: isLoopback ? "loopback" : "staging",
    deployedVersion,
    deployedVersionKnown,
    runtimeFlags,
    runtimeFlagsSource,
    node: process.version,
  };
}
