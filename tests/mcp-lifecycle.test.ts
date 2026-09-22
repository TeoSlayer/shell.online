import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64url, exportJWK, generateKeyPair } from "jose";
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
import { setMcpTelemetrySink } from "../shared/mcp-status";

describe("PostHog relay milestones", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([true, false])("mirrors bounded install outcomes only when enabled=%s", async (enabled) => {
    const fetcher = vi.fn(async () => new Response("1"));
    vi.stubGlobal("fetch", fetcher);
    const tasks: Promise<unknown>[] = [];
    const env = { ...makeEnv("unused", "unused"), POSTHOG_ENABLED: enabled ? "1" : undefined };
    const response = await worker.fetch(new Request("https://shell.online/install/report?outcome=ok&secret=PRIVATE_CONTENT", {
      headers: { "User-Agent": "curl/8", "Authorization": "Bearer PRIVATE_CREDENTIAL", "CF-Connecting-IP": "192.0.2.42" },
    }) as never, env as never, { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as never);
    expect(response.status).toBe(204);
    await Promise.all(tasks);
    expect(fetcher).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) {
      const calls = vi.mocked(fetch).mock.calls;
      const payload = JSON.parse(String(calls[0][1]?.body));
      expect(payload).toMatchObject({ event: "install_outcome", properties: { surface: "relay", outcome: "ok" } });
      expect(JSON.stringify(calls)).not.toContain("PRIVATE_");
      expect(JSON.stringify(calls)).not.toContain("192.0.2.42");
    }
  });
});

// --- helpers -----------------------------------------------------------------------------

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeEcdhJwk(kid: string): Promise<string> {
  const pair = await generateKeyPair("ECDH-ES", { extractable: true });
  return JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid });
}

function makeMockState(idName: string) {
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
    getWebSockets: () => [],
    waitUntil: () => {},
    acceptWebSocket: () => {},
  };
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

async function makeDoWithKeys(
  sessionId: string,
): Promise<{ do: TerminalSession; routeKey: string; frameKey: string }> {
  const route = await makeEcdhJwk("route-v1");
  const frame = await makeEcdhJwk("frame-v1");
  const do_ = new TerminalSession(makeMockState(sessionId) as never, makeEnv(route, frame) as never);
  // Let the constructor's blockConcurrencyWhile settle (loads meta/grants from empty storage).
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { do: do_, routeKey: route, frameKey: frame };
}

async function makeDo(sessionId: string): Promise<TerminalSession> {
  return (await makeDoWithKeys(sessionId)).do;
}

function initBody(hostTokenHash: string, opts: { persistent?: boolean } = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    hostTokenHash,
    readOnly: false,
    encrypted: false,
    persistent: opts.persistent ?? false,
    label: "test-session",
    createdAt: now,
    expiresAt: now + 3_600_000,
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

// Poll until condition() is true (or time out). Used to wait for an in-flight MCP request to be
// admitted (registered) before triggering a cancellation, so the test exercises active
// cancellation of an in-flight request rather than a pre-admission rejection.
async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > ms) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A held request body: a ReadableStream whose pull never resolves until released, so the DO's
// readLimitedBody stays pending (the request is "in flight"). Tracks whether the reader was
// cancelled (proof of active cancellation of the in-flight body read).
function heldBody(): { stream: ReadableStream<Uint8Array>; wasCancelled: () => boolean; release: () => void } {
  let cancelled = false;
  let pullResolve: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        pullResolve = () => {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
          resolve();
        };
      });
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled, release: () => pullResolve?.() };
}

function mcpRequest(
  bearer: string,
  body: ReadableStream<Uint8Array> | string,
  headers: Record<string, string> = {},
): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      ...(bearer ? { "X-Mcp-Bearer": bearer } : {}),
      ...headers,
    },
    body: body as BodyInit,
  };
  if (typeof body !== "string") init.duplex = "half";
  return new Request("https://shell.online/internal/mcp", init);
}

const MCP_TOOLS_CALL = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "shell_status", arguments: {} },
});

// A request to the Worker's public /mcp edge route: the bearer rides in Authorization (the Worker
// strips it, verifies the outer envelope, and forwards X-Mcp-Bearer/X-Mcp-Route to the DO).
function workerMcpRequest(bearer: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://shell.online/mcp", {
    method: "POST",
    headers: {
      // Cloudflare sets Host from the edge; a Node URL-derived Request has no Host header, so set
      // it explicitly to match production (the Worker's Host validation reads headers.get("host")).
      Host: "shell.online",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body,
  });
}

