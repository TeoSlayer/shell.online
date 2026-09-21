import { describe, expect, it, vi } from "vitest";
// Parsed-JSONC config-contract validation, shared with the staging deployment preflight. The
// module is plain ESM (.mjs); vitest resolves it in the Node runtime.
// @ts-expect-error - .mjs module has no type declarations in the Workers type surface
import { validateConfigFile, REQUIRED_COMPATIBILITY_FLAGS } from "../scripts/wrangler-config-contract.mjs";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { BrowserFrameCipher } from "../shared/e2ee";
import { TerminalModel, type Cursor, type WaitResult } from "../shared/terminal-model";
import { withGrantClock } from "./helpers/mcp-clock";

// The only value import from cloudflare:workers is the DurableObject base class. Mock it so the
// DO can be constructed and driven directly in a Node (vitest) environment.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    state: unknown;
    env: unknown;
    constructor(state: unknown, env: unknown) {
      this.state = state;
      this.env = env;
    }
  },
}));

import worker, { TerminalSession } from "../worker/index";

// --- helpers (mirrors tests/mcp-lifecycle.test.ts) --------------------------------------

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeEcdhJwk(kid: string): Promise<string> {
  const pair = await generateKeyPair("ECDH-ES", { extractable: true });
  return JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid });
}

function makeEnv(routeKey: string, frameKey: string) {
  const limiter = { limit: async () => ({ success: true }) };
  const stubDo = { fetch: async () => new Response("ok", { status: 200 }) };
  return {
    SESSIONS: { idFromName: (n: string) => n, get: () => stubDo },
    STATS: { idFromName: (n: string) => n, get: () => stubDo },
    SESSION_CREATION_LIMITER: limiter,
    CONNECTION_LIMITER: limiter,
    EVENT_LIMITER: limiter,
    STATS_AUTH_LIMITER: limiter,
    STATS_PASSWORD: "test-password",
    ANALYTICS: { writeDataPoint: async () => {} },
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    MCP_LIMITER: limiter,
    MCP_ROUTE_KEY: routeKey,
    MCP_FRAME_KEY: frameKey,
  };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > ms) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Force a GC when the process was started with `--expose-gc` (the explicit P01 retention
// regression command: `node --expose-gc node_modules/vitest/vitest.mjs run ... --pool=threads`).
// `--pool=threads` is required: worker_threads inherit `process.execArgv` (so `--expose-gc`
// reaches the worker and global.gc exists), whereas the forks pool filters `process.execArgv`
// down to profiling flags and drops `--expose-gc`, leaving global.gc undefined. Bounded: drain one
// tick, collect twice, drain again — no artificial wait. Returns true when a GC was actually
// forced, false when global.gc is unavailable (the normal `npm run check` run, where the strict
// test still applies and this path is simply skipped). Narrow cast: no new global typings.
async function forceGcIfAvailable(): Promise<boolean> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") return false;
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  gc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return true;
}

function initBody(hostTokenHash: string, opts: { encrypted?: boolean; persistent?: boolean } = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    hostTokenHash,
    readOnly: false,
    encrypted: opts.encrypted ?? false,
    persistent: opts.persistent ?? false,
    label: "observe-session",
    createdAt: now,
    expiresAt: now + 3_600_000,
  };
}

// --- host socket + DO state --------------------------------------------------------------

// A mock host WebSocket the DO can send to (snapshot_request) and receive from (Output/Snapshot
// frames). Captures sent JSON so a test can echo a targeted snapshot back for the routing id the
// DO asked for.
function makeHostSocket() {
  let attachment: Record<string, unknown> = { role: "host", id: 0 };
  const sent: string[] = [];
  return {
    readyState: 1,
    sent,
    serializeAttachment(a: Record<string, unknown>) {
      attachment = a;
    },
    deserializeAttachment() {
      return attachment;
    },
    send(value: string | ArrayBuffer) {
      if (typeof value === "string") sent.push(value);
    },
    close() {},
  };
}

// A mock viewer WebSocket that captures the JSON control messages the DO sends (presence, status).
function makeViewerSocket() {
  let attachment: Record<string, unknown> = { role: "viewer", id: 1, guestNumber: 1 };
  const sent: string[] = [];
  return {
    readyState: 1,
    sent,
    serializeAttachment(a: Record<string, unknown>) {
      attachment = a;
    },
    deserializeAttachment() {
      return attachment;
    },
    send(value: string | ArrayBuffer) {
      if (typeof value === "string") sent.push(value);
    },
    close() {},
  };
}

// The DO's webSocketMessage/webSocketClose take the Cloudflare WebSocket type; the mock socket is
// structurally narrower, so cast at the call boundary.
const asWs = (s: ReturnType<typeof makeHostSocket>) => s as unknown as WebSocket;

// The DO's webSocketMessage is typed string | ArrayBuffer (it wraps the message in a fresh
// Uint8Array); hand it an exact-length ArrayBuffer copy of the frame.
const wsFrame = (frame: Uint8Array) => new Uint8Array(frame).buffer as ArrayBuffer;

function makeStateWithHost(idName: string, hostSocket: unknown) {
  const store = new Map<string, unknown>();
  return {
    id: { name: idName, toString: () => idName },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      deleteAll: async () => {
        store.clear();
      },
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
    getWebSockets: (role?: string) => (role === "host" ? [hostSocket] : []),
    waitUntil: () => {},
    acceptWebSocket: () => {},
  };
}

async function makeDoWithHost(
  sessionId: string,
  hostSocket: unknown,
): Promise<{ do: TerminalSession; routeKey: string; frameKey: string }> {
  const route = await makeEcdhJwk("route-v1");
  const frame = await makeEcdhJwk("frame-v1");
  const do_ = new TerminalSession(makeStateWithHost(sessionId, hostSocket) as never, makeEnv(route, frame) as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { do: do_, routeKey: route, frameKey: frame };
}

// A DO state that also exposes a viewer socket, so a test can capture the presence broadcast.
function makeStateWithViewer(idName: string, hostSocket: unknown, viewerSocket: unknown) {
  const base = makeStateWithHost(idName, hostSocket);
  return {
    ...base,
    getWebSockets: (role?: string) => (role === "host" ? [hostSocket] : role === "viewer" ? [viewerSocket] : []),
  };
}

async function makeDoWithHostAndViewer(
  sessionId: string,
  hostSocket: unknown,
  viewerSocket: unknown,
): Promise<{ do: TerminalSession; routeKey: string; frameKey: string }> {
  const route = await makeEcdhJwk("route-v1");
  const frame = await makeEcdhJwk("frame-v1");
  const do_ = new TerminalSession(makeStateWithViewer(sessionId, hostSocket, viewerSocket) as never, makeEnv(route, frame) as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { do: do_, routeKey: route, frameKey: frame };
}

// --- frame builders ----------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
}

// [0x01][payload]
function plainOutput(payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x01]), payload);
}

// [0x03][targetId(4,BE)][payload]
function plainTargetedSnapshot(targetId: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = 0x03;
  new DataView(header.buffer).setUint32(1, targetId);
  return concat(header, payload);
}

// [0x01][version][nonce][ct] (AES-GCM, AAD=[0x01])
async function sealedOutput(cipher: BrowserFrameCipher, payload: Uint8Array): Promise<Uint8Array> {
  return cipher.seal(concat(new Uint8Array([0x01]), payload));
}

// [0x03][targetId(4,BE)][version][nonce][ct] — the 5-byte routing header stays in the clear; only
// the payload is encrypted (AAD=[0x03]), matching the Go host's targeted-snapshot seal.
async function sealedTargetedSnapshot(cipher: BrowserFrameCipher, targetId: number, payload: Uint8Array): Promise<Uint8Array> {
  const sealed = await cipher.seal(concat(new Uint8Array([0x03]), payload));
  const result = new Uint8Array(4 + sealed.byteLength);
  result[0] = 0x03;
  new DataView(result.buffer).setUint32(1, targetId);
  result.set(sealed.subarray(1), 5);
  return result;
}

