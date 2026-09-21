import { describe, expect, it, vi } from "vitest";
import { base64url, exportJWK, generateKeyPair } from "jose";
import { decodeSend, encodeSend, encodeSendAck, Opcode, SEND_RESULT_DELIVERED, SEND_RESULT_UNCERTAIN } from "../shared/protocol";
import { BrowserFrameCipher } from "../shared/e2ee";
import { type McpOpRecord } from "../shared/mcp-write";

// Mock the DurableObject base class so the DO can be constructed and driven in Node (vitest).
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

const OP = "550e8400-e29b-41d4-a716-446655440000";
const OP2 = "550e8400-e29b-41d4-a716-446655440001";
const OPX = "550e8400-e29b-41d4-a716-446655440002";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeEcdhJwk(kid: string): Promise<string> {
  const pair = await generateKeyPair("ECDH-ES", { extractable: true });
  return JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid });
}

// control: false = gate unset, true = gate "1", a string = the raw gate value (to test that
// arbitrary strings like "yes" do NOT enable the gate).
function makeEnv(routeKey: string, frameKey: string, control: boolean | string) {
  const limiter = { limit: async () => ({ success: true }) };
  const stubDo = { fetch: async () => new Response("ok", { status: 200 }) };
  const controlEnv = control === false ? {} : { MCP_CONTROL_ENABLED: control === true ? "1" : control };
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
    ...controlEnv,
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
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function initBody(hostTokenHash: string, opts: { control?: boolean; readOnly?: boolean; encrypted?: boolean } = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    hostTokenHash,
    readOnly: opts.readOnly ?? false,
    encrypted: opts.encrypted ?? false,
    persistent: false,
    control: opts.control ?? false,
    label: "write-session",
    createdAt: now,
    expiresAt: now + 3_600_000,
  };
}

// A mock host WebSocket that captures BOTH the JSON control messages (sentJson) and the binary
// frames (sentBinary) the DO sends — the Send frame for shell_send is binary.
function makeHostSocket() {
  let attachment: Record<string, unknown> = { role: "host", id: 0 };
  const sentJson: string[] = [];
  const sentBinary: Uint8Array[] = [];
  return {
    readyState: 1,
    sent: sentJson,
    sentJson,
    sentBinary,
    serializeAttachment(a: Record<string, unknown>) {
      attachment = a;
    },
    deserializeAttachment() {
      return attachment;
    },
    send(value: string | ArrayBuffer) {
      if (typeof value === "string") sentJson.push(value);
      else sentBinary.push(new Uint8Array(value));
    },
    close() {},
  };
}

const asWs = (s: ReturnType<typeof makeHostSocket>) => s as unknown as WebSocket;
const wsFrame = (frame: Uint8Array) => new Uint8Array(frame).buffer as ArrayBuffer;

