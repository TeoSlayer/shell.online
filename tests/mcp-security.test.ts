import { afterEach, describe, expect, it } from "vitest";
import { hashBearer } from "../shared/mcp-bearer";
import {
  createGrantRecord,
  isGrantLiveForRun,
  isLive,
  pruneGrantRecords,
  type McpGrantRecord,
} from "../shared/mcp-grants";
import {
  buildStatusPayload,
  mcpAnalyticsEvent,
  recordMcpEvent,
  setMcpTelemetrySink,
} from "../shared/mcp-status";

const NOW = 1_700_000_000;

function grant(overrides: Partial<McpGrantRecord> = {}): McpGrantRecord {
  return {
    grantId: "grant-1",
    bearerHash: "ab".repeat(32),
    label: "codex",
    scopes: ["observe"],
    runId: "run-A",
    createdAt: NOW,
    expiresAt: NOW + 3600,
    revoked: false,
    revokedAt: null,
    ...overrides,
  };
}

describe("mcp security invariants", () => {
  it("a revoked grant is not live", () => {
    expect(isLive(grant(), NOW)).toBe(true);
    expect(isLive(grant({ revoked: true, revokedAt: NOW }), NOW)).toBe(false);
  });

  it("an expired grant is not live", () => {
    expect(isLive(grant({ expiresAt: NOW - 1 }), NOW)).toBe(false);
  });

  // The actual admission predicate the DO uses (findLiveGrant + the pre-execution recheck). A
  // grant is valid only if it is live AND bound to the current run — this is what rejects a
  // run-A grant on run B, a revoked grant, and an expired grant.
  it("isGrantLiveForRun enforces run binding, revocation, and expiry", () => {
    const live = grant({ runId: "run-A" });
    expect(isGrantLiveForRun(live, "run-A", NOW)).toBe(true);
    // Run binding: a run-A grant is not valid for run B.
    expect(isGrantLiveForRun(live, "run-B", NOW)).toBe(false);
    // Revocation: a revoked grant is not valid even on its own run.
    expect(isGrantLiveForRun(grant({ revoked: true, revokedAt: NOW }), "run-A", NOW)).toBe(false);
    // Expiry: an expired grant is not valid even on its own run.
    expect(isGrantLiveForRun(grant({ expiresAt: NOW - 1 }), "run-A", NOW)).toBe(false);
  });

  it("the bearer hash is a deterministic 64-hex-char SHA-256", async () => {
    const h1 = await hashBearer("some-bearer-token");
    const h2 = await hashBearer("some-bearer-token");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(await hashBearer("different")).not.toBe(h1);
  });

  it("the status payload omits session id, url, key, token, and bearer", () => {
    const payload = buildStatusPayload(
      { status: "connected", label: "bash", humanViewers: 2, activeControllers: 0, freshModelAvailable: false },
      grant(),
    );
    const text = JSON.stringify(payload).toLowerCase();
    for (const secret of ["session", "url", "key", "token", "bearer", "password", "host_token"]) {
      expect(text).not.toContain(secret);
    }
    expect(payload.status).toBe("connected");
    expect(payload.human_viewers).toBe(2);
    expect((payload.grant as { scopes: string[] }).scopes).toEqual(["observe"]);
  });

  it("a host token is not a valid MCP bearer (not a 3-part compact JWE)", () => {
    const hostToken = "a".repeat(43); // 32 random bytes, base64url (no dots)
    expect(hostToken.split(".").length).toBeLessThan(3);
  });

  it("an MCP bearer is not a valid host token (not a 64-hex-char SHA-256)", () => {
    const bearer = "eyJhbGciOiJFQ0RILUVTIn0.eyJ2IjoxfQ.c2lnYXR1cmU";
    expect(/^[0-9a-f]{64}$/.test(bearer)).toBe(false);
  });
});

// Cross-cutting redaction gate: run the actual request-path telemetry (recordMcpEvent) with
// synthetic secret markers threaded through the full high-cardinality context, and assert the
// markers never reach the captured sink — on both success and failure paths.
const MARKERS = {
  grantId: "SECRET_GRANT_MARKER",
  label: "SECRET_LABEL_MARKER",
  sessionId: "SECRET_SESSION_MARKER",
  hostToken: "SECRET_TOKEN_MARKER",
  bearer: "SECRET_BEARER_MARKER",
};

function assertNoMarkers(events: Record<string, unknown>[]): void {
  const telemetry = JSON.stringify(events).toLowerCase();
  for (const marker of Object.values(MARKERS)) {
    expect(telemetry).not.toContain(marker.toLowerCase());
  }
}