// --- MCP via the Worker route (the real edge: outer verify, wrappedKey forward) ----------

function workerMcpRequest(bearer: string, body: string, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("https://shell.online/mcp", {
    method: "POST",
    headers: {
      Host: "shell.online",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body,
    signal,
  });
}

function makeWorkerEnv(routeKey: string, do_: TerminalSession) {
  const limiter = { limit: async () => ({ success: true }) };
  return {
    MCP_LIMITER: limiter,
    MCP_ROUTE_KEY: routeKey,
    SESSIONS: {
      getByName: () => ({
        fetch: (url: string, init?: RequestInit) => do_.fetch(new Request(url, init)),
      }),
    },
  };
}

const ctxShim = { waitUntil: () => {} };

function workerFetch(routeKey: string, do_: TerminalSession, request: Request): Promise<Response> {
  return worker.fetch(request as never, makeWorkerEnv(routeKey, do_) as never, ctxShim as never);
}

// Parse the SSE response into the tool's JSON result (the DO returns an SSE stream with a single
// data line carrying the JSON-RPC response).
async function toolResult(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no data line in response: ${body.slice(0, 200)}`);
  const rpc = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { content: Array<{ type: string; text: string }> };
    error?: { message: string };
  };
  if (rpc.error) throw new Error(`tool error: ${rpc.error.message}`);
  if (!rpc.result) throw new Error(`no result in response: ${dataLine}`);
  return JSON.parse(rpc.result.content[0].text) as Record<string, unknown>;
}

// Call an observe tool through the Worker route, capture the DO's snapshot_request, and echo a
// targeted snapshot back for the requested routing id so the cold-start seed resolves. Returns the
// tool's parsed result.
async function seedModel(
  do_: TerminalSession,
  hostSocket: ReturnType<typeof makeHostSocket>,
  routeKey: string,
  bearer: string,
  toolCall: string,
  snapshotPayload: Uint8Array,
  cipher?: BrowserFrameCipher,
): Promise<Record<string, unknown>> {
  const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, toolCall));
  await waitFor(() => hostSocket.sent.some((m) => m.includes("snapshot_request")), 2000, "snapshot_request");
  const req = hostSocket.sent.find((m) => m.includes("snapshot_request"))!;
  const targetId = (JSON.parse(req) as { viewerId: number }).viewerId;
  const frame = cipher
    ? await sealedTargetedSnapshot(cipher, targetId, snapshotPayload)
    : plainTargetedSnapshot(targetId, snapshotPayload);
  await do_.webSocketMessage(asWs(hostSocket), wsFrame(frame));
  return toolResult(await withTimeout(mcpPromise, 4000));
}

function call(name: string, id: number, arguments_: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } });
}

// --- tests -------------------------------------------------------------------------------

describe("MCP observe surface (DO wiring)", () => {
  it("--no-e2ee: shell_screen seeds from a targeted host snapshot", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_NOE2EE_SCREEN", hostSocket);
    const hostToken = "host-token-screen";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    const result = await seedModel(do_, hostSocket, routeKey, bearer, call("shell_screen", 1, {}), enc("HELLO_SCREEN\nREADY\n"));
    expect(result.status).toBe("waiting");
    expect(result.fresh).toBe(true);
    expect(result.text).toContain("HELLO_SCREEN");
    expect(result.text).toContain("READY");
  });

  it("--no-e2ee: shell_output returns only new output after a cursor", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_NOE2EE_OUTPUT", hostSocket);
    const hostToken = "host-token-output";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Seed the model (also returns the current offset as the cursor baseline).
    const seeded = await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("BASELINE\n"));
    expect(seeded.text).toContain("BASELINE");
    const epoch = seeded.epoch as number;
    const offset = seeded.offset as number;
    expect(offset).toBeGreaterThan(0);

    // New output arrives after the cursor.
    await do_.webSocketMessage(asWs(hostSocket), wsFrame(plainOutput(enc("MORE_OUTPUT\n"))));
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget append settle.

    const result = await toolResult(
      await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_output", 2, { cursor: { epoch, offset } }))), 4000),
    );
    expect(result.text).toContain("MORE_OUTPUT");
    expect(result.text).not.toContain("BASELINE");
    expect(result.reset).toBe(false);
    expect(result.epoch).toBe(epoch);
  });

  it("--no-e2ee: shell_wait matches new output and reports the match", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_NOE2EE_WAIT", hostSocket);
    const hostToken = "host-token-wait";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Seed the model so the wait reuses it (no second snapshot round-trip).
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));

    // Start the wait (pending). Then stream matching output; the first frame after the baseline
    // settles the wait.
    const waitPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 2, { pattern: "DONE" })));
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      await do_.webSocketMessage(asWs(hostSocket), wsFrame(plainOutput(enc("DONE\n"))));
    }
    const result = await toolResult(await withTimeout(waitPromise, 4000));
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("matched");
    expect(result.text).toContain("DONE");
  });

  it("encrypted: unwraps the frame key and decrypts host frames", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_E2EE_DECRYPT", hostSocket);
    const hostToken = "host-token-e2ee";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { encrypted: true })));

    const frameKey = crypto.getRandomValues(new Uint8Array(32));
    const grantRes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 60, frame_key: base64url.encode(frameKey) },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // The host seals frames with the session frame key.
    const cipher = await BrowserFrameCipher.fromKey(new Uint8Array(frameKey));

    const seeded = await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("E2EE_SEED\n"), cipher);
    expect(seeded.text).toContain("E2EE_SEED");

    await do_.webSocketMessage(asWs(hostSocket), wsFrame(await sealedOutput(cipher, enc("E2EE_OUTPUT\n"))));
    await new Promise((r) => setTimeout(r, 20));

    const result = await toolResult(
      await withTimeout(
        workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_output", 2, { cursor: { epoch: seeded.epoch, offset: seeded.offset } }))),
        4000,
      ),
    );
    expect(result.text).toContain("E2EE_OUTPUT");
  });

  it("shell_wait: a second concurrent wait from the same grant is limited", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_WAIT_LIMIT", hostSocket);
    const hostToken = "host-token-waitlimit";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Seed the model so the waits reuse it (no snapshot round-trip).
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));

    // First wait is in flight (no matching output yet, so it stays pending).
    const firstWait = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 2, { pattern: "NEVER", timeout_ms: 2000 })));
    await new Promise((r) => setTimeout(r, 30)); // let the first wait register.

    // Second wait from the same grant is limited (one in flight per grant).
    const second = await toolResult(
      await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 3, { pattern: "ALSO", timeout_ms: 1000 }))), 4000),
    );
    expect(second.matched).toBe(false);
    expect(second.reason).toBe("limit");

    // Let the first wait time out so the slot is released.
    await withTimeout(firstWait, 4000);
  });

  it("frees the ephemeral model when the last host disconnects", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_LIFECYCLE_FREE", hostSocket);
    const hostToken = "host-token-lc";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as { mcpModel: unknown };
    expect(doAny.mcpModel).not.toBeNull();

    await do_.webSocketClose(asWs(hostSocket), 1000, "normal", true);
    expect(doAny.mcpModel).toBeNull();
  });
});

describe("MCP presence + live-run audit (DO wiring)", () => {
  it("records a metadata-only audit entry for an MCP call", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_AUDIT_RECORD", hostSocket);
    const hostToken = "host-token-audit";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "codex" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer, grant_id } = (await grantRes.json()) as { bearer: string; grant_id: string };

    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));

    const doAny = do_ as unknown as { mcpAudit: Array<Record<string, unknown>> };
    expect(doAny.mcpAudit.length).toBeGreaterThanOrEqual(1);
    const entry = doAny.mcpAudit[doAny.mcpAudit.length - 1];
    expect(entry.grantId).toBe(grant_id);
    expect(entry.label).toBe("codex");
    expect(entry.tool).toBe("shell_output");
    expect(entry.scopes).toEqual(["observe"]);
    expect(entry.outcome).toBe("ok");
    expect(typeof entry.requestBytes).toBe("number");
    expect(typeof entry.durationMs).toBe("number");
    // Metadata only: no request/response content, bearer, or session id in the entry.
    const serialized = JSON.stringify(entry).toLowerCase();
    for (const marker of ["seed", "bearer", "obs_audit_record"]) expect(serialized).not.toContain(marker);
  });

  it("retains the audit trail (revocation history) but clears presence on revoke-all", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("OBS_AUDIT_CLEAR", hostSocket);
    const hostToken = "host-token-clear";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "opencode" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as { mcpAudit: Array<Record<string, unknown>>; mcpActivity: Map<string, unknown> };
    expect(doAny.mcpAudit.length).toBeGreaterThanOrEqual(1);
    expect(doAny.mcpActivity.size).toBeGreaterThanOrEqual(1);

    const revokeRes = await do_.fetch(
      new Request("https://shell.online/internal/mcp/grants", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${hostToken}` },
      }),
    );
    expect(revokeRes.status).toBe(200);
    // The audit trail is RETAINED on revoke-all (the revocation event stays visible to an auditor
    // until the run truly ends); the presence activity is cleared (no further MCP calls possible).
    expect(doAny.mcpAudit.length).toBeGreaterThanOrEqual(2);
    const lastEntry = doAny.mcpAudit[doAny.mcpAudit.length - 1];
    expect(lastEntry.kind).toBe("revoked");
    expect(doAny.mcpActivity.size).toBe(0);
  });

  it("includes active agents in the presence broadcast", async () => {
    const hostSocket = makeHostSocket();
    const viewerSocket = makeViewerSocket();
    const { do: do_, routeKey } = await makeDoWithHostAndViewer("OBS_PRESENCE_AGENT", hostSocket, viewerSocket);
    const hostToken = "host-token-presence";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "claude" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // An MCP call touches the grant's activity and broadcasts presence to the viewer.
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));

    // The MCP call's presence broadcast includes the active agent (the grant with a live activity
    // lease). The earlier grant-issuance broadcast has no active agent yet.
    const presence = viewerSocket.sent
      .map((m) => JSON.parse(m) as { type?: string; agents?: Array<{ label: string }> })
      .filter((m) => m.type === "presence" && Array.isArray(m.agents))
      .find((m) => m.agents!.length > 0);
    expect(presence).toBeDefined();
    expect(presence!.agents).toEqual([{ label: "claude" }]);
  });
});

