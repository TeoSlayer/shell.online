/**
 * Sanitized workshop fixtures — W01.
 *
 * Deterministic, content-free test data for the contract and its reduction.
 * No real session ids, no credentials, no terminal text: only safe aliases,
 * opaque ids and metadata. Builders are pure (no module-level clock) so tests
 * stay independent and re-runnable.
 */
import type {
  AgentStateEvent,
  AdapterState,
  Connection,
  McpRequestEvent,
  MessageAvailableEvent,
  OutputObservedEvent,
  WorkshopEvent,
  WorkshopRequest,
  WorkshopSession,
} from "./contracts";
import {
  HOST_OUTPUT_WINDOW_MS,
  MAX_SESSIONS,
  MCP_OBSERVATION_EXPIRY_MS,
  PRODUCER_STATE_EXPIRY_MS,
} from "./contracts";

/** A fixed reference instant; tests advance it explicitly, never via Date.now. */
export const T0 = 1_730_000_000_000;

const OWNER = "owner-0001";
const RUN = "run-0001";

export interface SessionOverrides {
  sessionId?: string;
  runId?: string;
  ownerUid?: string | null;
  displayAlias?: string;
  connection?: Connection;
  receivedAt?: number;
  activitySupported?: boolean;
  activityShared?: boolean;
  events?: WorkshopEvent[];
}

/** A well-formed session; every field a display is allowed to trust. */
export function makeSession(now: number, overrides: SessionOverrides = {}): WorkshopSession {
  return {
    sessionId: overrides.sessionId ?? "session-0001",
    runId: overrides.runId ?? RUN,
    // An explicit null owner is neutral and must survive; only an omitted
    // owner falls back to the default crew.
    ownerUid: overrides.ownerUid === undefined ? OWNER : overrides.ownerUid,
    displayAlias: overrides.displayAlias ?? "Worker one",
    connection: overrides.connection ?? "connected",
    receivedAt: overrides.receivedAt ?? now,
    activitySupported: overrides.activitySupported ?? true,
    activityShared: overrides.activityShared ?? true,
    events: overrides.events ?? [],
  };
}

export function outputEvent(
  sequence: number,
  observedAt: number,
  runId: string = RUN,
): OutputObservedEvent {
  return {
    type: "output_observed",
    eventId: `out-${runId}-${sequence}`,
    runId,
    sequence,
    observedAt,
    expiresAt: observedAt + HOST_OUTPUT_WINDOW_MS,
  };
}

export function agentEvent(
  state: AdapterState,
  sequence: number,
  observedAt: number,
  runId: string = RUN,
): AgentStateEvent {
  return {
    type: "agent_state",
    eventId: `agent-${runId}-${sequence}`,
    runId,
    sequence,
    observedAt,
    expiresAt: observedAt + PRODUCER_STATE_EXPIRY_MS,
    state,
  };
}

export interface RequestOverrides {
  tool?: McpRequestEvent["tool"];
  phase?: McpRequestEvent["phase"];
  outcome?: string;
  operationId?: string;
  runId?: string;
}

export function mcpRequestEvent(
  requestId: string,
  sequence: number,
  observedAt: number,
  overrides: RequestOverrides = {},
): McpRequestEvent {
  const runId = overrides.runId ?? RUN;
  const event: McpRequestEvent = {
    type: "mcp_request",
    eventId: `req-${runId}-${sequence}`,
    runId,
    sequence,
    observedAt,
    expiresAt: observedAt + MCP_OBSERVATION_EXPIRY_MS,
    requestId,
    tool: overrides.tool ?? "shell_send",
    phase: overrides.phase ?? "started",
  };
  if (overrides.operationId !== undefined) event.operationId = overrides.operationId;
  if (overrides.phase === "settled") event.outcome = overrides.outcome ?? "ok";
  return event;
}

export function messageEvent(
  replyTo: string,
  sequence: number,
  observedAt: number,
  runId: string = RUN,
): MessageAvailableEvent {
  return {
    type: "message_available",
    eventId: `msg-${runId}-${sequence}`,
    runId,
    sequence,
    observedAt,
    expiresAt: observedAt + MCP_OBSERVATION_EXPIRY_MS,
    replyTo,
  };
}

/* --- named scenarios ---------------------------------------------------- */

/**
 * M1's core scene: one owner, three genuinely different workers. The busy one
 * has adapter evidence; the output one has only a recent terminal write; the
 * quiet one has neither and must read as unknown, not idle.
 */