// A Worker env whose SESSIONS namespace forwards to a real DO instance, so the exported Worker
// handler drives the same DO harness the lifecycle/redaction tests use.
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

// --- lifecycle: held (in-flight) request cancellation ------------------------------------

describe("MCP lifecycle: in-flight request cancellation", () => {
  it("grant expiry cancels a held in-flight request, settles it, and releases the slot", () => withGrantClock(async (expire) => {
    const hostToken = "host-token-expiry";
    const hostTokenHash = await sha256Hex(hostToken);
    const do_ = await makeDo("SESS_EXPIRY_TEST_ID");

    const initRes = await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));
    expect(initRes.status).toBe(200);

    // A 1-second grant: the shortest lifetime the API allows.
    const grantRes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 1, label: "expiry-grant" },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(grantRes.status).toBe(201);
    const { bearer, grant_id } = (await grantRes.json()) as { bearer: string; grant_id: string };

    // Send an MCP request with a held body -> admitted and in flight (body read pending).
    const held = heldBody();
    const mcpPromise = do_.fetch(mcpRequest(bearer, held.stream));
    // Wait until the request is admitted (inflight slot held) so the expiry cancels an in-flight
    // request, not a not-yet-admitted one.
    await waitFor(() => (do_ as unknown as { mcpInflightTotal: number }).mcpInflightTotal === 1, 1000, "mcp admission");

    // The grant's fixed expiry fires the scheduled cancellation: the body reader is aborted, the
    // request settles, and the inflight slot is released.
    expire(1);
    const response = await withTimeout(mcpPromise, 4000);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("grant no longer active");
    expect(held.wasCancelled()).toBe(true);
    expect((do_ as unknown as { mcpInflightTotal: number }).mcpInflightTotal).toBe(0);
    expect((do_ as unknown as { mcpInflight: Map<string, number> }).mcpInflight.get(grant_id)).toBe(0);
  }));

  it("persistent resume cancels a held in-flight request, settles it, and releases the slot", async () => {
    const hostToken = "host-token-resume";
    const hostTokenHash = await sha256Hex(hostToken);
    const do_ = await makeDo("SESS_RESUME_TEST_ID");

    const initRes = await do_.fetch(
      postJson("https://shell.online/internal/init", initBody(hostTokenHash, { persistent: true })),
    );
    expect(initRes.status).toBe(200);

    const grantRes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 3600, label: "resume-grant" },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(grantRes.status).toBe(201);
    const { bearer, grant_id } = (await grantRes.json()) as { bearer: string; grant_id: string };

    // Send an MCP request with a held body -> admitted and in flight.
    const held = heldBody();
    const mcpPromise = do_.fetch(mcpRequest(bearer, held.stream));
    // Wait until the request is admitted (inflight slot held) so the resume cancels an in-flight
    // request, not a not-yet-admitted one.
    await waitFor(() => (do_ as unknown as { mcpInflightTotal: number }).mcpInflightTotal === 1, 1000, "mcp admission");

    // A resume starts a new run and clears grants; it must cancel the old run's in-flight request
    // before resetting state.
    const resumeRes = await do_.fetch(
      postJson("https://shell.online/internal/resume", initBody(hostTokenHash, { persistent: true })),
    );
    expect(resumeRes.status).toBe(200);

    const response = await withTimeout(mcpPromise, 4000);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("grant no longer active");
    expect(held.wasCancelled()).toBe(true);
    expect((do_ as unknown as { mcpInflightTotal: number }).mcpInflightTotal).toBe(0);
    expect((do_ as unknown as { mcpInflight: Map<string, number> }).mcpInflight.get(grant_id)).toBe(0);
  });
});

// --- redaction: Worker/DO handler integration --------------------------------------------