// --- Phase 2 regression findings (failure-reproduced) --------------------------------------
// Each test reproduces a reviewer finding. They are written to FAIL against the pre-fix code and
// pass once the corresponding implementation fix lands. Access to DO internals uses a typed cast.

type DoInternals = {
  mcpModel: unknown;
  mcpCipher: unknown;
  mcpModelInit: unknown;
  mcpWaitCount: number;
  mcpWaitInflight: Map<string, number>;
  mcpInflight: Map<string, number>;
  mcpInflightTotal: number;
  mcpActivity: Map<string, { label: string; lastActivityAt: number }>;
  mcpAudit: Array<Record<string, unknown>>;
  mcpExpiryRetireTimer: unknown;
  mcpEnforceActivityBound: () => void;
  mcpGrants: Array<{ runId: string; grantId: string; expiresAt: number; revoked: boolean }>;
};

describe("Phase 2 regressions: model lifecycle + waits + audit", () => {
  async function makeGrantDo(sessionId: string, lifetime: number, label: string) {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost(sessionId, hostSocket);
    const hostToken = `host-token-${sessionId}`;
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime, label }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const grant = (await grantRes.json()) as { bearer: string; grant_id: string };
    return { do: do_, routeKey, hostSocket, hostToken, ...grant };
  }

  it("all observe tools expose read-only annotations (no per-tool approval workaround)", async () => {
    const { do: do_, routeKey, bearer } = await makeGrantDo("OBS_ANNOTATIONS", 60, "ann");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const response = await workerFetch(routeKey, do_, workerMcpRequest(bearer, body));
    expect(response.status).toBe(200);
    const text = await response.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error(`no data line in response: ${text.slice(0, 200)}`);
    const rpc = JSON.parse(dataLine.slice("data: ".length)) as {
      result?: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> };
      error?: { message: string };
    };
    if (rpc.error) throw new Error(`tools/list error: ${rpc.error.message}`);
    const byName = new Map((rpc.result?.tools ?? []).map((t) => [t.name, t]));
    for (const name of ["shell_status", "shell_screen", "shell_output", "shell_wait"]) {
      const tool = byName.get(name);
      expect(tool, `tool ${name} listed`).toBeDefined();
      expect(tool!.annotations, `${name} annotations`).toEqual({ readOnlyHint: true, openWorldHint: false });
    }
  });

  it("request-concurrency caps: 4/grant and 16/session return 429 (Retry-After 1), separate from wait limits", async () => {
    const { do: do_, routeKey, bearer, grant_id: grantId } = await makeGrantDo("CC_CAPS", 60, "cc");
    const doAny = do_ as unknown as DoInternals;

    // Per-grant cap: 4 in-flight on this grant -> the next request is 429 (Retry-After 1).
    doAny.mcpInflight.set(grantId, 4);
    doAny.mcpInflightTotal = 4;
    let res = await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_status", 1, {})));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.text()).toContain("too many concurrent MCP requests");

    // Per-session cap: 16 in-flight total -> the next request (even on a grant with 0 of its own)
    // is 429. This is a DIFFERENT counter than the per-grant one and the wait limits.
    doAny.mcpInflight.set(grantId, 0);
    doAny.mcpInflightTotal = 16;
    res = await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_status", 2, {})));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");

    // Below both caps: admitted (200), proving the cap is not over-blocking.
    doAny.mcpInflight.set(grantId, 0);
    doAny.mcpInflightTotal = 0;
    res = await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_status", 3, {})));
    expect(res.status).toBe(200);
  });

  it("F1: grant expiry retires the model WITHOUT another MCP request", () => withGrantClock(async (expire) => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("F1_EXPIRY_RETIRE", 1, "f1");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    expect(doAny.mcpModel).not.toBeNull();
    // No further MCP request is sent. The model must be retired when the 1s grant expires.
    expire(1);
    await waitFor(() => doAny.mcpModel === null, 3000, "model retirement on expiry");
    expect(doAny.mcpModel).toBeNull();
    expect(doAny.mcpCipher).toBeNull();
    expect(doAny.mcpExpiryRetireTimer ?? null).toBeNull();
  }));

  it("F1b: encrypted model allocated after DO reconstruction is retired on grant expiry", () => withGrantClock(async (expire) => {
    // Shared durable storage across a "reconstruction" (a fresh DO instance reloading the same
    // storage). The constructor reloads grants from storage; pre-fix it never rescheduled the
    // expiry-retire timer, so a model allocated after reconstruction outlived its last grant.
    const store = new Map<string, unknown>();
    const hostSocket = makeHostSocket();
    const route = await makeEcdhJwk("route-v1");
    const frame = await makeEcdhJwk("frame-v1");
    const env = makeEnv(route, frame) as never;
    const stateFor = (idName: string) => ({
      id: { name: idName, toString: () => idName },
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value); },
        delete: async (key: string) => { store.delete(key); },
        deleteAll: async () => { store.clear(); },
        setAlarm: async () => {},
      },
      blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
      getWebSockets: (role?: string) => (role === "host" ? [hostSocket] : []),
      waitUntil: () => {},
      acceptWebSocket: () => {},
    });

    const frameKey = crypto.getRandomValues(new Uint8Array(32));
    const cipher = await BrowserFrameCipher.fromKey(new Uint8Array(frameKey));
    const hostToken = "host-token-f1recon";

    // Original DO: init (encrypted) + create a short grant carrying the frame key. The grant is
    // persisted to durable storage, which a reconstructed DO reloads in its constructor.
    const do1 = new TerminalSession(stateFor("F1_RECONSTRUCT") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await do1.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { encrypted: true })));
    const grantRes = await do1.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 2, label: "f1recon", frame_key: base64url.encode(frameKey) }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Reconstructed DO: a fresh instance over the SAME storage + host socket. The constructor
    // reloads the grant (with its frame key) but, pre-fix, never schedules the expiry timer.
    const do2 = new TerminalSession(stateFor("F1_RECONSTRUCT") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const doAny = do2 as unknown as DoInternals;

    // An MCP call to the reconstructed DO allocates the encrypted model (seeded from the host).
    await seedModel(do2, hostSocket, route, bearer, call("shell_output", 1, {}), enc("SEED\n"), cipher);
    expect(doAny.mcpModel).not.toBeNull();
    expect(doAny.mcpCipher).not.toBeNull();

    // No further MCP request is sent. The reconstructed model must be retired when the grant
    // expires — the expiry timer was restored on allocation, so no MCP request is needed.
    expire(2);
    await waitFor(() => doAny.mcpModel === null, 4000, "reconstructed model retirement on expiry");
    expect(doAny.mcpModel).toBeNull();
    expect(doAny.mcpCipher).toBeNull();
  }));

  it("Gap4: reconstruction with a LIVE grant re-seeds a new epoch and preserves the grant expiry", async () => {
    // The G6 cold-path gate: a Worker instance can be reconstructed while a grant is still live
    // (timers prevent hibernation, not every restart). The reconstructed DO must re-seed the model
    // from a fresh host snapshot with a NEW epoch, and the grant's original expiry must be
    // preserved (the grant is still live after the reconstruction).
    const store = new Map<string, unknown>();
    const hostSocket = makeHostSocket();
    const route = await makeEcdhJwk("route-v1");
    const frame = await makeEcdhJwk("frame-v1");
    const env = makeEnv(route, frame) as never;
    const stateFor = (idName: string) => ({
      id: { name: idName, toString: () => idName },
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value); },
        delete: async (key: string) => { store.delete(key); },
        deleteAll: async () => { store.clear(); },
        setAlarm: async () => {},
      },
      blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
      getWebSockets: (role?: string) => (role === "host" ? [hostSocket] : []),
      waitUntil: () => {},
      acceptWebSocket: () => {},
    });

    const hostToken = "host-token-gap4";

    // Original DO: init + create a long-lived grant (still live after the reconstruction).
    const do1 = new TerminalSession(stateFor("GAP4_RECON") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await do1.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do1.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 300, label: "gap4" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Seed the model on the original DO (capture the epoch).
    const seeded = await seedModel(do1, hostSocket, route, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const epochBefore = seeded.epoch as number;
    expect(epochBefore).toBeGreaterThan(0);

    // Reconstructed DO: a fresh instance over the SAME storage + host socket. The grant is still
    // live (300s lifetime), so the reconstruction preserves the grant's original expiry.
    const do2 = new TerminalSession(stateFor("GAP4_RECON") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const doAny = do2 as unknown as DoInternals;

    // Clear the captured host messages so seedModel finds the reconstructed DO's snapshot_request.
    hostSocket.sent.length = 0;

    // The next authorized read on the reconstructed DO must re-seed the model from a fresh host
    // snapshot with a NEW epoch (the cold path).
    const reseeded = await seedModel(do2, hostSocket, route, bearer, call("shell_output", 1, {}), enc("RESEED\n"));
    const epochAfter = reseeded.epoch as number;
    expect(epochAfter).toBeGreaterThan(0);
    expect(epochAfter).not.toBe(epochBefore); // new epoch (fresh snapshot)
    expect(reseeded.text).toContain("RESEED");

    // The grant's original expiry is preserved (the grant is still live after the reconstruction).
    const meta = (doAny as unknown as { meta: { runId: string } }).meta;
    const grant = doAny.mcpGrants.find((g) => g.runId === meta.runId);
    expect(grant).toBeDefined();
    expect(grant!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000)); // still live
  });

  it("Gap1: expiry DURING reconstructed seeding frees the model/cipher (no later decryption)", () => withGrantClock(async (expire) => {
    // The proactive timer can't catch this: the snapshot is held until the grant has already
    // lapsed, so by the time the seed resolves there is no live grant left to schedule against.
    // The model/cipher must be freed at the end of initialization, not left allocated to decrypt
    // subsequent frames for a later grant.
    const store = new Map<string, unknown>();
    const hostSocket = makeHostSocket();
    const route = await makeEcdhJwk("route-v1");
    const frame = await makeEcdhJwk("frame-v1");
    const env = makeEnv(route, frame) as never;
    const stateFor = (idName: string) => ({
      id: { name: idName, toString: () => idName },
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value); },
        delete: async (key: string) => { store.delete(key); },
        deleteAll: async () => { store.clear(); },
        setAlarm: async () => {},
      },
      blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
      getWebSockets: (role?: string) => (role === "host" ? [hostSocket] : []),
      waitUntil: () => {},
      acceptWebSocket: () => {},
    });

    const frameKey = crypto.getRandomValues(new Uint8Array(32));
    const cipher = await BrowserFrameCipher.fromKey(new Uint8Array(frameKey));
    const hostToken = "host-token-gap1";

    // Original DO: init (encrypted) + create a 1s grant carrying the frame key.
    const do1 = new TerminalSession(stateFor("GAP1_RECON") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await do1.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { encrypted: true })));
    const grantRes = await do1.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 1, label: "gap1", frame_key: base64url.encode(frameKey) }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Reconstructed DO over the same storage.
    const do2 = new TerminalSession(stateFor("GAP1_RECON") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const doAny = do2 as unknown as DoInternals;

    // Start a read, but hold the snapshot until the 1s grant has expired.
    const readPromise = workerFetch(route, do2, workerMcpRequest(bearer, call("shell_output", 1, {})));
    await waitFor(() => hostSocket.sent.some((m) => m.includes("snapshot_request")), 2000, "snapshot_request");
    const req = hostSocket.sent.find((m) => m.includes("snapshot_request"))!;
    const targetId = (JSON.parse(req) as { viewerId: number }).viewerId;
    // Hold the snapshot past the grant's 1s expiry (the seed stays in flight the whole time).
    expire(1);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    // Release the snapshot: the seed completes, but the grant has already expired.
    await do2.webSocketMessage(asWs(hostSocket), wsFrame(await sealedTargetedSnapshot(cipher, targetId, enc("SEED\n"))));
    // The tool denies access (no live grant): it either throws (execution-time recheck) or returns
    // a disconnected result. Either way the read must NOT succeed with fresh content.
    let denied = false;
    try {
      const result = await toolResult(await withTimeout(readPromise, 4000));
      denied = result.fresh === false;
    } catch {
      denied = true; // the tool threw (recheck failed)
    }
    expect(denied).toBe(true);
    // The model/cipher must be freed (no live grant remains), so no later grant can decrypt with it.
    expect(doAny.mcpModel).toBeNull();
    expect(doAny.mcpCipher).toBeNull();
  }));

  it("F1r4: expiry during seeding frees model BEFORE snapshot arrives (no decryption of intervening frames)", () => withGrantClock(async (expire) => {
    // The model+cipher are allocated before the snapshot await. If the grant expires during the
    // await, the expiry timer (scheduled before the await) must fire and free the model/cipher,
    // so that any frame arriving in that window is NOT decrypted.
    const store = new Map<string, unknown>();
    const hostSocket = makeHostSocket();
    const route = await makeEcdhJwk("route-v1");
    const frame = await makeEcdhJwk("frame-v1");
    const env = makeEnv(route, frame) as never;
    const stateFor = (idName: string) => ({
      id: { name: idName, toString: () => idName },
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value); },
        delete: async (key: string) => { store.delete(key); },
        deleteAll: async () => { store.clear(); },
        setAlarm: async () => {},
      },
      blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
      getWebSockets: (role?: string) => (role === "host" ? [hostSocket] : []),
      waitUntil: () => {},
      acceptWebSocket: () => {},
    });

    const frameKey = crypto.getRandomValues(new Uint8Array(32));
    const cipher = await BrowserFrameCipher.fromKey(new Uint8Array(frameKey));
    const hostToken = "host-token-f1r4";

    // Original DO: init (encrypted) + create a 1s grant carrying the frame key.
    const do1 = new TerminalSession(stateFor("F1R4_RECON") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await do1.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { encrypted: true })));
    const grantRes = await do1.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 1, label: "f1r4", frame_key: base64url.encode(frameKey) }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Reconstructed DO over the same storage.
    const do2 = new TerminalSession(stateFor("F1R4_RECON") as never, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const doAny = do2 as unknown as DoInternals;

    // Start a read, but hold the snapshot until the 1s grant has expired.
    const readPromise = workerFetch(route, do2, workerMcpRequest(bearer, call("shell_output", 1, {})));
    await waitFor(() => hostSocket.sent.some((m) => m.includes("snapshot_request")), 2000, "snapshot_request");
    const req = hostSocket.sent.find((m) => m.includes("snapshot_request"))!;
    const targetId = (JSON.parse(req) as { viewerId: number }).viewerId;

    // Hold the snapshot past the grant's 1s expiry. The expiry timer (scheduled before the
    // snapshot await) fires and frees the model/cipher — BEFORE the snapshot arrives.
    expire(1);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    // The model/cipher must be freed by the expiry timer (not by the seed completing).
    expect(doAny.mcpModel).toBeNull();
    expect(doAny.mcpCipher).toBeNull();

    // An Output frame arriving in this window must NOT be decrypted (model is null).
    const outputFrame = await sealedOutput(cipher, enc("INTERVENING\n"));
    await do2.webSocketMessage(asWs(hostSocket), wsFrame(outputFrame));
    // The model is still null (the frame was not appended).
    expect(doAny.mcpModel).toBeNull();

    // Release the snapshot: the seed completes, but the model is already freed.
    await do2.webSocketMessage(asWs(hostSocket), wsFrame(await sealedTargetedSnapshot(cipher, targetId, enc("SEED\n"))));
    // The tool denies access (no live grant).
    let denied = false;
    try {
      const result = await toolResult(await withTimeout(readPromise, 4000));
      denied = result.fresh === false;
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    // The model/cipher remain freed.
    expect(doAny.mcpModel).toBeNull();
    expect(doAny.mcpCipher).toBeNull();
  }));

  it("F4: concurrent reads share ONE snapshot init and both get a seeded model", async () => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("F4_CONCURRENT_SEED", 60, "f4");
    const doAny = do_ as unknown as DoInternals;
    // Two concurrent reads: both find no model and must await the SAME in-flight seed.
    const read1 = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_output", 1, {})));
    const read2 = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_output", 2, {})));
    // Hold the snapshot: the seed stays in flight (mcpModelInit set) until we release it, so this
    // is deterministic and does not depend on any other test having seeded the model first.
    await waitFor(() => hostSocket.sent.some((m) => m.includes("snapshot_request")), 2000, "snapshot_request");
    const snapshotRequests = hostSocket.sent.filter((m) => m.includes("snapshot_request"));
    expect(snapshotRequests.length).toBe(1); // only ONE snapshot was requested for two reads
    // While the snapshot is held, the seed is in flight: the model is allocated but not yet
    // seeded, so neither read can complete (both await the same in-flight seed) and
    // fresh_model_available is false. (The Response object is returned eagerly; the tool result —
    // and thus completion — only happens when the seed resolves, which we hold.)
    expect(doAny.mcpModelInit).not.toBeNull(); // seed in flight
    const statusInFlight = await toolResult(await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_status", 3, {}))), 4000));
    expect((statusInFlight.run as { fresh_model_available: boolean }).fresh_model_available).toBe(false);
    // Release the snapshot: both reads complete with the SAME seeded model.
    const targetId = (JSON.parse(snapshotRequests[0]) as { viewerId: number }).viewerId;
    await do_.webSocketMessage(asWs(hostSocket), wsFrame(plainTargetedSnapshot(targetId, enc("SEED\n"))));
    const r1 = await toolResult(await withTimeout(read1, 4000));
    const r2 = await toolResult(await withTimeout(read2, 4000));
    expect(r1.fresh).toBe(true);
    expect(r2.fresh).toBe(true);
    expect(r1.epoch).toBe(r2.epoch); // the SAME model, not two independently seeded ones
    expect(r1.text).toContain("SEED");
    expect(r2.text).toContain("SEED");
    // Now allocated AND seeded: fresh_model_available is true.
    const statusSeeded = await toolResult(await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_status", 4, {}))), 4000));
    expect((statusSeeded.run as { fresh_model_available: boolean }).fresh_model_available).toBe(true);
  });

  it("F5: waits are limited by concurrency, not lifetime — more than 8 sequential waits succeed", async () => {
    const { do: do_, routeKey, hostSocket, bearer, grant_id } = await makeGrantDo("F5_WAIT_LIMIT", 60, "f5");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    // 10 sequential waits: each completes (times out) before the next starts, so the concurrent
    // session counter returns to zero each time and none is limited. The old lifetime counter
    // wrongly limited the 9th.
    for (let i = 0; i < 10; i += 1) {
      const r = await toolResult(await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", i + 2, { pattern: "NEVER", timeout_ms: 25 }))), 4000));
      expect(r.reason).toBe("timeout");
      expect(doAny.mcpWaitCount).toBe(0); // concurrent counter returns to zero on completion
    }
    // The concurrent limit is still enforced: a second wait from the same grant while one is
    // pending is limited (one in flight per grant).
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 20, { pattern: "NEVER", timeout_ms: 500 })));
    await waitFor(() => doAny.mcpWaitCount === 1, 1000, "first wait admitted");
    const second = await toolResult(await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 21, { pattern: "NEVER", timeout_ms: 100 }))), 4000));
    expect(second.reason).toBe("limit");
    // Consume the first wait's body so the pending wait settles (times out) and releases its slot.
    const firstResp = await withTimeout(first, 2000);
    await firstResp.text();
    expect(doAny.mcpWaitCount).toBe(0);
    expect(doAny.mcpWaitInflight.get(grant_id)).toBe(0);
  });

  it("F6: client abort at the edge stops a pending wait and releases the inflight slot", async () => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("F6_ABORT_STOPS", 60, "f6");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    // A long wait that would otherwise run to its 45s cap. The request carries an AbortSignal the
    // test controls; the Worker forwards it to the DO, which keys client cancellation off it.
    const controller = new AbortController();
    const responsePromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 1, { pattern: "NEVER", timeout_ms: 45_000 }), {}, controller.signal));
    await waitFor(() => doAny.mcpInflightTotal === 1, 1000, "wait admitted");
    // The MCP client drops the connection: the pending wait must settle (cancelled) and the slot
    // must be released promptly, not held until the 45s cap.
    controller.abort();
    const response = await withTimeout(responsePromise, 4000);
    // Consume the (now settled) response fully so the wrapped body releases its accounting.
    const body = await response.text();
    expect(doAny.mcpInflightTotal).toBe(0);
    // The wait settled as cancelled (not matched/timeout), proving the abort stopped the pending work.
    expect(body).toContain("cancelled");
  });

  it("F6b: cancelling the response body (not request.signal) settles the wait and records 'cancelled'", async () => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("F6_RESP_CANCEL", 60, "f6b");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    // A long wait (45s cap). The client receives the response but drops the BODY (not the request
    // signal): the pending wait must settle as cancelled, the slot must release, and the audit
    // must record "cancelled" (not "ok" from the 200 status).
    const response = await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 1, { pattern: "NEVER", timeout_ms: 45_000 }))), 4000);
    await waitFor(() => doAny.mcpInflightTotal === 1, 1000, "wait admitted");
    const reader = response.body!.getReader();
    await reader.cancel();
    await waitFor(() => doAny.mcpInflightTotal === 0, 2000, "slot released on body cancel");
    expect(doAny.mcpInflightTotal).toBe(0);
    const cancelled = doAny.mcpAudit.find((e) => e.outcome === "cancelled");
    expect(cancelled).toBeDefined();
  });

  it("F7: audit records the tool's completion outcome, not just the HTTP status", async () => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("F7_AUDIT_OUTCOME", 60, "f7");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    const before = doAny.mcpAudit.length;
    // A wait that times out: the HTTP response is still 200 (ok), but the tool outcome is "timeout".
    await toolResult(await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 1, { pattern: "NEVER", timeout_ms: 25 }))), 4000));
    const entry = doAny.mcpAudit[doAny.mcpAudit.length - 1];
    expect(doAny.mcpAudit.length).toBeGreaterThan(before);
    expect(entry.tool).toBe("shell_wait");
    expect(entry.outcome).toBe("timeout"); // actual completion outcome, not the HTTP "ok"
  });

  it("F7b: a grant revoked mid-wait is audited as 'revoked', not 'ok'", async () => {
    const { do: do_, routeKey, hostSocket, hostToken, bearer, grant_id } = await makeGrantDo("F7_REVOKED", 60, "f7b");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    // A long wait (45s cap). Revoke the grant mid-wait: the wait settles, the execution-time
    // recheck fails, and the audit must record "revoked" (not the 200-status "ok" fallback).
    const waitPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 1, { pattern: "NEVER", timeout_ms: 45_000 })));
    await waitFor(() => doAny.mcpInflightTotal === 1, 1000, "wait admitted");
    await do_.fetch(new Request("https://shell.online/internal/mcp/grant", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ grant_id }),
    }));
    const response = await withTimeout(waitPromise, 4000);
    await response.text(); // consume the body so the audit is recorded at delivery
    const entry = doAny.mcpAudit[doAny.mcpAudit.length - 1];
    expect(entry.tool).toBe("shell_wait");
    expect(entry.outcome).toBe("revoked");
  });

  it("F7c: grant expiry records an 'expired' lifecycle audit event", () => withGrantClock(async (expire) => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("F7_EXPIRED", 1, "f7c");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    // When the 1s grant expires, the model is retired and an "expired" lifecycle event is recorded.
    expire(1);
    await waitFor(() => doAny.mcpModel === null, 3000, "model retirement on expiry");
    const expired = doAny.mcpAudit.find((e) => e.kind === "expired");
    expect(expired).toBeDefined();
  }));

  it("Gap2a: revoking the last grant mid-wait does NOT drive mcpWaitCount negative", async () => {
    const { do: do_, routeKey, hostSocket, hostToken, bearer, grant_id } = await makeGrantDo("GAP2_NEGATIVE", 60, "gap2a");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    // A long wait. Revoke the (only) grant mid-wait: mcpMaybeFreeModel resets the counter to 0.
    // The wait's finally block must NOT decrement again (generation mismatch) — pre-fix it drove
    // mcpWaitCount to -1, corrupting the freshly-reset state.
    const waitPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 1, { pattern: "NEVER", timeout_ms: 45_000 })));
    await waitFor(() => doAny.mcpWaitCount === 1, 1000, "wait admitted");
    await do_.fetch(new Request("https://shell.online/internal/mcp/grant", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
      body: JSON.stringify({ grant_id }),
    }));
    const response = await withTimeout(waitPromise, 4000);
    await response.text(); // consume the body so the wait settles
    expect(doAny.mcpWaitCount).toBe(0);
    expect(doAny.mcpWaitInflight.size).toBe(0);
  });

  it("Gap2b: a late completion from a cancelled grant drops NO audit entry into a resumed run", async () => {
    // Persistent session: the run can be resumed, which cancels in-flight MCP requests and clears
    // run-scoped state (audit, counters, generations). A wait in flight at resume time settles
    // AFTER the reset, so its late completion (finally block + audit) must not mutate the new run's
    // state (generation mismatch) — pre-fix it drove mcpWaitCount negative and dropped an old-grant
    // audit entry into the new run.
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("GAP2_RESUME", hostSocket);
    const hostToken = "host-token-gap2b";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { persistent: true })));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "gap2b" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };
    const doAny = do_ as unknown as DoInternals;
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    // Start a long wait (in flight).
    const waitPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 1, { pattern: "NEVER", timeout_ms: 45_000 })));
    await waitFor(() => doAny.mcpWaitCount === 1, 1000, "wait admitted");
    // Resume the run WHILE the wait is in flight: the resume cancels the in-flight request and
    // clears run-scoped state. The wait's late completion then lands in the new run.
    const resumeRes = await do_.fetch(postJson("https://shell.online/internal/resume", {
      ...initBody(await sha256Hex(hostToken), { persistent: true }),
    }));
    expect(resumeRes.status).toBe(200);
    const response = await withTimeout(waitPromise, 4000);
    await response.text(); // consume the body so the wait settles (late completion in the new run)
    // The late completion's audit entry was suppressed (run-generation mismatch) — no old-grant
    // "shell_wait" entry in the new run's audit, and the counter was not driven negative.
    const oldGrantWait = doAny.mcpAudit.find((e) => e.tool === "shell_wait");
    expect(oldGrantWait).toBeUndefined();
    expect(doAny.mcpWaitCount).toBe(0);
    expect(doAny.mcpAudit.length).toBe(0);
  });

  it("F8: the presence broadcast carries the server's MCP decryption authorization (full grant lifetime)", async () => {
    const hostSocket = makeHostSocket();
    const viewerSocket = makeViewerSocket();
    const { do: do_, routeKey } = await makeDoWithHostAndViewer("F8_DECRYPT_CAP", hostSocket, viewerSocket);
    const hostToken = "host-token-f8";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { encrypted: true })));
    const frameKey = crypto.getRandomValues(new Uint8Array(32));
    const cipher = await BrowserFrameCipher.fromKey(new Uint8Array(frameKey));
    const presenceDecrypts = () =>
      viewerSocket.sent
        .map((m) => JSON.parse(m) as { type?: string; mcpDecrypt?: boolean })
        .filter((m) => m.type === "presence")
        .map((m) => m.mcpDecrypt);

    // Grant issuance: the server is authorized to decrypt for the grant's full lifetime — the
    // disclosure updates immediately (no MCP call needed), even before the cipher is allocated.
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "f8", frame_key: base64url.encode(frameKey) }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };
    expect(presenceDecrypts().at(-1)).toBe(true);

    // The first MCP call (before the seed allocates the cipher) still carries the authorization:
    // the disclosure tracks the grant lifetime, not cipher allocation.
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"), cipher);
    expect(presenceDecrypts().at(-1)).toBe(true);
  });

  it("F9: presence activity is hard-bounded to MCP_MAX_ACTIVITY_ENTRIES", async () => {
    const { do: do_ } = await makeGrantDo("F9_HARD_BOUND", 60, "f9");
    const doAny = do_ as unknown as DoInternals;
    // Drive the activity map far past the bound with distinct grant ids (no in-flight). Stagger the
    // activity times so the eviction order (oldest-first) is deterministic.
    const now = Date.now();
    for (let i = 0; i < 200; i += 1) {
      doAny.mcpActivity.set(`grant-${i}`, { label: `agent-${i}`, lastActivityAt: now - (200 - i) * 1000 });
    }
    // The same enforcement touchMcpActivity runs after every activity touch must cap the map.
    doAny.mcpEnforceActivityBound();
    expect(doAny.mcpActivity.size).toBeLessThanOrEqual(64);
    // The most recently active entries survive; the oldest are evicted.
    expect(doAny.mcpActivity.has("grant-199")).toBe(true);
    expect(doAny.mcpActivity.has("grant-0")).toBe(false);
  });

  // --- P01: cancellation through the deployed transport -------------------------------------
  // A client that drops a long-poll shell_wait must release its wait slot promptly, not hold it to
  // the original timeout. In the deployed Worker this requires the `enable_request_signal`
  // compatibility flag (without it the Worker's request.signal never fires on client disconnect, so
  // the DO's forwarded signal — and thus the pending wait — is never aborted). The flag is a
  // concrete config gap; the code path (DO request.signal -> controller.abort -> model.wait cancel)
  // is covered by the regression tests below.

  it("P01-config: staging config contract enables request cancellation (enable_request_signal)", () => {
    // Validate the TRACKED, secret-free contract fixture (not the gitignored private config — that
    // is the deployment preflight's job). The check parses the JSONC and asserts the flag is in the
    // compatibility_flags array (a flag in a comment or an unrelated field does not satisfy it).
    const contractPath = "tests/fixtures/wrangler.staging.contract.jsonc";
    expect(() => validateConfigFile(contractPath)).not.toThrow();
    // Guard against an empty contract: the contract must actually require the cancellation flag.
    expect(REQUIRED_COMPATIBILITY_FLAGS).toContain("enable_request_signal");
  });

  it("P01: aborting a shell_wait releases the wait slot promptly (not held to the original timeout)", async () => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("P01_ABORT", 60, "p01");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    expect(doAny.mcpWaitCount).toBe(0);

    // Start a long-poll wait (5s timeout) carrying an abort signal.
    const controller = new AbortController();
    const waitPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 2, { pattern: "NEVER", timeout_ms: 5000 }), {}, controller.signal));
    await waitFor(() => doAny.mcpWaitCount === 1, 1000, "wait admitted");

    // Abort the request well before the 5s timeout.
    const abortedAt = Date.now();
    controller.abort();

    // The wait slot must be released within a 2s cleanup budget (not held to the 5s timeout).
    await waitFor(() => doAny.mcpWaitCount === 0, 2000, "wait slot released on abort");
    const releasedAfterMs = Date.now() - abortedAt;
    expect(doAny.mcpWaitCount).toBe(0);
    expect(releasedAfterMs).toBeLessThan(2000);

    // The aborted wait settles as "cancelled" (not "timeout").
    const result = await toolResult(await withTimeout(waitPromise, 4000));
    expect(result.reason).toBe("cancelled");

    // A second wait from the same grant is admitted (the aborted wait's slot is gone, not "limit").
    const r2 = await toolResult(await withTimeout(workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_wait", 3, { pattern: "NEVER", timeout_ms: 50 }))), 4000));
    expect(r2.reason).toBe("timeout");
  });

  // The deterministic body-cancel settlement regression: mirror of the request-abort settlement
  // test, but the ONLY cancellation source is the client cancelling the response body (no
  // request.signal abort). Proves the underlying model wait actually SETTLES as cancelled (its
  // pending waiter is removed and its promise resolves "cancelled") when the client drops the
  // response mid-flight — not merely that request accounting reaches zero.
  it("P01: cancelling the response body settles the real model wait as cancelled and removes its waiter", async () => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("P01_BODY_CANCEL", 60, "p01b");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;
    expect(doAny.mcpWaitCount).toBe(0);

    // The model is allocated by seedModel. Install a call-through spy on the REAL wait method:
    // preserve its implementation and capture the promise it returns (no fabricated result).
    const model = doAny.mcpModel as TerminalModel;
    expect(model).toBeTruthy();
    const originalWait = model.wait.bind(model);
    let captured: Promise<WaitResult> | null = null;
    model.wait = (pattern: string | null, cursor: Cursor | undefined, timeoutMs: number, signal: AbortSignal) => {
      const p = originalWait(pattern, cursor, timeoutMs, signal);
      captured = p;
      return p;
    };
    const pendingWaitsSize = () => (model as unknown as { pendingWaits: Set<unknown> }).pendingWaits.size;

    // Start a long-poll wait (5s) through the request handler, with NO client abort signal.
    const responsePromise = workerFetch(
      routeKey, do_,
      workerMcpRequest(bearer, call("shell_wait", 2, { pattern: "NEVER", timeout_ms: 5000 })),
    );

    // Synchronize on the ACTUAL wait registration: the spy captured the real promise AND the model
    // holds a live pending waiter (not merely request accounting).
    await waitFor(() => captured !== null && pendingWaitsSize() === 1, 1000, "real wait registered");
    expect(doAny.mcpWaitCount).toBe(1);

    // The client drops the response mid-flight: cancel the response body (request.signal never
    // aborts — only the body cancel must settle the wait).
    const res = await withTimeout(responsePromise, 4000);
    const cancelledAt = Date.now();
    await res.body?.cancel().catch(() => {});

    // 1. The captured REAL promise settles as cancelled (not timeout/matched/reset). The window
    //    exceeds the 5s wait timeout so a broken propagation fails on the reason assertion (the
    //    wait runs to "timeout") rather than on a capture timeout.
    const settled = await withTimeout(captured!, 6000);
    expect(settled.reason).toBe("cancelled");

    // 2. The model's actual pending waiter is removed.
    expect(pendingWaitsSize()).toBe(0);

    // 3. The slot is released within the 2s cleanup budget and request accounting returns to zero.
    await waitFor(() => doAny.mcpWaitCount === 0, 2000, "request accounting released");
    const releasedAfterMs = Date.now() - cancelledAt;
    expect(doAny.mcpWaitCount).toBe(0);
    expect(releasedAfterMs).toBeLessThan(2000);
  }, 10000);

  // The deterministic settlement regression: prove the underlying model wait actually SETTLES as
  // cancelled (its pending waiter is removed and its promise resolves "cancelled") when the client
  // request is aborted — not merely that request accounting reaches zero. Uses the real Worker/DO
  // harness and a call-through spy on the real model.wait (its implementation is preserved; only
  // the returned promise is captured). The known gap is in the deployed transport (the
  // enable_request_signal flag), so this in-process test is expected to PASS; the mutation check
  // (break propagation, keep accounting cleanup) must make it fail.
  it("P01: aborting the client request settles the real model wait as cancelled and removes its waiter", async () => {
    const { do: do_, routeKey, hostSocket, bearer } = await makeGrantDo("P01_SETTLE", 60, "p01s");
    await seedModel(do_, hostSocket, routeKey, bearer, call("shell_output", 1, {}), enc("SEED\n"));
    const doAny = do_ as unknown as DoInternals;

    // The model is allocated by seedModel. Install a call-through spy on the REAL wait method:
    // preserve its implementation and capture the promise it returns (no fabricated result).
    const model = doAny.mcpModel as TerminalModel;
    expect(model).toBeTruthy();
    const originalWait = model.wait.bind(model);
    let captured: Promise<WaitResult> | null = null;
    model.wait = (pattern: string | null, cursor: Cursor | undefined, timeoutMs: number, signal: AbortSignal) => {
      const p = originalWait(pattern, cursor, timeoutMs, signal);
      captured = p;
      return p;
    };
    const pendingWaitsSize = () => (model as unknown as { pendingWaits: Set<unknown> }).pendingWaits.size;

    // Start a long-poll wait (5s) through the request handler, carrying a client abort signal.
    // RETAIN this harness's source Request until the response is consumed: Node's built-in undici
    // holds the abort-propagation link (this Request's signal -> the DO's forwarded signal) via a
    // strong reference on the Request and a WEAK reference to its internal AbortController. Once the
    // Worker returns the streamed response headers (before the wait settles), an inline Request
    // becomes collectable; if it is GC'd the internal abort controller is collected and
    // controller.abort() no longer reaches the DO, so the wait runs to its own timeout instead of
    // settling as cancelled. This retention is a property of the Node unit harness, not a claim
    // about every client's lifecycle.
    const controller = new AbortController();
    const clientRequest = workerMcpRequest(bearer, call("shell_wait", 2, { pattern: "NEVER", timeout_ms: 5000 }), {}, controller.signal);
    const responsePromise = workerFetch(routeKey, do_, clientRequest);

    // Synchronize on the ACTUAL wait registration: the spy captured the real promise AND the model
    // holds a live pending waiter (not merely request accounting).
    await waitFor(() => captured !== null && pendingWaitsSize() === 1, 1000, "real wait registered");
    expect(doAny.mcpWaitCount).toBe(1);

    // Optional forced-GC path (explicit regression command only): now that the waiter is registered
    // and the Worker has returned the streamed headers, the retained clientRequest is the ONLY thing
    // keeping the abort-propagation link alive. Force a GC (no-op unless run with `node
    // --expose-gc ... --pool=threads`) to prove the retention holds under collection pressure: if
    // the source Request were collected here, the link would break and the wait would run to timeout
    // instead of settling as cancelled. This validates our Worker/DO cancellation path, not every
    // client's lifecycle.
    await forceGcIfAvailable();

    // Abort the CLIENT request (the Worker's request.signal), not the model's signal directly.
    controller.abort();

    // 1. The captured REAL promise settles as cancelled (not timeout/matched/reset). The window
    //    exceeds the 5s wait timeout so a broken propagation fails on the reason assertion (the
    //    wait runs to "timeout") rather than on a capture timeout.
    const settled = await withTimeout(captured!, 6000);
    expect(settled.reason).toBe("cancelled");

    // 2. The model's actual pending waiter is removed.
    expect(pendingWaitsSize()).toBe(0);

    // 3. Request accounting returns to zero afterward.
    await waitFor(() => doAny.mcpWaitCount === 0, 2000, "request accounting released");
    expect(doAny.mcpWaitCount).toBe(0);

    // The HTTP response also reflects the cancellation (the tool's finally released the slot).
    const result = await toolResult(await withTimeout(responsePromise, 4000));
    expect(result.reason).toBe("cancelled");

    // The retained client Request's signal must reflect the abort even after settlement and full
    // body consumption: the propagation source stayed live for the entire pending call. If the
    // Request had been collected, this signal would not have aborted and the wait above would have
    // settled as "timeout" instead of "cancelled".
    expect(clientRequest.signal.aborted).toBe(true);
  }, 10000);
});