export function oneOwnerThreeWorkers(now: number): WorkshopSession[] {
  return [
    makeSession(now, {
      sessionId: "session-busy",
      displayAlias: "Wright",
      events: [agentEvent("busy", 10, now - 2_000)],
    }),
    makeSession(now, {
      sessionId: "session-output",
      displayAlias: "Mason",
      events: [outputEvent(20, now - 3_000)],
    }),
    makeSession(now, {
      sessionId: "session-quiet",
      displayAlias: "Scribe",
      events: [],
    }),
  ];
}

/** A full roster at the bound, to prove the parser stops trusting past it. */
export function denseRoster(now: number): WorkshopSession[] {
  return Array.from({ length: MAX_SESSIONS }, (_, index) => makeSession(now, {
    sessionId: `session-${String(index).padStart(4, "0")}`,
    displayAlias: `Worker ${index}`,
    events: index % 2 === 0 ? [outputEvent(index + 1, now - 1_000)] : [],
  }));
}

/** No sessions at all — the empty clearing, not a synthetic fallback roster. */
export function emptyRoster(): WorkshopSession[] {
  return [];
}

/** A dead feed: one disconnected and one stale, each with fresh-looking events
 *  that must not animate work. */
export function offlineRoster(now: number): WorkshopSession[] {
  return [
    makeSession(now, {
      sessionId: "session-down",
      displayAlias: "Smithy",
      connection: "disconnected",
      events: [outputEvent(30, now - 1_000)],
    }),
    makeSession(now, {
      sessionId: "session-stale",
      displayAlias: "Tinker",
      connection: "stale",
      events: [agentEvent("busy", 40, now - 1_000)],
    }),
  ];
}

/* --- team fixtures ------------------------------------------------------ */
/*
 * This is a TEAM workshop: several owners, each with their own crew (the
 * renderer derives a distinct crew colour from ownerUid, which is display
 * metadata only). Listing a colleague's session is not permission to see their
 * activity: sessions the service has not shared present as "Activity not
 * shared". All of this is authorized by the service, not by the client.
 */

/** Three owners with differently coloured crews; some activity shared, some not. */
export function teamRoster(now: number): WorkshopSession[] {
  return [
    makeSession(now, {
      sessionId: "a-lead", ownerUid: "owner-a", displayAlias: "A lead",
      events: [agentEvent("busy", 1, now - 1_000)],
    }),
    makeSession(now, {
      sessionId: "a-worker", ownerUid: "owner-a", displayAlias: "A worker",
      events: [outputEvent(2, now - 1_000)],
    }),
    makeSession(now, {
      sessionId: "b-lead", ownerUid: "owner-b", displayAlias: "B lead",
      events: [agentEvent("idle", 1, now - 1_000)],
    }),
    makeSession(now, {
      sessionId: "b-private", ownerUid: "owner-b", displayAlias: "B private",
      activityShared: false,
      events: [agentEvent("busy", 1, now - 1_000)],
    }),
    makeSession(now, {
      sessionId: "c-lead", ownerUid: "owner-c", displayAlias: "C lead",
      activityShared: false,
      events: [outputEvent(1, now - 1_000)],
    }),
  ];
}

/** Owner B's session after an attested, permitted handoff from owner A. */
export function crossOwnerHandoff(now: number): WorkshopSession {
  return makeSession(now, {
    sessionId: "b-lead",
    ownerUid: "owner-b",
    displayAlias: "B lead",
    events: [
      mcpRequestEvent("handoff-1", 1, now - 2_000, {
        tool: "shell_send", phase: "settled", outcome: "delivered",
        operationId: "op-handoff-1",
      }),
      messageEvent("handoff-1", 2, now - 1_000),
    ],
  });
}

/**
 * The service-attested identity of that handoff: owner A's session is the true
 * source, attested by the service (not a label the client could forge). This is
 * display/audit metadata; the client does not re-derive authority from it.
 */
export function handoffRequest(now: number): WorkshopRequest {
  return {
    requestId: "handoff-1",
    operationId: "op-handoff-1",
    targetSessionId: "b-lead",
    targetRunId: RUN,
    source: { kind: "attested_session", sessionId: "a-lead" },
    phase: "delivered",
    occurredAt: now - 2_000,
    expiresAt: now - 2_000 + MCP_OBSERVATION_EXPIRY_MS,
  };
}