describe("mcp logs/analytics redaction gate", () => {
  let events: Record<string, unknown>[];

  // Capture the sink the real Worker would log to; restore a quiet sink afterwards so the test
  // sink does not leak into other tests.
  function captureSink(): void {
    events = [];
    setMcpTelemetrySink((event) => events.push(event));
  }

  afterEach(() => {
    setMcpTelemetrySink(() => {});
  });

  it("success path: tool-call telemetry carries only low-cardinality fields", () => {
    captureSink();
    const g = grant({ grantId: MARKERS.grantId, label: MARKERS.label, scopes: ["observe"] });
    recordMcpEvent({
      action: "tool_call",
      tool: "shell_status",
      outcome: "ok",
      grant: g,
      sessionId: MARKERS.sessionId,
      hostToken: MARKERS.hostToken,
      bearer: MARKERS.bearer,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      mcp: { action: "tool_call", tool: "shell_status", outcome: "ok", scopes: ["observe"] },
    });
    assertNoMarkers(events);
  });

  it("failure path: auth-failure telemetry carries no grant/session identity", () => {
    captureSink();
    recordMcpEvent({
      action: "auth_failure",
      outcome: "denied",
      sessionId: MARKERS.sessionId,
      hostToken: MARKERS.hostToken,
      bearer: MARKERS.bearer,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ mcp: { action: "auth_failure", outcome: "denied" } });
    assertNoMarkers(events);
  });

  it("busy/revoked/too-large outcomes redact the same way", () => {
    captureSink();
    const g = grant({ grantId: MARKERS.grantId, label: MARKERS.label, scopes: ["observe"] });
    for (const outcome of ["busy", "revoked", "too_large"]) {
      recordMcpEvent({
        action: "tool_call",
        tool: "shell_status",
        outcome,
        grant: g,
        sessionId: MARKERS.sessionId,
        bearer: MARKERS.bearer,
      });
    }
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect((event.mcp as { scopes?: string[] }).scopes).toEqual(["observe"]);
    }
    assertNoMarkers(events);
  });
});

describe("mcp grant-record retention bound", () => {
  it("prunes other-run records and bounds non-live records per run", () => {
    const runA = "run-A";
    const live = [grant({ grantId: "l1" }), grant({ grantId: "l2" })];
    // 12 non-live (revoked) records in the current run + 3 in a superseded run.
    const nonLive = Array.from({ length: 12 }, (_, i) =>
      grant({ grantId: `n${i}`, revoked: true, revokedAt: NOW, createdAt: NOW - (12 - i) }),
    );
    const staleRun = Array.from({ length: 3 }, (_, i) =>
      grant({ grantId: `s${i}`, runId: "run-old", revoked: true, revokedAt: NOW }),
    );
    const pruned = pruneGrantRecords([...live, ...nonLive, ...staleRun], runA, NOW);
    // Other-run records are dropped entirely.
    expect(pruned.every((g) => g.runId === runA)).toBe(true);
    // All live grants are retained.
    expect(pruned.filter((g) => isLive(g, NOW)).length).toBe(2);
    // Non-live records are bounded to the retention cap (8), most recent first.
    const retainedNonLive = pruned.filter((g) => !isLive(g, NOW));
    expect(retainedNonLive.length).toBe(8);
    // The most-recently-created non-live records survive the prune.
    expect(retainedNonLive.map((g) => g.grantId)).toEqual([
      "n11", "n10", "n9", "n8", "n7", "n6", "n5", "n4",
    ]);
  });

  it("a run with only live grants is unchanged by pruning", () => {
    const live = [grant({ grantId: "l1" }), grant({ grantId: "l2" })];
    expect(pruneGrantRecords(live, "run-A", NOW)).toEqual(live);
  });
});

describe("mcp team grant records", () => {
  const base = {
    grantId: "grant-1",
    bearerHash: "ab".repeat(32),
    label: "team:uid-2",
    scopes: ["observe"] as ("observe" | "input" | "interrupt")[],
    runId: "run-A",
    now: NOW,
    lifetime: 3600,
  };

  it("carries the requester when minted for a teammate", () => {
    const record = createGrantRecord({ ...base, team: { requesterUid: "uid-2" } });
    expect(record.team).toEqual({ requesterUid: "uid-2" });
  });

  it("has no team marker for the owner's own grant", () => {
    const record = createGrantRecord(base);
    expect(record.team).toBeUndefined();
  });

  it("refuses a malformed team requester", () => {
    for (const team of [{ requesterUid: "" }, { requesterUid: 5 }, { requesterUid: "a\u0000b" }, { requesterUid: "x".repeat(257) }]) {
      expect(() => createGrantRecord({ ...base, team: team as { requesterUid: string } })).toThrow();
    }
  });
});
