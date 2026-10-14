/**
 * Workshop observation contract — W01.
 *
 * The frozen, versioned shape the service publishes and the renderer consumes.
 * This file is pure: no React, no HTTP, no timers. It only names the contract
 * and validates what arrives, so a malformed or out-of-scope observation can
 * never reach the display. The renderer maps these facts to poses; it never
 * re-derives them.
 *
 * Three dimensions stay separate, because a single enum that mixes process
 * activity, message delivery and model opinion invents false claims:
 *   1. connection  — is this session reachable right now
 *   2. activity    — what was actually observed (adapter state or host output)
 *   3. requests    — the lifecycle of a sent instruction, which is not a task
 *
 * Nothing here is a model opinion. Jev's assessment is a separate, explicitly
 * inferred layer that may suggest inspection but cannot overwrite these facts.
 */

export const WORKSHOP_CONTRACT_VERSION = 1 as const;

/* Provisional engineering constants (DESIGN-agent-workshop §4), not model truths. */
export const HOST_OUTPUT_WINDOW_MS = 8_000;
export const PRODUCER_STATE_EXPIRY_MS = 45_000;
export const MCP_OBSERVATION_EXPIRY_MS = 120_000;
export const FUTURE_SKEW_MS = 5_000;

/* Bounds: malformed payloads are rejected, never truncated into trust. */
export const MAX_SESSIONS = 64;
export const MAX_EVENTS_PER_SESSION = 32;
export const MAX_PACKETS = 16;
export const MAX_READS = 16;
export const MAX_ID_LEN = 64;
export const MAX_ALIAS_LEN = 48;
export const MAX_BYTE_COUNT = 1_048_576; // 1 MiB — a content-free size, never the text

/* --- dimensions --------------------------------------------------------- */

export type Connection = "connected" | "disconnected" | "stale" | "unknown";
export type AdapterState = "busy" | "idle" | "waiting_input";

export type McpTool =
  | "shell_status" | "shell_screen" | "shell_output" | "shell_wait" | "shell_send";
export type McpToolKind = "read" | "send";

/** A read inspects a session; only a send can become an instruction packet. */
export function classifyMcpTool(tool: McpTool): McpToolKind {
  return tool === "shell_send" ? "send" : "read";
}

/** What a pose is allowed to mean from activity evidence alone. */
export type ActivityEvidence =
  | { kind: "adapter"; state: AdapterState; observedAt: number }
  | { kind: "host_output"; observedAt: number; sequence: number }
  | { kind: "unknown" };

/* --- versioned event union ---------------------------------------------- */
/*
 * Every event carries an immutable id, the run generation it belongs to, a
 * source sequence (monotonic within a run), and an expiry. The service derives
 * owner/org/device identity from authentication; a producer-supplied identity
 * never establishes authority, so it is not a field on these events at all.
 */
interface WorkshopEventBase {
  eventId: string;
  runId: string;
  sequence: number;
  observedAt: number;
  expiresAt: number;
}

export interface OutputObservedEvent extends WorkshopEventBase {
  type: "output_observed";
  byteCount?: number;
}
export interface AgentStateEvent extends WorkshopEventBase {
  type: "agent_state";
  state: AdapterState;
}
export interface McpRequestEvent extends WorkshopEventBase {
  type: "mcp_request";
  requestId: string;
  operationId?: string;
  tool: McpTool;
  phase: "started" | "settled";
  outcome?: string;
}
export interface MessageAvailableEvent extends WorkshopEventBase {
  type: "message_available";
  replyTo?: string;
}
export type WorkshopEvent =
  | OutputObservedEvent | AgentStateEvent | McpRequestEvent | MessageAvailableEvent;

/* --- request lifecycle -------------------------------------------------- */
export type RequestSource =
  | { kind: "this_operator" }
  | { kind: "external" }
  | { kind: "attested_session"; sessionId: string };
export type RequestPhase =
  | "submitted" | "delivered" | "uncertain" | "denied" | "failed" | "cancelled";

/** A top-level instruction as the service reports it, before reduction. */
export interface WorkshopRequest {
  requestId: string;
  operationId?: string;
  targetSessionId: string;
  targetRunId: string;
  source: RequestSource;
  phase: RequestPhase;
  occurredAt: number;
  expiresAt: number;
}

/*
 * Service boundary (W01 documents it; it does not implement it). The service is
 * the only authority on what a viewer may see: it scopes the roster to the
 * signed-in owner, decides per session whether activity is shared, and attests
 * any cross-owner handoff. The client's ownerUid is display metadata (it picks
 * a crew colour) and never establishes authority. There is no authorization
 * endpoint here and none is invented: a session that is listed is not thereby
 * permitted to expose private activity, text, alias or control.
 */
export interface WorkshopSession {
  sessionId: string;
  runId: string;
  ownerUid: string | null;
  displayAlias: string;
  connection: Connection;
  receivedAt: number;
  /** False for legacy hosts that predate activity telemetry. */
  activitySupported: boolean;
  /**
   * Whether this session's activity is shared with the current viewer. A listed
   * team member is not automatically shared: the service sets this false for
   * cross-owner private sessions, which then present as "Activity not shared".
   */
  activityShared: boolean;
  events: WorkshopEvent[];
}