describe("MCP handler redaction (integration)", () => {
  let telemetry: Record<string, unknown>[];
  let consoleLines: string[];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    telemetry = [];
    consoleLines = [];
    setMcpTelemetrySink((event) => telemetry.push(event));
    const capture = (...args: unknown[]) => consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    for (const method of ["log", "error", "warn", "info"] as const) {
      spies.push(vi.spyOn(console, method).mockImplementation(capture));
    }
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    setMcpTelemetrySink(() => {});
  });

  function allOutput(): string {
    return [JSON.stringify(telemetry), ...consoleLines].join("\n").toLowerCase();
  }

  it("successful issuance + status leak no credentials or request content", async () => {
    const sessionId = "SECRET_SESSION_ID_MARKER";
    const hostToken = "SECRET_HOST_TOKEN_MARKER";
    const hostTokenHash = await sha256Hex(hostToken);
    const do_ = await makeDo(sessionId);

    await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));

    // Successful issuance.
    const grantRes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 60, label: "SECRET_GRANT_LABEL_MARKER" },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(grantRes.status).toBe(201);
    const { bearer, grant_id } = (await grantRes.json()) as { bearer: string; grant_id: string };

    // Successful status.
    const statusRes = await do_.fetch(mcpRequest(bearer, MCP_TOOLS_CALL));
    expect(statusRes.status).toBe(200);

    const output = allOutput();
    for (const marker of [sessionId, hostToken, "secret_grant_label_marker", grant_id, bearer]) {
      expect(output).not.toContain(marker.toLowerCase());
    }
  });

  it("invalid authentication leaks no bearer or session id", async () => {
    const sessionId = "SECRET_SESSION_ID_MARKER_2";
    const hostToken = "SECRET_HOST_TOKEN_MARKER_2";
    const hostTokenHash = await sha256Hex(hostToken);
    const do_ = await makeDo(sessionId);
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));

    const noBearer = await do_.fetch(mcpRequest("", MCP_TOOLS_CALL));
    expect(noBearer.status).toBe(401);

    const badBearer = await do_.fetch(mcpRequest("not-a-real-bearer", MCP_TOOLS_CALL));
    expect(badBearer.status).toBe(401);

    const output = allOutput();
    for (const marker of [sessionId, hostToken, "not-a-real-bearer"]) {
      expect(output).not.toContain(marker.toLowerCase());
    }
  });

  it("malformed requests leak no credentials", async () => {
    const sessionId = "SECRET_SESSION_ID_MARKER_3";
    const hostToken = "SECRET_HOST_TOKEN_MARKER_3";
    const hostTokenHash = await sha256Hex(hostToken);
    const do_ = await makeDo(sessionId);
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));

    // Malformed grant (unknown scope).
    const badScopes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["bogus"], lifetime: 60 },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(badScopes.status).toBe(400);

    // Unauthorized grant (wrong host token).
    const unauthorized = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 60 },
        { Authorization: "Bearer wrong-token" },
      ),
    );
    expect(unauthorized.status).toBe(401);

    const output = allOutput();
    for (const marker of [sessionId, hostToken]) {
      expect(output).not.toContain(marker.toLowerCase());
    }
  });

  it("revocation leaks no credentials or grant identity", async () => {
    const sessionId = "SECRET_SESSION_ID_MARKER_4";
    const hostToken = "SECRET_HOST_TOKEN_MARKER_4";
    const hostTokenHash = await sha256Hex(hostToken);
    const do_ = await makeDo(sessionId);
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));

    const grantRes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 60, label: "SECRET_GRANT_LABEL_MARKER_4" },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(grantRes.status).toBe(201);
    const { grant_id } = (await grantRes.json()) as { grant_id: string };

    const revokeRes = await do_.fetch(
      new Request("https://shell.online/internal/mcp/grant", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ grant_id }),
      }),
    );
    expect(revokeRes.status).toBe(200);

    const output = allOutput();
    for (const marker of [sessionId, hostToken, "secret_grant_label_marker_4", grant_id]) {
      expect(output).not.toContain(marker.toLowerCase());
    }
  });
});

// --- redaction: Worker route (edge → DO) integration -------------------------------------

