import { describe, expect, it } from "vitest";
import {
  MAX_ALIAS_LEN,
  MAX_EVENTS_PER_SESSION,
  MAX_ID_LEN,
  MAX_SESSIONS,
  classifyMcpTool,
  isId,
  isUuidV4,
  parseWorkshopEvent,
  parseWorkshopRequest,
  parseWorkshopRoster,
  parseWorkshopSession,
  sanitizeAlias,
} from "./contracts";
import { T0, makeSession, outputEvent } from "./fixtures";

const NOW = T0;
const SESSION_ID = "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f";

const wireSession = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION_ID,
  runId: "run-0001",
  ownerUid: "owner-0001",
  displayAlias: "Worker one",
  connection: "connected",
  receivedAt: NOW - 1_000,
  activitySupported: true,
  events: [],
  ...overrides,
});

describe("contract classification and identity", () => {
  it("classifies shell_send as the only send; every other tool is a read", () => {
    expect(classifyMcpTool("shell_send")).toBe("send");
    for (const tool of ["shell_status", "shell_screen", "shell_output", "shell_wait"]) {
      expect(classifyMcpTool(tool as "shell_status")).toBe("read");
    }
  });

  it("accepts bounded ids and canonical v4 uuids, rejects the rest", () => {
    expect(isId(SESSION_ID)).toBe(true);
    expect(isId("a".repeat(MAX_ID_LEN))).toBe(true);
    expect(isId("a".repeat(MAX_ID_LEN + 1))).toBe(false);
    expect(isId("has space")).toBe(false);
    expect(isId("")).toBe(false);
    expect(isId(42)).toBe(false);
    expect(isUuidV4(SESSION_ID)).toBe(true);
    expect(isUuidV4("6f1d9f5e-4a1b-3c8d-9f2e-0b7c3a5d1e2f")).toBe(false);
  });

  it("sanitises an alias: drops URLs, collapses control chars, bounds length", () => {
    expect(sanitizeAlias("Wright")).toBe("Wright");
    expect(sanitizeAlias("see https://example.com/x now")).toBe("see now");
    expect(sanitizeAlias("a" + String.fromCharCode(0) + "b" + String.fromCharCode(0x1f) + "c")).toBe("a b c");
    expect(sanitizeAlias("x".repeat(MAX_ALIAS_LEN + 10)).length).toBe(MAX_ALIAS_LEN);
    expect(sanitizeAlias("")).toBe("");
    expect(sanitizeAlias(7)).toBe("");
  });
});

describe("event validation", () => {
  const output = (overrides: Record<string, unknown> = {}) => ({
    type: "output_observed",
    eventId: SESSION_ID,
    runId: "run-0001",
    sequence: 5,
    observedAt: NOW - 1_000,
    expiresAt: NOW - 1_000 + 8_000,
    ...overrides,
  });

  it("accepts a well-formed event and rejects unknown keys", () => {
    expect(parseWorkshopEvent(output())).not.toBeNull();
    // A content key must not ride in — that is how terminal text leaks.
    expect(parseWorkshopEvent(output({ text: "secret" }))).toBeNull();
    expect(parseWorkshopEvent(output({ type: "mystery" }))).toBeNull();
    expect(parseWorkshopEvent(null)).toBeNull();
  });

  it("enforces run binding, sequence and expiry ordering", () => {
    expect(parseWorkshopEvent(output({ sequence: -1 }))).toBeNull();
    expect(parseWorkshopEvent(output({ observedAt: -1 }))).toBeNull();
    expect(parseWorkshopEvent(output({ expiresAt: NOW - 2_000 }))).toBeNull();
    expect(parseWorkshopEvent(output({ eventId: "too long ".padEnd(MAX_ID_LEN + 1, "x") }))).toBeNull();
  });

  it("keeps mcp_request started/settled mutually exclusive with outcome", () => {
    const base = output({ type: "mcp_request", requestId: SESSION_ID, tool: "shell_send", phase: "started" });
    expect(parseWorkshopEvent(base)).not.toBeNull();
    expect(parseWorkshopEvent({ ...base, outcome: "ok" })).toBeNull();
    const settled = { ...base, phase: "settled", outcome: "delivered" };
    expect(parseWorkshopEvent(settled)).not.toBeNull();
    expect(parseWorkshopEvent({ ...base, phase: "settled" })).toBeNull();
    expect(parseWorkshopEvent({ ...base, tool: "shell_hack", phase: "started" })).toBeNull();
  });
});