/* --- validation --------------------------------------------------------- */

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

/** A bounded, whitespace-free identifier. UUIDs and session ids both fit. */
export function isId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_ID_LEN
    // A NUL is not matched by \s; reject it so an id cannot smuggle a terminator.
    // eslint-disable-next-line no-control-regex
    && !/[\s\x00]/.test(value);
}

/** Canonical UUID version 4 only: the shape the relay issues. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * A display alias is a short, safe label. It is sanitised, not trusted: control
 * characters become spaces, URLs are dropped, whitespace runs collapse, and the
 * result is length-bounded — so a producer cannot smuggle a link, a path or a
 * wall of text into the room.
 */
export function sanitizeAlias(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const noControl = raw.replace(/[\u0000-\u001f\u007f]/g, " ");
  const noWeb = noControl.replace(/https?:\/\/\S+/gi, " ");
  return noWeb.replace(/\s+/g, " ").trim().slice(0, MAX_ALIAS_LEN);
}

const ADAPTER_STATES = new Set<AdapterState>(["busy", "idle", "waiting_input"]);
const CONNECTIONS = new Set<Connection>(["connected", "disconnected", "stale", "unknown"]);
const MCP_TOOLS = new Set<McpTool>([
  "shell_status", "shell_screen", "shell_output", "shell_wait", "shell_send",
]);
/* Mirrors shared/mcp-audit.ts; a settled mcp_request must carry one of these. */
const MCP_OUTCOMES = new Set<string>([
  "ok", "busy", "denied", "too_large", "revoked", "error", "matched", "timeout",
  "cancelled", "reset", "limit", "disconnected", "delivered", "delivery_uncertain",
  "in_flight", "conflict",
]);
const REQUEST_PHASES = new Set<RequestPhase>([
  "submitted", "delivered", "uncertain", "denied", "failed", "cancelled",
]);

const EVENT_KEYS: Record<WorkshopEvent["type"], ReadonlySet<string>> = {
  output_observed: new Set(["type", "eventId", "runId", "sequence", "observedAt", "expiresAt", "byteCount"]),
  agent_state: new Set(["type", "eventId", "runId", "sequence", "observedAt", "expiresAt", "state"]),
  mcp_request: new Set(["type", "eventId", "runId", "sequence", "observedAt", "expiresAt", "requestId", "operationId", "tool", "phase", "outcome"]),
  message_available: new Set(["type", "eventId", "runId", "sequence", "observedAt", "expiresAt", "replyTo"]),
};

/**
 * Reads one event from the wire into the contract, or null. Unknown fields are
 * rejected outright so content, credentials or share URLs cannot ride in on an
 * extra key. A started mcp_request must not carry an outcome; a settled one
 * must.
 */
export function parseWorkshopEvent(raw: unknown): WorkshopEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const type = row.type;
  if (type !== "output_observed" && type !== "agent_state"
    && type !== "mcp_request" && type !== "message_available") return null;
  if (Object.keys(row).some((key) => !EVENT_KEYS[type].has(key))) return null;
  if (!isId(row.eventId) || !isId(row.runId)) return null;
  if (!isInt(row.sequence) || row.sequence < 0) return null;
  if (!isInt(row.observedAt) || row.observedAt < 0) return null;
  if (!isInt(row.expiresAt) || row.expiresAt < row.observedAt) return null;

  if (type === "output_observed") {
    if (row.byteCount !== undefined
      && (!isInt(row.byteCount) || row.byteCount < 0 || row.byteCount > MAX_BYTE_COUNT)) return null;
    const event: OutputObservedEvent = {
      type, eventId: row.eventId as string, runId: row.runId as string,
      sequence: row.sequence as number, observedAt: row.observedAt as number,
      expiresAt: row.expiresAt as number,
    };
    if (row.byteCount !== undefined) event.byteCount = row.byteCount as number;
    return event;
  }

  if (type === "agent_state") {
    if (typeof row.state !== "string" || !ADAPTER_STATES.has(row.state as AdapterState)) return null;
    return {
      type, eventId: row.eventId as string, runId: row.runId as string,
      sequence: row.sequence as number, observedAt: row.observedAt as number,
      expiresAt: row.expiresAt as number, state: row.state as AdapterState,
    };
  }

  if (type === "mcp_request") {
    if (!isId(row.requestId)) return null;
    if (row.operationId !== undefined && !isId(row.operationId)) return null;
    if (typeof row.tool !== "string" || !MCP_TOOLS.has(row.tool as McpTool)) return null;
    if (row.phase !== "started" && row.phase !== "settled") return null;
    if (row.phase === "started" && row.outcome !== undefined) return null;
    if (row.phase === "settled" && (typeof row.outcome !== "string" || !MCP_OUTCOMES.has(row.outcome))) return null;
    const event: McpRequestEvent = {
      type, eventId: row.eventId as string, runId: row.runId as string,
      sequence: row.sequence as number, observedAt: row.observedAt as number,
      expiresAt: row.expiresAt as number, requestId: row.requestId as string,
      tool: row.tool as McpTool, phase: row.phase,
    };
    if (row.operationId !== undefined) event.operationId = row.operationId as string;
    if (row.phase === "settled") event.outcome = row.outcome as string;
    return event;
  }

  if (row.replyTo !== undefined && !isId(row.replyTo)) return null;
  const event: MessageAvailableEvent = {
    type, eventId: row.eventId as string, runId: row.runId as string,
    sequence: row.sequence as number, observedAt: row.observedAt as number,
    expiresAt: row.expiresAt as number,
  };
  if (row.replyTo !== undefined) event.replyTo = row.replyTo as string;
  return event;
}