// These route /mcp requests through the exported Worker handler (the real edge: rate limit,
// Host/Origin, bearer size, outer-envelope verification, header allowlist) into the same DO
// harness, so the redaction gate is exercised on the public route rather than the internal DO
// endpoint. Markers cover credentials, the frame key, unexpected tool arguments, and malformed
// MCP input; each response body is fully consumed before captured output is inspected.
describe("MCP redaction (Worker route)", () => {
  let telemetry: Record<string, unknown>[];
  let consoleLines: string[];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  const ctxShim = { waitUntil: () => {} };

  beforeEach(() => {
    telemetry = [];
    consoleLines = [];
    setMcpTelemetrySink((event) => telemetry.push(event));
    const capture = (...args: unknown[]) => consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    for (const method of ["log", "error", "warn", "info"] as const) {
      spies.push(vi.spyOn(console, method).mockImplementation(capture));
    }
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    setMcpTelemetrySink(() => {});
  });

  function allOutput(): string {
    return [JSON.stringify(telemetry), ...consoleLines].join("\n").toLowerCase();
  }

  function workerFetch(routeKey: string, do_: TerminalSession, request: Request): Promise<Response> {
    return worker.fetch(request as never, makeWorkerEnv(routeKey, do_) as never, ctxShim as never);
  }

  it("successful status returns the result and leaks no credentials or frame key", async () => {
    const sessionId = "SECRET_SESSION_ID_W1";
    const hostToken = "SECRET_HOST_TOKEN_W1";
    const hostTokenHash = await sha256Hex(hostToken);
    const { do: do_, routeKey } = await makeDoWithKeys(sessionId);

    await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));

    // 32-byte frame key with recognizable content so a leak in its raw or base64url form is caught.
    const frameKeyText = "SECRET_FRAME_KEY_ABCDEFGH1234567"; // gitleaks:allow -- synthetic redaction marker
    const frameKeyB64 = base64url.encode(new TextEncoder().encode(frameKeyText));

    const grantRes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 60, label: "SECRET_GRANT_LABEL_W1", frame_key: frameKeyB64 },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(grantRes.status).toBe(201);
    const { bearer, grant_id } = (await grantRes.json()) as { bearer: string; grant_id: string };

    // Route the MCP request through the exported Worker handler into the DO.
    const response = await workerFetch(routeKey, do_, workerMcpRequest(bearer, MCP_TOOLS_CALL));
    expect(response.status).toBe(200);
    // Consume the complete response, then verify it actually carries the expected status result.
    // The response is an SSE stream; the shell_status result is nested in the data line's JSON.
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const rpc = JSON.parse(dataLine!.slice("data: ".length)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const status = JSON.parse(rpc.result.content[0].text) as { status: string };
    expect(status.status).toBe("waiting");

    const output = allOutput();
    for (const marker of [
      sessionId, hostToken, "secret_grant_label_w1", grant_id, bearer,
      frameKeyText.toLowerCase(), frameKeyB64.toLowerCase(),
    ]) {
      expect(output).not.toContain(marker.toLowerCase());
    }
  });

  it("auth failures leak no bearer or session id", async () => {
    const sessionId = "SECRET_SESSION_ID_W2";
    const hostToken = "SECRET_HOST_TOKEN_W2";
    const hostTokenHash = await sha256Hex(hostToken);
    const { do: do_, routeKey } = await makeDoWithKeys(sessionId);
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));

    const noBearer = await workerFetch(routeKey, do_, workerMcpRequest("", MCP_TOOLS_CALL));
    expect(noBearer.status).toBe(401);
    await noBearer.text();

    const invalid = await workerFetch(routeKey, do_, workerMcpRequest("SECRET_INVALID_BEARER_W2", MCP_TOOLS_CALL));
    expect(invalid.status).toBe(401);
    await invalid.text();

    const tooLarge = await workerFetch(
      routeKey,
      do_,
      workerMcpRequest("SECRET_TOOLONG_BEARER_W2" + "x".repeat(8192), MCP_TOOLS_CALL),
    );
    expect(tooLarge.status).toBe(401);
    await tooLarge.text();

    const output = allOutput();
    for (const marker of [sessionId, hostToken, "secret_invalid_bearer_w2", "secret_toolong_bearer_w2"]) { // gitleaks:allow -- synthetic invalid bearers
      expect(output).not.toContain(marker.toLowerCase());
    }
  });

  it("unexpected tool arguments and malformed input leak no request content", async () => {
    const sessionId = "SECRET_SESSION_ID_W3";
    const hostToken = "SECRET_HOST_TOKEN_W3";
    const hostTokenHash = await sha256Hex(hostToken);
    const { do: do_, routeKey } = await makeDoWithKeys(sessionId);
    await do_.fetch(postJson("https://shell.online/internal/init", initBody(hostTokenHash)));

    const grantRes = await do_.fetch(
      postJson(
        "https://shell.online/internal/mcp/grant",
        { scopes: ["observe"], lifetime: 60 },
        { Authorization: `Bearer ${hostToken}` },
      ),
    );
    expect(grantRes.status).toBe(201);
    const { bearer } = (await grantRes.json()) as { bearer: string };

    // Unexpected tool arguments (the shell_status tool takes none; its inputSchema is empty).
    const unexpectedArgs = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "shell_status", arguments: { foo: "SECRET_TOOL_ARG_W3" } },
    });
    await (await workerFetch(routeKey, do_, workerMcpRequest(bearer, unexpectedArgs))).text();

    // Malformed MCP input (not valid JSON).
    await (await workerFetch(routeKey, do_, workerMcpRequest(bearer, "{ not valid json SECRET_MALFORMED_W3 }"))).text();

    const output = allOutput();
    for (const marker of [sessionId, hostToken, bearer, "secret_tool_arg_w3", "secret_malformed_w3"]) {
      expect(output).not.toContain(marker.toLowerCase());
    }
  });
});