function makeStateWithHost(idName: string, hostSocket: unknown, store?: Map<string, unknown>) {
  const backing = store ?? new Map<string, unknown>();
  return {
    id: { name: idName, toString: () => idName },
    storage: {
      get: async (key: string) => backing.get(key),
      put: async (key: string, value: unknown) => {
        backing.set(key, value);
      },
      delete: async (key: string) => {
        backing.delete(key);
      },
      deleteAll: async () => {
        backing.clear();
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

async function makeDo(
  sessionId: string,
  hostSocket: unknown,
  controlEnabled: boolean | string,
  store?: Map<string, unknown>,
): Promise<{ do: TerminalSession; routeKey: string; frameKey: string }> {
  const route = await makeEcdhJwk("route-v1");
  const frame = await makeEcdhJwk("frame-v1");
  const do_ = new TerminalSession(makeStateWithHost(sessionId, hostSocket, store) as never, makeEnv(route, frame, controlEnabled) as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { do: do_, routeKey: route, frameKey: frame };
}

function workerMcpRequest(bearer: string, body: string): Request {
  return new Request("https://shell.online/mcp", {
    method: "POST",
    headers: {
      Host: "shell.online",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body,
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

// Parse the SSE response into the tool's JSON result, or return the RPC/tool error message.
// A single flat shape (optional result/error) so tests can read either field without narrowing.
async function toolOutcome(response: Response): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no data line in response: ${body.slice(0, 200)}`);
  const rpc = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string };
  };
  if (rpc.error) return { ok: false, error: rpc.error.message };
  if (!rpc.result) throw new Error(`no result in response: ${dataLine}`);
  if (rpc.result.isError) return { ok: false, error: rpc.result.content[0].text };
  return { ok: true, result: JSON.parse(rpc.result.content[0].text) as Record<string, unknown> };
}

function call(name: string, id: number, arguments_: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } });
}

// Set up a control session (gate on, host control-capable, non-read-only) with an input-scoped
// grant. `encrypted: true` stands up an E2EE session: the grant carries a fresh frame key and the
// returned `cipher` seals/opens frames exactly like the host would. Returns the DO, host socket,
// route key, and bearer.
async function setupControl(opts: { readOnly?: boolean; controlHost?: boolean; encrypted?: boolean } = {}) {
  const hostSocket = makeHostSocket();
  const { do: do_, routeKey } = await makeDo("WRITING_SESSION", hostSocket, true);
  const hostToken = "host-token-write";
  await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { control: opts.controlHost ?? true, readOnly: opts.readOnly ?? false, encrypted: opts.encrypted ?? false })));
  const frameKey = crypto.getRandomValues(new Uint8Array(32));
  const grantRes = await do_.fetch(
    postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60, ...(opts.encrypted ? { frame_key: base64url.encode(frameKey) } : {}) }, { Authorization: `Bearer ${hostToken}` }),
  );
  if (grantRes.status !== 201) throw new Error(`grant failed: ${grantRes.status}`);
  const { bearer } = (await grantRes.json()) as { bearer: string };
  const cipher = opts.encrypted ? await BrowserFrameCipher.fromKey(new Uint8Array(frameKey)) : undefined;
  return { do: do_, hostSocket, routeKey, bearer, hostToken, cipher };
}

// The names of the tools in this grant's catalog (stateless tools/list).
async function listToolNames(routeKey: string, do_: TerminalSession, bearer: string): Promise<string[]> {
  const response = await workerFetch(routeKey, do_, workerMcpRequest(bearer, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })));
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no data line in tools/list: ${body.slice(0, 200)}`);
  const rpc = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { tools: Array<{ name: string }> };
    error?: { message: string };
  };
  if (rpc.error) throw new Error(`tools/list error: ${rpc.error.message}`);
  if (!rpc.result) throw new Error(`no result in tools/list: ${dataLine}`);
  return rpc.result.tools.map((t) => t.name);
}

// White-box view of the DO's in-memory shell_send ack-binding state (the dispatch index is keyed
// by the 16-byte dispatch token, as a stable hex string).
type DoInternals = {
  mcpSendDispatchIndex: Map<string, { runId: string; grantId: string; operationId: string }>;
  mcpOps: McpOpRecord[];
  mcpCipher: BrowserFrameCipher | null;
  mcpFramePlaintext(frame: Uint8Array): Promise<Uint8Array | null>;
};

// Recover the dispatch token the DO used for the Send frame at the given index in the host's
// outbound binary frames (seal/opened with the session cipher for encrypted sessions).
async function sentSendToken(hostSocket: ReturnType<typeof makeHostSocket>, index: number, cipher?: BrowserFrameCipher): Promise<Uint8Array> {
  let frame = hostSocket.sentBinary[index];
  if (cipher) frame = await cipher.open(frame);
  const decoded = decodeSend(frame);
  if (!decoded) throw new Error(`no Send frame at index ${index}`);
  return decoded.dispatchToken;
}

// Send a SendAck frame back to the DO for the given operation id + dispatch token + result.
async function sendAck(do_: TerminalSession, hostSocket: ReturnType<typeof makeHostSocket>, opId: string, token: Uint8Array, result: number, cipher?: BrowserFrameCipher): Promise<void> {
  let frame = encodeSendAck(opId, token, result);
  if (cipher) frame = await cipher.seal(frame);
  await do_.webSocketMessage(asWs(hostSocket), wsFrame(frame));
}

describe("shell_send (control) — DO wiring", () => {
  it("is not offered when the gate is off (disabled by default)", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDo("GATE_OFF", hostSocket, false);
    const hostToken = "host-token-gateoff";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { control: true })));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    const { bearer } = (await grantRes.json()) as { bearer: string };
    const outcome = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "hi", operation_id: OP }))));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not found/i);
  });

  it("rejects a schema violation (-32602) before any delivery work", async () => {
    const { do: do_, routeKey, bearer } = await setupControl();
    // NUL in the text.
    let outcome = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "a\u0000b", operation_id: OP }))));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/forbidden|control/i);
    // A non-UUID operation_id.
    outcome = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "hi", operation_id: "not-a-uuid" }))));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/UUID/i);
  });

  it("excludes shell_send from an observe-only grant's catalog (a call is not found)", async () => {
    const hostSocket = makeHostSocket();
    const { do: do_, routeKey } = await makeDo("SCOPE_OBSERVE", hostSocket, true);
    const hostToken = "host-token-scope";
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { control: true })));
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    const { bearer } = (await grantRes.json()) as { bearer: string };
    // No input scope: shell_send is not in this grant's catalog at all.
    const names = await listToolNames(routeKey, do_, bearer);
    expect(names).not.toContain("shell_send");
    expect(names).toContain("shell_status");
    // A call is a "not found" error, not a delivered/denied result.
    const outcome = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "hi", operation_id: OP }))));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not found/i);
  });

  it("denies an input grant on a read-only session", async () => {
    const { do: do_, routeKey, bearer } = await setupControl({ readOnly: true });
    const outcome = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "hi", operation_id: OP }))));
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.reason).toBe("denied");
  });

  it("excludes shell_send from a non-control session's catalog (a call is not found)", async () => {
    // The host is not control-capable (meta.control is false): even an input-scoped grant does not
    // get shell_send in its catalog.
    const { do: do_, routeKey, bearer } = await setupControl({ controlHost: false });
    const names = await listToolNames(routeKey, do_, bearer);
    expect(names).not.toContain("shell_send");
    expect(names).toContain("shell_status");
    const outcome = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "hi", operation_id: OP }))));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not found/i);
  });

  it("delivers on a correlated host ack and writes the exact text + Enter", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", enter: true, operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // Verify the ACTUAL bytes handed to the host (not just a counter): the Send frame carries the
    // text, the enter flag, and the operation id.
    const decoded = decodeSend(hostSocket.sentBinary[0]);
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded?.text ?? new Uint8Array())).toBe("echo hi");
    expect(decoded?.enter).toBe(true);
    expect(decoded?.operationId).toBe(OP);
    // The host acks the complete operation (echoing the DO's dispatch token verbatim).
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    const outcome = await toolOutcome(await withTimeout(mcpPromise, 4000));
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.delivered).toBe(true);
    expect(outcome.result?.reason).toBe("delivered");
  });

  it("reports delivery_uncertain when the ack is lost (timeout)", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // No ack is sent: the bounded timeout (5s) resolves as uncertain. Wait it out.
    const outcome = await toolOutcome(await withTimeout(mcpPromise, 8000));
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.delivered).toBe(false);
    expect(outcome.result?.reason).toBe("delivery_uncertain");
  }, 12000);

  it("reports delivery_uncertain on a partial-write ack (never auto-replayed)", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_UNCERTAIN);
    const outcome = await toolOutcome(await withTimeout(mcpPromise, 4000));
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.reason).toBe("delivery_uncertain");
    // A retry with the SAME operation_id + args replays the stored uncertain result (no second
    // Send frame is dispatched).
    const before = hostSocket.sentBinary.length;
    const retry = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo hi", operation_id: OP }))));
    expect(retry.ok).toBe(true);
    expect(retry.result?.reason).toBe("delivery_uncertain");
    expect(hostSocket.sentBinary.length).toBe(before); // no second write
  });

  it("replays a stored delivered result (never re-sent)", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    const firstOutcome = await toolOutcome(await withTimeout(first, 4000));
    expect(firstOutcome.ok).toBe(true);
    expect(firstOutcome.result?.delivered).toBe(true);
    // A retry with the SAME operation_id + args replays the stored delivered result (no second
    // Send frame).
    const before = hostSocket.sentBinary.length;
    const retry = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo hi", operation_id: OP }))));
    expect(retry.ok).toBe(true);
    expect(retry.result?.delivered).toBe(true);
    expect(hostSocket.sentBinary.length).toBe(before); // no second write
  });

  it("conflicts when the same operation_id is reused with different args", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    await toolOutcome(await withTimeout(first, 4000));
    // Same operation_id, different text → idempotency conflict (a server error, not a clean result).
    const conflict = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo HO", operation_id: OP }))));
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/conflict/i);
  });

  it("coalesces a concurrent duplicate to in_flight (no second write)", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    // The first call is in flight (the host has not acked yet).
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // A concurrent duplicate (same operation_id) is coalesced to in_flight, not a second write.
    const dup = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo hi", operation_id: OP }))));
    expect(dup.ok).toBe(true);
    expect(dup.result?.reason).toBe("in_flight");
    expect(hostSocket.sentBinary.length).toBe(1); // still one write
    // Settle the first.
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    await toolOutcome(await withTimeout(first, 4000));
  });

  it("is busy when the local host is actively typing (human priority)", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    // Simulate active local-host typing (the host's localTypingAt is within the lease window).
    const attachment = hostSocket.deserializeAttachment() as Record<string, unknown>;
    attachment.localTypingAt = Date.now();
    hostSocket.serializeAttachment(attachment);
    const outcome = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "hi", operation_id: OP }))));
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.reason).toBe("busy");
    // The operation was not claimed: the same operation_id is still dispatchable once the lease frees.
    expect(hostSocket.sentBinary.length).toBe(0);
  });

  it("is busy while another MCP grant holds the writer lease", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    // The first grant's write is in flight (holds the lease).
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // A second write (different operation_id) is busy (the lease is held).
    const second = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo other", operation_id: OP2 }))));
    expect(second.ok).toBe(true);
    expect(second.result?.reason).toBe("busy");
    expect(hostSocket.sentBinary.length).toBe(1); // no second write
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    await toolOutcome(await withTimeout(first, 4000));
  });

  it("preserves at-most-once claims across DO reconstruction", async () => {
    const sharedStore = new Map<string, unknown>();
    const hostSocket = makeHostSocket();
    const { do: do1, routeKey } = await makeDo("RECONSTRUCT", hostSocket, true, sharedStore);
    const hostToken = "host-token-recon";
    await do1.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { control: true })));
    const grantRes = await do1.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    const { bearer } = (await grantRes.json()) as { bearer: string };
    // Claim an op (dispatch + ack → delivered).
    const first = workerFetch(routeKey, do1, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    await sendAck(do1, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    const firstOutcome = await toolOutcome(await withTimeout(first, 4000));
    expect(firstOutcome.ok).toBe(true);
    expect(firstOutcome.result?.delivered).toBe(true);
    // The op claim is durable (persisted in the shared store).
    expect(sharedStore.has("mcpOps")).toBe(true);
    // Reconstruct a new DO over the same store (simulates hibernation/eviction). The claim is
    // preserved: a retry with the same ID + args replays the stored delivered result (no second
    // Send frame is dispatched).
    const { do: do2 } = await makeDo("RECONSTRUCT", hostSocket, true, sharedStore);
    const before = hostSocket.sentBinary.length;
    const retry = await toolOutcome(await workerFetch(routeKey, do2, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo hi", operation_id: OP }))));
    expect(retry.ok).toBe(true);
    expect(retry.result?.delivered).toBe(true);
    expect(hostSocket.sentBinary.length).toBe(before); // no second write
  }, 10000);

  it("ignores a stale ack (unknown operation_id) and times out as uncertain", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // A stale ack for a DIFFERENT (unknown) operation_id + a token bound to no dispatch is
    // ignored; the real op times out.
    await sendAck(do_, hostSocket, OP2, crypto.getRandomValues(new Uint8Array(16)), SEND_RESULT_DELIVERED);
    const outcome = await toolOutcome(await withTimeout(mcpPromise, 8000));
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.reason).toBe("delivery_uncertain");
  }, 12000);

  it("audits a revoked grant mid-write as revoked (not delivered)", async () => {
    const { do: do_, hostSocket, routeKey, bearer, hostToken } = await setupControl();
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // Revoke the grant while the write is in flight (the ack never comes; the revocation aborts it).
    const listRes = await do_.fetch(new Request("https://shell.online/internal/mcp/grants", { method: "GET", headers: { Authorization: `Bearer ${hostToken}` } }));
    const { grants } = (await listRes.json()) as { grants: Array<{ grant_id: string }> };
    const revokeRes = await do_.fetch(
      new Request("https://shell.online/internal/mcp/grant", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ grant_id: grants[0].grant_id }) }),
    );
    expect(revokeRes.status).toBe(200);
    // The in-flight write settles (revoked aborts it) and the tool re-checks: revoked, not delivered.
    const outcome = await toolOutcome(await withTimeout(first, 6000));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no longer active|revoked/i);
  }, 10000);

  it("rejects an unknown field in the shell_send args (strict schema; nothing dispatched or claimed)", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const outcome = await toolOutcome(
      await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "hi", enter: true, operation_id: OP, bogus: "x" }))),
    );
    // A plain (non-strict) zod object would STRIP the unknown field and dispatch anyway; the
    // strict schema rejects it with -32602 before the handler runs.
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/unrecognized key/i);
    expect(hostSocket.sentBinary.length).toBe(0); // no Send frame
    // The operation was not claimed: a clean retry with the same operation_id dispatches it.
    const retry = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    const retryOutcome = await toolOutcome(await withTimeout(retry, 4000));
    expect(retryOutcome.ok).toBe(true);
    expect(retryOutcome.result?.delivered).toBe(true);
  });

  it("gate: enabled only for the accepted values '1'/'true' — an arbitrary string leaves it off", async () => {
    const mk = async (control: boolean | string, id: string) => {
      const hostSocket = makeHostSocket();
      const { do: do_, routeKey } = await makeDo(id, hostSocket, control);
      const hostToken = `host-token-${id}`;
      await do_.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { control: true })));
      const grantRes = await do_.fetch(
        postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
      );
      if (grantRes.status !== 201) throw new Error(`grant failed: ${grantRes.status}`);
      const { bearer } = (await grantRes.json()) as { bearer: string };
      return { do: do_, routeKey, bearer };
    };
    // An arbitrary non-empty string does NOT enable the gate (a truthy check would).
    const off = await mk("yes", "GATE_YES");
    expect(await listToolNames(off.routeKey, off.do, off.bearer)).not.toContain("shell_send");
    // The explicitly accepted values do.
    const on1 = await mk("1", "GATE_ONE");
    expect(await listToolNames(on1.routeKey, on1.do, on1.bearer)).toContain("shell_send");
    const onTrue = await mk("true", "GATE_TRUE");
    expect(await listToolNames(onTrue.routeKey, onTrue.do, onTrue.bearer)).toContain("shell_send");
  });

  it("binds host acks to the current dispatch index: a late ack from a prior host connection is ignored", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl();
    const any = do_ as unknown as DoInternals;
    // The grant dispatches OP on host connection #0 (in flight).
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // The host connection drops: the in-flight send can no longer be acknowledged — it settles as
    // delivery_uncertain and the dispatch index is cleared (a late ack has nothing to bind to).
    await do_.webSocketClose(asWs(hostSocket), 1006, "connection lost", false);
    const firstOutcome = await toolOutcome(await withTimeout(first, 4000));
    expect(firstOutcome.ok).toBe(true);
    expect(firstOutcome.result?.reason).toBe("delivery_uncertain");
    expect(any.mcpSendDispatchIndex.size).toBe(0);
    // A NEW host connection comes up (new attachment id) and the grant dispatches a different op.
    hostSocket.serializeAttachment({ role: "host", id: 1 });
    const second = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo again", operation_id: OP2 })));
    await waitFor(() => hostSocket.sentBinary.length > 1, 2000, "second Send frame");
    // The dispatch index is keyed by the dispatch token (not the operationId): exactly one entry,
    // bound to the in-flight OP2 dispatch.
    expect(any.mcpSendDispatchIndex.size).toBe(1);
    expect([...any.mcpSendDispatchIndex.values()].map((e) => e.operationId)).toEqual([OP2]);
    // A LATE ack for the OLD op (replayed by the old host, carrying the OLD dispatch token)
    // arrives on the new connection. The token is not in the current dispatch index, so it is
    // ignored — it does not complete the other op.
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    // The old op's stored result is unchanged (still uncertain — the late ack did not upgrade it).
    const replay = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 3, { text: "echo hi", operation_id: OP }))));
    expect(replay.ok).toBe(true);
    expect(replay.result?.reason).toBe("delivery_uncertain");
    // The in-flight op OP2 is still pending: the correct ack for OP2 (its own token) completes it.
    await sendAck(do_, hostSocket, OP2, await sentSendToken(hostSocket, 1), SEND_RESULT_DELIVERED);
    const secondOutcome = await toolOutcome(await withTimeout(second, 4000));
    expect(secondOutcome.ok).toBe(true);
    expect(secondOutcome.result?.delivered).toBe(true);
  });

  it("completes an operation by its full key: a different grant's same-UUID op does not corrupt the first grant's record", async () => {
    const { do: do_, hostSocket, routeKey, bearer, hostToken } = await setupControl();
    // A second grant on the same session (same run).
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60, label: "second" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer: bearer2 } = (await grantRes.json()) as { bearer: string };
    // Grant 1 dispatches OP and the host acks it: its record is terminal "delivered".
    const first = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo b", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    await sendAck(do_, hostSocket, OP, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    const firstOutcome = await toolOutcome(await withTimeout(first, 4000));
    expect(firstOutcome.ok).toBe(true);
    expect(firstOutcome.result?.delivered).toBe(true);
    // Grant 2 reuses the SAME operation_id (a client-chosen UUID is only unique within one
    // grant's run): a FRESH claim for grant 2. Its ack is lost, so it times out as
    // delivery_uncertain. Keying the state update by operationId alone would have let this
    // uncertain completion hit grant 1's record (pushed into the store first).
    const second = workerFetch(routeKey, do_, workerMcpRequest(bearer2, call("shell_send", 2, { text: "echo b", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 1, 2000, "second Send frame");
    const secondOutcome = await toolOutcome(await withTimeout(second, 8000));
    expect(secondOutcome.ok).toBe(true);
    expect(secondOutcome.result?.reason).toBe("delivery_uncertain");
    // Grant 1's record is untouched: its retry replays the stored "delivered" (no second write).
    const before = hostSocket.sentBinary.length;
    const retry1 = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 3, { text: "echo b", operation_id: OP }))));
    expect(retry1.ok).toBe(true);
    expect(retry1.result?.delivered).toBe(true);
    expect(hostSocket.sentBinary.length).toBe(before);
    // Grant 2's own record is terminal "uncertain": its retry replays delivery_uncertain — NOT
    // in_flight, which a never-updated "dispatched" record would report.
    const retry2 = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer2, call("shell_send", 4, { text: "echo b", operation_id: OP }))));
    expect(retry2.ok).toBe(true);
    expect(retry2.result?.reason).toBe("delivery_uncertain");
  }, 15000);

  it("eviction keeps a live grant's replay protection when an expired record shares its operation_id", async () => {
    const sharedStore = new Map<string, unknown>();
    const hostSocket = makeHostSocket();
    const { do: do1, routeKey } = await makeDo("EVICT_FULL_KEY", hostSocket, true, sharedStore);
    const hostToken = "host-token-evict";
    await do1.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { control: true })));
    const grantRes = await do1.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    const { bearer } = (await grantRes.json()) as { bearer: string };
    const listRes = await do1.fetch(new Request("https://shell.online/internal/mcp/grants", { method: "GET", headers: { Authorization: `Bearer ${hostToken}` } }));
    const { grants } = (await listRes.json()) as { grants: Array<{ grant_id: string }> };
    const grantId = grants[0].grant_id;
    // The live grant's first op is claimed + delivered.
    const first = workerFetch(routeKey, do1, workerMcpRequest(bearer, call("shell_send", 1, { text: "x", operation_id: OPX })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    await sendAck(do1, hostSocket, OPX, await sentSendToken(hostSocket, 0), SEND_RESULT_DELIVERED);
    const firstOutcome = await toolOutcome(await withTimeout(first, 4000));
    expect(firstOutcome.ok).toBe(true);
    expect(firstOutcome.result?.delivered).toBe(true);
    // Fill the store over the cap with EXPIRED (non-live grant) records, including one that shares
    // the live record's operation_id (same UUID, different grant).
    const liveRecord = (sharedStore.get("mcpOps") as McpOpRecord[]).find((o) => o.grantId === grantId);
    expect(liveRecord).toBeDefined();
    const dead: McpOpRecord[] = [];
    for (let i = 1; i <= 255; i += 1) {
      dead.push({ runId: "run-dead", grantId: `dead-${i}`, operationId: `dead-op-${i}`, fingerprint: "fp", state: "delivered", claimedAt: i * 10, result: "delivered" });
    }
    dead.push({ runId: "run-dead", grantId: "dead-share", operationId: OPX, fingerprint: "fp", state: "delivered", claimedAt: 0, result: "delivered" });
    sharedStore.set("mcpOps", [...dead, liveRecord]);
    // Reconstruct the DO over the same store and claim a new op: the store is over the cap, so the
    // two oldest expired records are evicted — including the one sharing the live record's UUID.
    const { do: do2 } = await makeDo("EVICT_FULL_KEY", hostSocket, true, sharedStore);
    const next = workerFetch(routeKey, do2, workerMcpRequest(bearer, call("shell_send", 2, { text: "y", operation_id: OP2 })));
    await waitFor(() => hostSocket.sentBinary.length > 1, 2000, "Send frame");
    await sendAck(do2, hostSocket, OP2, await sentSendToken(hostSocket, 1), SEND_RESULT_DELIVERED);
    const nextOutcome = await toolOutcome(await withTimeout(next, 4000));
    expect(nextOutcome.ok).toBe(true);
    expect(nextOutcome.result?.delivered).toBe(true);
    // The live record survived the eviction (filtering by operationId alone would have deleted it
    // along with the expired record that shared its UUID): its retry replays "delivered" with no
    // second Send frame.
    const before = hostSocket.sentBinary.length;
    const retry = await toolOutcome(await workerFetch(routeKey, do2, workerMcpRequest(bearer, call("shell_send", 3, { text: "x", operation_id: OPX }))));
    expect(retry.ok).toBe(true);
    expect(retry.result?.delivered).toBe(true);
    expect(hostSocket.sentBinary.length).toBe(before);
  }, 10000);

  it("recovers an orphaned in-flight op on DO reconstruction (delivery_uncertain, no re-dispatch)", async () => {
    const sharedStore = new Map<string, unknown>();
    const hostSocket = makeHostSocket();
    const { do: do1, routeKey } = await makeDo("ORPHAN", hostSocket, true, sharedStore);
    const hostToken = "host-token-orphan";
    await do1.fetch(postJson("https://shell.online/internal/init", initBody(await sha256Hex(hostToken), { control: true })));
    const grantRes = await do1.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60 }, { Authorization: `Bearer ${hostToken}` }),
    );
    const { bearer } = (await grantRes.json()) as { bearer: string };
    // Dispatch OP and let the instance "die" before the ack: the op is "dispatched" in the durable
    // store, but its in-memory pending send (and thus its ack correlation) dies with the instance.
    const inFlight = workerFetch(routeKey, do1, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", operation_id: OP })));
    inFlight.catch(() => {}); // settles later via the 5s ack timeout; not awaited here
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    expect((sharedStore.get("mcpOps") as McpOpRecord[]).find((o) => o.operationId === OP)?.state).toBe("dispatched");
    // Reconstruct a new DO over the same store (hibernation/eviction). The orphaned op must be
    // recovered as delivery_uncertain — never stranded in_flight, and never re-dispatched.
    const { do: do2 } = await makeDo("ORPHAN", hostSocket, true, sharedStore);
    const recovered = (sharedStore.get("mcpOps") as McpOpRecord[]).find((o) => o.operationId === OP);
    expect(recovered?.state).toBe("uncertain");
    expect(recovered?.result).toBe("delivery_uncertain");
    // A retry with the same operation_id + identical args returns delivery_uncertain (NOT
    // in_flight) and does not emit a second Send frame.
    const before = hostSocket.sentBinary.length;
    const retry = await toolOutcome(await workerFetch(routeKey, do2, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo hi", operation_id: OP }))));
    expect(retry.ok).toBe(true);
    expect(retry.result?.delivered).toBe(false);
    expect(retry.result?.reason).toBe("delivery_uncertain");
    expect(hostSocket.sentBinary.length).toBe(before);
  }, 10000);

  it("encrypted session: seals the outbound Send frame and opens the inbound SendAck", async () => {
    const { do: do_, hostSocket, routeKey, bearer, cipher } = await setupControl({ encrypted: true });
    expect(cipher).toBeDefined();
    const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", enter: true, operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame");
    // (a) The bytes actually handed to the host are SEALED — they differ from the plaintext Send
    // frame and open (with the session frame key) back to exactly that frame (reconstructed with
    // the DO's dispatch token).
    const sealed = hostSocket.sentBinary[0];
    const opened = await cipher!.open(sealed);
    const decoded = decodeSend(opened);
    expect(decoded).not.toBeNull();
    expect(decoded?.operationId).toBe(OP);
    expect(decoded?.enter).toBe(true);
    expect(new TextDecoder().decode(decoded?.text ?? new Uint8Array())).toBe("echo hi");
    const reconstructed = encodeSend(OP, decoded!.enter, decoded!.dispatchToken, decoded!.text);
    expect(bytesEqual(opened, reconstructed)).toBe(true);
    const plaintext = encodeSend(OP, true, decoded!.dispatchToken, new TextEncoder().encode("echo hi"));
    expect(sealed.byteLength).toBeGreaterThan(plaintext.byteLength);
    expect(bytesEqual(sealed, plaintext)).toBe(false);
    // (b) The host acks with a SEALED SendAck (echoing the dispatch token); the DO opens it and
    // correlates the delivery.
    await sendAck(do_, hostSocket, OP, decoded!.dispatchToken, SEND_RESULT_DELIVERED, cipher!);
    const outcome = await toolOutcome(await withTimeout(mcpPromise, 4000));
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.delivered).toBe(true);
    expect(outcome.result?.reason).toBe("delivered");
  });

  it("F1: a grant revoked while the dispatch awaits the cipher does not emit the Send frame", async () => {
    const { do: do_, hostSocket, routeKey, bearer, hostToken } = await setupControl({ encrypted: true });
    const any = do_ as unknown as DoInternals;
    // Deterministic interleaving: park the DO's seal() await behind a gate so the grant can be
    // revoked while mcpDispatchSend is between its cipher awaits and the frame send.
    const realSeal = BrowserFrameCipher.prototype.seal;
    let releaseSeal: (() => void) | null = null;
    const sealGate = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });
    const sealSpy = vi
      .spyOn(BrowserFrameCipher.prototype, "seal")
      .mockImplementation(async function (this: BrowserFrameCipher, frame: Uint8Array) {
        await sealGate;
        return realSeal.call(this, frame);
      });
    try {
      const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", enter: true, operation_id: OP })));
      // The op is claimed + marked dispatched: mcpDispatchSend is running and its seal() is parked
      // on the gate.
      await waitFor(() => (any.mcpOps.find((o) => o.operationId === OP)?.state ?? "") === "dispatched", 2000, "op dispatched");
      // Revoke the grant DURING that await (aborts the request and prunes the grant).
      const listRes = await do_.fetch(new Request("https://shell.online/internal/mcp/grants", { method: "GET", headers: { Authorization: `Bearer ${hostToken}` } }));
      const { grants } = (await listRes.json()) as { grants: Array<{ grant_id: string }> };
      const revokeRes = await do_.fetch(
        new Request("https://shell.online/internal/mcp/grant", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ grant_id: grants[0].grant_id }) }),
      );
      expect(revokeRes.status).toBe(200);
      // Release the seal: the post-await recheck (aborted / host / run / grant live) now runs
      // IMMEDIATELY BEFORE safeSend and must veto the send.
      releaseSeal!();
      const outcome = await toolOutcome(await withTimeout(mcpPromise, 4000));
      // Never "delivered" when the grant was revoked mid-dispatch.
      expect(outcome.ok ? outcome.result?.delivered : false).toBe(false);
      // No Send frame was ever handed to the host (on the old code the frame was emitted right
      // after the seal, before any recheck).
      expect(hostSocket.sentBinary.length).toBe(0);
    } finally {
      sealSpy.mockRestore();
    }
  }, 10000);

  it("F2: a DELAYED ack (stale dispatch token) does not resolve a different grant's same-UUID op", async () => {
    const { do: do_, hostSocket, routeKey, bearer, hostToken } = await setupControl();
    const any = do_ as unknown as DoInternals;
    // A second grant on the same session (same run).
    const grantRes = await do_.fetch(
      postJson("https://shell.online/internal/mcp/grant", { scopes: ["input", "observe"], lifetime: 60, label: "second" }, { Authorization: `Bearer ${hostToken}` }),
    );
    expect(grantRes.status).toBe(201);
    const { bearer: bearer2 } = (await grantRes.json()) as { bearer: string };
    // Grant A dispatches UUID-X (in flight); capture A's dispatch token from the Send frame.
    const a = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo a", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 0, 2000, "Send frame A");
    const tokenA = await sentSendToken(hostSocket, 0);
    // Settle A deterministically as uncertain (its own ack): A's dispatch index entry is removed.
    await sendAck(do_, hostSocket, OP, tokenA, SEND_RESULT_UNCERTAIN);
    const aOutcome = await toolOutcome(await withTimeout(a, 4000));
    expect(aOutcome.ok).toBe(true);
    expect(aOutcome.result?.reason).toBe("delivery_uncertain");
    // Grant B reuses the SAME UUID-X: a fresh claim + dispatch with a DIFFERENT token.
    const b = workerFetch(routeKey, do_, workerMcpRequest(bearer2, call("shell_send", 2, { text: "echo b", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length > 1, 2000, "Send frame B");
    const tokenB = await sentSendToken(hostSocket, 1);
    expect(bytesEqual(tokenA, tokenB)).toBe(false);
    // A's DELAYED ack (A's token, delivered result) now arrives. On the old operationId-keyed
    // index it would resolve B (B re-registered UUID-X); keyed by token it must be IGNORED.
    await sendAck(do_, hostSocket, OP, tokenA, SEND_RESULT_DELIVERED);
    // The ack handler is void-async in the DO; give it a tick, then assert B is STILL in flight:
    // its durable record is still "dispatched" and the dispatch index holds exactly B's dispatch.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const bRecord = any.mcpOps.find((o) => o.operationId === OP && o.state === "dispatched");
    expect(bRecord).toBeDefined();
    expect(any.mcpSendDispatchIndex.size).toBe(1);
    expect([...any.mcpSendDispatchIndex.values()]).toEqual([
      { runId: bRecord!.runId, grantId: bRecord!.grantId, operationId: OP },
    ]);
    // B's OWN ack (its token) is what completes it.
    await sendAck(do_, hostSocket, OP, tokenB, SEND_RESULT_DELIVERED);
    const bOutcome = await toolOutcome(await withTimeout(b, 4000));
    expect(bOutcome.ok).toBe(true);
    expect(bOutcome.result?.delivered).toBe(true);
    expect(bOutcome.result?.reason).toBe("delivered");
  }, 10000);

  it("G1: revoking the last grant while the dispatch allocates the cipher emits no Send frame and retains no decryption capability", async () => {
    const { do: do_, hostSocket, routeKey, bearer, hostToken, cipher } = await setupControl({ encrypted: true });
    const any = do_ as unknown as DoInternals;
    // Deterministic interleaving: park the cipher IMPORT (BrowserFrameCipher.fromKey) behind a
    // gate so the grant can be revoked while mcpEnsureCipher is between its validity checks.
    // (On the old code the import resolved straight into `this.mcpCipher = ...`, installing the
    // cipher even though the operation was revoked.)
    const realFromKey = BrowserFrameCipher.fromKey;
    let parked = false;
    let releaseKey: (() => void) | null = null;
    const keyGate = new Promise<void>((resolve) => {
      releaseKey = resolve;
    });
    const fromKeySpy = vi
      .spyOn(BrowserFrameCipher, "fromKey")
      .mockImplementation(async (key: Uint8Array<ArrayBuffer>) => {
        parked = true;
        await keyGate;
        return realFromKey(key);
      });
    try {
      const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", enter: true, operation_id: OP })));
      // Wait until mcpDispatchSend is actually PARKED inside the cipher import (not just claimed):
      // only then does the revocation land between the pre-allocation and post-import checks.
      await waitFor(() => parked, 2000, "cipher allocation parked in fromKey");
      expect(any.mcpCipher).toBeNull(); // not installed yet
      // Revoke the LAST grant while parked (aborts the in-flight request; the revoke's own
      // model-free finds no cipher to clear — it has not been installed yet).
      const listRes = await do_.fetch(new Request("https://shell.online/internal/mcp/grants", { method: "GET", headers: { Authorization: `Bearer ${hostToken}` } }));
      const { grants } = (await listRes.json()) as { grants: Array<{ grant_id: string }> };
      const revokeRes = await do_.fetch(
        new Request("https://shell.online/internal/mcp/grant", { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ grant_id: grants[0].grant_id }) }),
      );
      expect(revokeRes.status).toBe(200);
      // Release the gate: the post-import validity check sees the revoked grant / aborted
      // request and must NOT install the cipher; the dispatch is not sent.
      releaseKey!();
      const outcome = await toolOutcome(await withTimeout(mcpPromise, 4000));
      // Revoked mid-dispatch: audited as revoked, never delivered.
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/no longer active|revoked/i);
      // (a) Zero Send frames handed to the host.
      expect(hostSocket.sentBinary.length).toBe(0);
      // (b) No retained decryption capability: the cipher is not installed by the revoked
      // operation, and the DO cannot open a freshly sealed frame.
      expect(any.mcpCipher).toBeNull();
      const fresh = await cipher!.seal(encodeSendAck(OP, crypto.getRandomValues(new Uint8Array(16)), SEND_RESULT_DELIVERED));
      expect(await any.mcpFramePlaintext(fresh)).toBeNull();
    } finally {
      fromKeySpy.mockRestore();
    }
  }, 10000);

  it("G2: a human typing during the dispatch (inside the DO's 1.8s lease) vetoes the send at the final guard", async () => {
    const { do: do_, hostSocket, routeKey, bearer } = await setupControl({ encrypted: true });
    // Deterministic interleaving: park the dispatch inside seal() (between the awaits and the
    // frame send), exactly as the F1 regression does.
    const realSeal = BrowserFrameCipher.prototype.seal;
    let parked = false;
    let releaseSeal: (() => void) | null = null;
    const sealGate = new Promise<void>((resolve) => {
      releaseSeal = resolve;
    });
    const sealSpy = vi
      .spyOn(BrowserFrameCipher.prototype, "seal")
      .mockImplementation(async function (this: BrowserFrameCipher, frame: Uint8Array) {
        parked = true;
        await sealGate;
        return realSeal.call(this, frame);
      });
    try {
      const mcpPromise = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 1, { text: "echo hi", enter: true, operation_id: OP })));
      // Wait until mcpDispatchSend is actually parked inside seal().
      await waitFor(() => parked, 2000, "dispatch parked in seal");
      // While parked, a human starts typing locally: a `local_typing` update through the host
      // socket makes the host attachment's localTypingAt fresh (inside the DO's 1.8s lease).
      await do_.webSocketMessage(asWs(hostSocket), JSON.stringify({ type: "local_typing" }));
      const attachment = hostSocket.deserializeAttachment() as Record<string, unknown>;
      expect(typeof attachment.localTypingAt).toBe("number");
      // Resume: the post-await recheck must re-evaluate human priority with the DO's
      // TYPING_LEASE_MS (not the host's 250ms window) and veto the send.
      releaseSeal!();
      const outcome = await toolOutcome(await withTimeout(mcpPromise, 4000));
      // Not dispatched because a human has priority: delivery_uncertain (never "delivered").
      expect(outcome.ok).toBe(true);
      expect(outcome.result?.delivered).toBe(false);
      expect(outcome.result?.reason).toBe("delivery_uncertain");
      // Zero Send frames handed to the host (on the old code the frame was emitted).
      expect(hostSocket.sentBinary.length).toBe(0);
      // Duplicate protection: the durable op is uncertain, so a retry with the same
      // operation_id replays delivery_uncertain and is NOT re-dispatched.
      const retry = await toolOutcome(await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_send", 2, { text: "echo hi", enter: true, operation_id: OP }))));
      expect(retry.ok).toBe(true);
      expect(retry.result?.delivered).toBe(false);
      expect(retry.result?.reason).toBe("delivery_uncertain");
      expect(hostSocket.sentBinary.length).toBe(0);
    } finally {
      sealSpy.mockRestore();
    }
  }, 10000);
});