// --- F2: staging Host/Origin allowlists ----------------------------------------------------

describe("F2: staging Host/Origin allowlists", () => {
  // Build a Worker request targeting a specific Host (via the URL) so the Worker's Host/Origin
  // validation sees the staging hostname rather than the production one.
  function stagingMcpRequest(host: string, bearer: string, body: string, origin?: string): Request {
    return new Request(`https://${host}/mcp`, {
      method: "POST",
      headers: {
        Host: host,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-06-18",
        Authorization: `Bearer ${bearer}`,
        ...(origin ? { Origin: origin } : {}),
      },
      body,
    });
  }

  function makeEnvWithStaging(routeKey: string, do_: TerminalSession, stagingHostnames?: string) {
    const limiter = { limit: async () => ({ success: true }) };
    const env: Record<string, unknown> = {
      MCP_LIMITER: limiter,
      MCP_ROUTE_KEY: routeKey,
      SESSIONS: {
        getByName: () => ({
          fetch: (url: string, init?: RequestInit) => do_.fetch(new Request(url, init)),
        }),
      },
    };
    if (stagingHostnames !== undefined) env.MCP_STAGING_HOSTNAMES = stagingHostnames;
    return env as never;
  }

  it("F2a: staging host accepted with valid bearer when MCP_STAGING_HOSTNAMES is set", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("F2A_STAGING_OK", hostSocket);
    const hostToken = "host-token-f2a";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "f2a" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    const stagingEnv = makeEnvWithStaging(routeKey, do_, '["staging.shell.online"]');
    const ctxShim = { waitUntil: () => {} };
    const req = stagingMcpRequest("staging.shell.online", bearer, call("shell_status", 1, {}));
    const res = await worker.fetch(req as never, stagingEnv, ctxShim as never);
    // The staging hostname is accepted: a successful shell_status result (200 + parsed payload),
    // not merely the absence of a host rejection.
    expect(res.status).toBe(200);
    const result = await toolResult(res);
    expect(result.run).toBeDefined();
  });

  it("F2b: untrusted host rejected even when MCP_STAGING_HOSTNAMES is set", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("F2B_UNTRUSTED", hostSocket);
    const hostToken = "host-token-f2b";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "f2b" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    const stagingEnv = makeEnvWithStaging(routeKey, do_, '["staging.shell.online"]');
    const ctxShim = { waitUntil: () => {} };
    const req = stagingMcpRequest("evil.example.com", bearer, call("shell_status", 1, {}));
    const res = await worker.fetch(req as never, stagingEnv, ctxShim as never);
    // The untrusted hostname is not in the allowlist (production or staging) → 403.
    expect(res.status).toBe(403);
  });

  it("F2c: staging host rejected when MCP_STAGING_HOSTNAMES is not set (production validation unchanged)", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("F2C_NO_STAGING", hostSocket);
    const hostToken = "host-token-f2c";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "f2c" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // No MCP_STAGING_HOSTNAMES in the env — production validation only.
    const prodEnv = makeWorkerEnv(routeKey, do_);
    const ctxShim = { waitUntil: () => {} };
    const req = stagingMcpRequest("staging.shell.online", bearer, call("shell_status", 1, {}));
    const res = await worker.fetch(req as never, prodEnv as never, ctxShim as never);
    // Without the staging allowlist, the staging hostname is not trusted → 403.
    expect(res.status).toBe(403);
  });

  it("F2d: production host still accepted without MCP_STAGING_HOSTNAMES", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("F2D_PROD_OK", hostSocket);
    const hostToken = "host-token-f2d";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "f2d" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    const prodEnv = makeWorkerEnv(routeKey, do_);
    const ctxShim = { waitUntil: () => {} };
    const req = stagingMcpRequest("shell.online", bearer, call("shell_status", 1, {}));
    const res = await worker.fetch(req as never, prodEnv as never, ctxShim as never);
    // The production hostname is always accepted: a successful result (200 + parsed payload).
    expect(res.status).toBe(200);
    const result = await toolResult(res);
    expect(result.run).toBeDefined();
  });

  it("F2e: trusted staging Origin accepted when MCP_STAGING_HOSTNAMES is set", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("F2E_TRUSTED_ORIGIN", hostSocket);
    const hostToken = "host-token-f2e";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "f2e" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    const stagingEnv = makeEnvWithStaging(routeKey, do_, '["staging.shell.online"]');
    const ctxShim = { waitUntil: () => {} };
    // A browser on the staging origin sends Origin: https://staging.shell.online — accepted.
    const req = stagingMcpRequest("staging.shell.online", bearer, call("shell_status", 1, {}), "https://staging.shell.online");
    const res = await worker.fetch(req as never, stagingEnv, ctxShim as never);
    expect(res.status).toBe(200);
    const result = await toolResult(res);
    expect(result.run).toBeDefined();
  });

  it("F2f: untrusted Origin rejected even when MCP_STAGING_HOSTNAMES is set", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDoWithHost("F2F_UNTRUSTED_ORIGIN", hostSocket);
    const hostToken = "host-token-f2f";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken))));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60, label: "f2f" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    const stagingEnv = makeEnvWithStaging(routeKey, do_, '["staging.shell.online"]');
    const ctxShim = { waitUntil: () => {} };
    // A browser on an untrusted origin sends Origin: https://evil.example.com — rejected (403).
    const req = stagingMcpRequest("staging.shell.online", bearer, call("shell_status", 1, {}), "https://evil.example.com");
    const res = await worker.fetch(req as never, stagingEnv, ctxShim as never);
    expect(res.status).toBe(403);
  });
});