const SESSION_KEYS = new Set([
  "sessionId", "runId", "ownerUid", "displayAlias", "connection",
  "receivedAt", "activitySupported", "activityShared", "events",
]);

/**
 * Reads one session from the wire into the contract, or null. A session with no
 * safe alias is not displayable and is dropped. A missing `activitySupported`
 * means a legacy host, which is unknown — not zero, not idle.
 */
export function parseWorkshopSession(raw: unknown, now: number): WorkshopSession | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !SESSION_KEYS.has(key))) return null;
  if (!isId(row.sessionId) || !isId(row.runId)) return null;
  if (row.ownerUid !== null && !isId(row.ownerUid)) return null;
  const displayAlias = sanitizeAlias(row.displayAlias);
  if (displayAlias === "") return null;
  if (typeof row.connection !== "string" || !CONNECTIONS.has(row.connection as Connection)) return null;
  if (!isInt(row.receivedAt) || row.receivedAt < 0 || row.receivedAt > now + FUTURE_SKEW_MS) return null;

  const rawEvents = Array.isArray(row.events) ? row.events : [];
  const events: WorkshopEvent[] = [];
  for (const item of rawEvents.slice(0, MAX_EVENTS_PER_SESSION)) {
    const event = parseWorkshopEvent(item);
    if (event) events.push(event);
  }

  return {
    sessionId: row.sessionId as string,
    runId: row.runId as string,
    ownerUid: row.ownerUid === null ? null : (row.ownerUid as string),
    displayAlias,
    connection: row.connection as Connection,
    receivedAt: row.receivedAt as number,
    activitySupported: row.activitySupported === true,
    // Sharing is fail-closed: only an explicit boolean true shares. A missing,
    // null or malformed value cannot infer that this viewer owns the session,
    // because this parser has no viewer identity.
    activityShared: row.activityShared === true,
    events,
  };
}

/** Reads a bounded roster, dropping malformed rows and duplicate session ids. */
export function parseWorkshopRoster(raw: unknown, now: number): WorkshopSession[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const roster: WorkshopSession[] = [];
  for (const item of raw.slice(0, MAX_SESSIONS)) {
    const session = parseWorkshopSession(item, now);
    if (!session || seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    roster.push(session);
  }
  return roster;
}

/* --- top-level request validation --------------------------------------- */

const REQUEST_KEYS = new Set([
  "requestId", "operationId", "targetSessionId", "targetRunId",
  "source", "phase", "occurredAt", "expiresAt",
]);

function parseRequestSource(raw: unknown): RequestSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.kind === "this_operator") {
    return Object.keys(row).every((key) => key === "kind") ? { kind: "this_operator" } : null;
  }
  if (row.kind === "external") {
    return Object.keys(row).every((key) => key === "kind") ? { kind: "external" } : null;
  }
  if (row.kind === "attested_session") {
    if (!isId(row.sessionId)) return null;
    return Object.keys(row).every((key) => key === "kind" || key === "sessionId")
      ? { kind: "attested_session", sessionId: row.sessionId as string }
      : null;
  }
  return null;
}

export function parseWorkshopRequest(raw: unknown, now: number): WorkshopRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !REQUEST_KEYS.has(key))) return null;
  if (!isId(row.requestId) || !isId(row.targetSessionId) || !isId(row.targetRunId)) return null;
  if (row.operationId !== undefined && !isId(row.operationId)) return null;
  const source = parseRequestSource(row.source);
  if (!source) return null;
  if (typeof row.phase !== "string" || !REQUEST_PHASES.has(row.phase as RequestPhase)) return null;
  if (!isInt(row.occurredAt) || row.occurredAt < 0 || row.occurredAt > now + FUTURE_SKEW_MS) return null;
  if (!isInt(row.expiresAt) || row.expiresAt < row.occurredAt) return null;
  const request: WorkshopRequest = {
    requestId: row.requestId as string,
    targetSessionId: row.targetSessionId as string,
    targetRunId: row.targetRunId as string,
    source,
    phase: row.phase as RequestPhase,
    occurredAt: row.occurredAt as number,
    expiresAt: row.expiresAt as number,
  };
  if (row.operationId !== undefined) request.operationId = row.operationId as string;
  return request;
}