describe("upstream integration", () => {
  it("migrates a pre-MCP session to one stable durable run identity", async () => {
    const store = new Map<string, unknown>([["meta", initBody(await sha256Hex("migration-host"))]]);
    const host = makeHostSocket();
    await makeDo("MIGRATION", host, false, store);
    const first = (store.get("meta") as { runId: string }).runId;
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    await makeDo("MIGRATION", host, false, store);
    expect((store.get("meta") as { runId: string }).runId).toBe(first);
  });

  it("password rotation cancels a pending encrypted write and requires a fresh key-bearing grant", async () => {
    const { do: do_, hostSocket, routeKey, bearer, hostToken, cipher } = await setupControl({ encrypted: true });
    const pending = workerFetch(routeKey, do_, workerMcpRequest(bearer,
      call("shell_send", 1, { text: "old-key", operation_id: OP })));
    await waitFor(() => hostSocket.sentBinary.length === 1, 2000, "old-key dispatch");
    const token = await sentSendToken(hostSocket, 0, cipher);
    await do_.webSocketMessage(asWs(hostSocket), JSON.stringify({ type: "credentials_rotate" }));
    const result = await toolOutcome(await withTimeout(pending, 2000));
    expect(result.result?.delivered).not.toBe(true);
    expect((do_ as unknown as DoInternals).mcpCipher).toBeNull();
    const denied = await workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_status", 2, {})));
    expect(denied.status).toBe(401);
    await sendAck(do_, hostSocket, OP, token, SEND_RESULT_DELIVERED, cipher);
    expect((do_ as unknown as DoInternals).mcpCipher).toBeNull();
    const key = crypto.getRandomValues(new Uint8Array(32));
    const freshHost = await BrowserFrameCipher.fromKey(key);
    const issuance = await do_.fetch(postJson("https://shell.online/internal/mcp/grant",
      { scopes: ["observe", "input"], lifetime: 60, frame_key: base64url.encode(key) },
      { Authorization: "Bearer " + hostToken }));
    expect(issuance.status).toBe(201);
    const fresh = await issuance.json() as { bearer: string };
    const next = workerFetch(routeKey, do_, workerMcpRequest(fresh.bearer,
      call("shell_send", 3, { text: "new-key", operation_id: OP2 })));
    await waitFor(() => hostSocket.sentBinary.length === 2, 2000, "new-key dispatch");
    const opened = decodeSend(await freshHost.open(hostSocket.sentBinary[1]));
    expect(new TextDecoder().decode(opened!.text)).toBe("new-key");
    await sendAck(do_, hostSocket, OP2, opened!.dispatchToken, SEND_RESULT_DELIVERED, freshHost);
    expect((await toolOutcome(await withTimeout(next, 2000))).result?.delivered).toBe(true);
    await do_.webSocketMessage(asWs(hostSocket), JSON.stringify({ type: "credentials_rotate" }));
  });

  it("never installs an old cipher after rotation even if another grant is now live", async () => {
    const { do: do_, hostSocket, hostToken, routeKey, bearer } = await setupControl({ encrypted: true });
    let resume!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((r) => { resume = r; });
    const started = new Promise<void>((r) => { entered = r; });
    const original = BrowserFrameCipher.fromKey.bind(BrowserFrameCipher);
    const spy = vi.spyOn(BrowserFrameCipher, "fromKey").mockImplementation(async (key) => {
      entered(); await held; return original(key);
    });
    const request = workerFetch(routeKey, do_, workerMcpRequest(bearer, call("shell_screen", 5, {})));
    try {
      await withTimeout(started, 1000);
      await do_.webSocketMessage(asWs(hostSocket), JSON.stringify({ type: "credentials_rotate" }));
      const fresh = await do_.fetch(postJson("https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 60, frame_key: base64url.encode(new Uint8Array(32).fill(8)) },
        { Authorization: "Bearer " + hostToken }));
      expect(fresh.status).toBe(201);
      resume();
      await withTimeout((await request).text(), 2000);
      expect((do_ as unknown as DoInternals).mcpCipher).toBeNull();
    } finally {
      resume(); spy.mockRestore();
      await do_.webSocketMessage(asWs(hostSocket), JSON.stringify({ type: "credentials_rotate" }));
    }
  });
});