describe("session and roster validation", () => {
  it("accepts a well-formed session and drops one with no safe alias", () => {
    expect(parseWorkshopSession(wireSession(), NOW)).not.toBeNull();
    expect(parseWorkshopSession(wireSession({ displayAlias: "https://only-a-link.com" }), NOW)).toBeNull();
    expect(parseWorkshopSession(wireSession({ displayAlias: "" }), NOW)).toBeNull();
  });

  it("treats a missing activity flag as a legacy host, not idle", () => {
    const { activitySupported: _drop, ...legacy } = wireSession();
    const session = parseWorkshopSession(legacy, NOW);
    expect(session).not.toBeNull();
    expect(session?.activitySupported).toBe(false);
  });

  it("accepts a null owner as neutral and rejects an unbounded one", () => {
    expect(parseWorkshopSession(wireSession({ ownerUid: null }), NOW)?.ownerUid).toBeNull();
    expect(parseWorkshopSession(wireSession({ ownerUid: "x".repeat(MAX_ID_LEN + 1) }), NOW)).toBeNull();
  });

  it("rejects unknown fields and a future-dated receipt", () => {
    expect(parseWorkshopSession(wireSession({ secret: "nope" }), NOW)).toBeNull();
    expect(parseWorkshopSession(wireSession({ receivedAt: NOW + 60_000 }), NOW)).toBeNull();
    expect(parseWorkshopSession(wireSession({ connection: "maybe" }), NOW)).toBeNull();
  });

  it("treats missing or malformed sharing as restricted (fail-closed)", () => {
    // wireSession() omits activityShared entirely: the missing case.
    expect(parseWorkshopSession(wireSession(), NOW)?.activityShared).toBe(false);
    expect(parseWorkshopSession(wireSession({ activityShared: null }), NOW)?.activityShared).toBe(false);
    expect(parseWorkshopSession(wireSession({ activityShared: "false" }), NOW)?.activityShared).toBe(false);
    expect(parseWorkshopSession(wireSession({ activityShared: true }), NOW)?.activityShared).toBe(true);
  });

  it("bounds the roster and its per-session events, and dedups session ids", () => {
    const many = Array.from({ length: MAX_SESSIONS + 10 }, (_, i) =>
      wireSession({ sessionId: `session-${String(i).padStart(4, "0")}` }));
    expect(parseWorkshopRoster(many, NOW)).toHaveLength(MAX_SESSIONS);

    const duplicate = parseWorkshopRoster([wireSession(), wireSession()], NOW);
    expect(duplicate).toHaveLength(1);

    const flood = wireSession({
      events: Array.from({ length: MAX_EVENTS_PER_SESSION + 5 }, (_, i) =>
        outputEvent(i, NOW - 1_000)),
    });
    const session = parseWorkshopSession(flood, NOW);
    expect(session?.events).toHaveLength(MAX_EVENTS_PER_SESSION);
  });
});

describe("top-level request validation", () => {
  const wireRequest = (overrides: Record<string, unknown> = {}) => ({
    requestId: SESSION_ID,
    targetSessionId: "session-0001",
    targetRunId: "run-0001",
    source: { kind: "this_operator" },
    phase: "submitted",
    occurredAt: NOW - 1_000,
    expiresAt: NOW - 1_000 + 120_000,
    ...overrides,
  });

  it("accepts each source kind and rejects a smuggled extra field", () => {
    expect(parseWorkshopRequest(wireRequest(), NOW)).not.toBeNull();
    expect(parseWorkshopRequest(wireRequest({ source: { kind: "external" } }), NOW)).not.toBeNull();
    expect(parseWorkshopRequest(wireRequest({ source: { kind: "attested_session", sessionId: SESSION_ID } }), NOW)).not.toBeNull();
    // A label the producer chose is not a source identity.
    expect(parseWorkshopRequest(wireRequest({ source: { kind: "external", label: "teodora" } }), NOW)).toBeNull();
    expect(parseWorkshopRequest(wireRequest({ source: { kind: "attested_session" } }), NOW)).toBeNull();
  });

  it("rejects unknown phases and out-of-order times", () => {
    expect(parseWorkshopRequest(wireRequest({ phase: "done" }), NOW)).toBeNull();
    expect(parseWorkshopRequest(wireRequest({ expiresAt: NOW - 2_000 }), NOW)).toBeNull();
    expect(parseWorkshopRequest(wireRequest({ occurredAt: NOW + 60_000 }), NOW)).toBeNull();
  });
});

describe("fixtures are display-safe", () => {
  it("every fixture session parses cleanly at the reference clock", () => {
    for (const session of [makeSession(NOW)]) {
      const parsed = parseWorkshopSession(
        { ...session, activitySupported: session.activitySupported },
        NOW,
      );
      expect(parsed).not.toBeNull();
    }
  });
});
