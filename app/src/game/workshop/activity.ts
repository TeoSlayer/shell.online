/**
 * Workshop activity reduction — W01.
 *
 * Pure functions that turn a validated session (contracts.ts) into the facts a
 * pose is allowed to mean. No React, no HTTP, no timers, no model opinion. The
 * renderer maps the resulting state to animation; it never re-derives it.
 *
 * The rules that keep the display honest:
 *   - connection wins immediately: a dead feed shows offline/stale, never work
 *   - sequence, not wall-clock, decides recency within a run
 *   - a repeated poll of the same snapshot ages evidence, never refreshes it
 *   - a read never becomes an instruction packet
 *   - a lost completion is uncertain, never a success
 *   - output after an ACK is new output, not a reply
 */
import type {
  ActivityEvidence,
  Connection,
  McpRequestEvent,
  RequestPhase,
  WorkshopEvent,
  WorkshopSession,
} from "./contracts";
import {
  FUTURE_SKEW_MS,
  HOST_OUTPUT_WINDOW_MS,
  MAX_PACKETS,
  MAX_READS,
  MCP_OBSERVATION_EXPIRY_MS,
  PRODUCER_STATE_EXPIRY_MS,
  classifyMcpTool,
} from "./contracts";

/** The pose a session's evidence allows. One value, no mixing of dimensions. */
export type WorkshopActivityState =
  | { kind: "working" }
  | { kind: "output_observed" }
  | { kind: "idle" }
  | { kind: "needs_input" }
  | { kind: "quiet_unknown" }
  | { kind: "unsupported" }
  | { kind: "offline" }
  | { kind: "restricted" };

export interface WorkshopActivity {
  connection: Connection;
  state: WorkshopActivityState;
  evidence: ActivityEvidence;
  label: string;
}

/** Two events are the exact same observation when every field matches. */
function sameEvent(a: WorkshopEvent, b: WorkshopEvent): boolean {
  if (a.type !== b.type) return false;
  if (a.eventId !== b.eventId || a.runId !== b.runId
    || a.sequence !== b.sequence || a.observedAt !== b.observedAt
    || a.expiresAt !== b.expiresAt) return false;
  if (a.type === "agent_state" && b.type === "agent_state") return a.state === b.state;
  if (a.type === "output_observed" && b.type === "output_observed") {
    return (a.byteCount ?? -1) === (b.byteCount ?? -1);
  }
  if (a.type === "mcp_request" && b.type === "mcp_request") {
    return a.requestId === b.requestId
      && (a.operationId ?? "") === (b.operationId ?? "")
      && a.tool === b.tool && a.phase === b.phase
      && (a.outcome ?? "") === (b.outcome ?? "");
  }
  if (a.type === "message_available" && b.type === "message_available") {
    return (a.replyTo ?? "") === (b.replyTo ?? "");
  }
  return false;
}

interface RunResolution {
  /** Every current-run event, before any projection. */
  current: WorkshopEvent[];
  /** One event per non-conflicted eventId (exact repeats collapsed). */
  accepted: WorkshopEvent[];
  /** Sequences where two events disagree (a conflict or a collision). */
  contradictorySeqs: ReadonlySet<number>;
}

/**
 * Run-wide immutable-identity resolution, done once before any projection so
 * activity, MCP requests and reply correlation all trust the same event set.
 *
 * Every event carries an immutable eventId. The same id with two different
 * contents is a conflict and is rejected; an exact repeat (same id, same
 * content) collapses to one. A sequence that two events disagree on — a
 * conflict, or a collision across distinct ids — is marked contradictory, so a
 * projection can fail closed on a contradictory frontier instead of falling
 * back to an earlier, lower-sequence fact.
 */
function analyzeRun(events: readonly WorkshopEvent[], runId: string): RunResolution {
  const current = events.filter((event) => event.runId === runId);

  const byId = new Map<string, WorkshopEvent[]>();
  for (const event of current) {
    const list = byId.get(event.eventId) ?? [];
    list.push(event);
    byId.set(event.eventId, list);
  }
  const accepted: WorkshopEvent[] = [];
  for (const list of byId.values()) {
    if (list.every((event) => sameEvent(event, list[0]))) accepted.push(list[0]);
  }

  const bySeq = new Map<number, WorkshopEvent[]>();
  for (const event of current) {
    const list = bySeq.get(event.sequence) ?? [];
    list.push(event);
    bySeq.set(event.sequence, list);
  }
  const contradictorySeqs = new Set<number>();
  for (const list of bySeq.values()) {
    if (list.some((event, index) => index > 0 && !sameEvent(event, list[0]))) {
      contradictorySeqs.add(list[0].sequence);
    }
  }

  return { current, accepted, contradictorySeqs };
}

/**
 * The driving event of a kind from an already-resolved run. The frontier is the
 * highest sequence of that kind. A contradictory frontier fails closed (no
 * fallback to an earlier fact), and the frontier drives only while fresh: before
 * its own expiry AND inside the fixed window. Sequence — not wall-clock —
 * decides recency, so a late or out-of-order delivery with a recent stamp cannot
 * be mistaken for new activity.
 */
function freshest(
  resolution: RunResolution,
  type: WorkshopEvent["type"],
  windowMs: number,
  now: number,
): WorkshopEvent | null {
  const ofType = resolution.current.filter((event) => event.type === type);
  if (ofType.length === 0) return null;
  const maxSeq = ofType.reduce((max, event) => Math.max(max, event.sequence), -1);
  if (resolution.contradictorySeqs.has(maxSeq)) return null;
  const frontier = ofType.find((event) => event.sequence === maxSeq)!;
  if (frontier.observedAt > now + FUTURE_SKEW_MS) return null;
  if (now >= frontier.expiresAt) return null;
  if (now - frontier.observedAt >= windowMs) return null;
  return frontier;
}

/**
 * Reduces a session to the activity state its evidence allows.
 *
 * Adapter state is authoritative for the agent's own posture; host output is
 * real activity from any terminal process. Priority: needs-input, then
 * confirmed busy, then observed output, then idle, then quiet-unknown. A stale
 * or disconnected feed overrides everything — no indefinite fake work.
 */
export function reduceActivity(session: WorkshopSession, now: number): WorkshopActivity {
  const { connection, runId, activitySupported, activityShared } = session;

  // Listing a team member is not permission to see their activity. A session the
  // service has not shared presents as restricted — distinct from idle and from
  // quiet-unknown — before any other fact is considered.
  if (!activityShared) {
    return {
      connection, state: { kind: "restricted" },
      evidence: { kind: "unknown" }, label: "Activity not shared",
    };
  }

  if (connection === "disconnected" || connection === "stale") {
    return {
      connection,
      state: { kind: "offline" },
      evidence: { kind: "unknown" },
      label: connection === "stale" ? "Stale · offline" : "Offline",
    };
  }
  if (connection === "unknown") {
    return {
      connection, state: { kind: "quiet_unknown" },
      evidence: { kind: "unknown" }, label: "Quiet · state unknown",
    };
  }
  if (!activitySupported) {
    return {
      connection, state: { kind: "unsupported" },
      evidence: { kind: "unknown" }, label: "Update/restart host for activity",
    };
  }

  const resolution = analyzeRun(session.events, runId);
  const adapter = freshest(resolution, "agent_state", PRODUCER_STATE_EXPIRY_MS, now);
  const output = freshest(resolution, "output_observed", HOST_OUTPUT_WINDOW_MS, now);

  if (adapter && adapter.type === "agent_state" && adapter.state === "waiting_input") {
    return {
      connection, state: { kind: "needs_input" },
      evidence: { kind: "adapter", state: "waiting_input", observedAt: adapter.observedAt },
      label: "Needs input",
    };
  }
  if (adapter && adapter.type === "agent_state" && adapter.state === "busy") {
    return {
      connection, state: { kind: "working" },
      evidence: { kind: "adapter", state: "busy", observedAt: adapter.observedAt },
      label: "Working",
    };
  }
  if (output && output.type === "output_observed") {
    return {
      connection, state: { kind: "output_observed" },
      evidence: { kind: "host_output", observedAt: output.observedAt, sequence: output.sequence },
      label: "Output observed",
    };
  }
  if (adapter && adapter.type === "agent_state" && adapter.state === "idle") {
    return {
      connection, state: { kind: "idle" },
      evidence: { kind: "adapter", state: "idle", observedAt: adapter.observedAt },
      label: "Idle",
    };
  }
  return {
    connection, state: { kind: "quiet_unknown" },
    evidence: { kind: "unknown" }, label: "Quiet · state unknown",
  };
}

/* --- request lifecycle -------------------------------------------------- */

export interface WorkshopPacketView {
  requestId: string;
  operationId?: string;
  targetSessionId: string;
  targetRunId: string;
  phase: RequestPhase;
  occurredAt: number;
  expiresAt: number;
  /** Set only by a correlated message_available, never by host output. */
  responseReceived?: boolean;
  label: string;
}

export interface WorkshopReadView {
  requestId: string;
  tool: McpRequestEvent["tool"];
  at: number;
  label: string;
}

export interface WorkshopRequestViews {
  /** Send instructions only. A read never appears here. */
  packets: WorkshopPacketView[];
  /** Read observations, kept separate so they can never read as packets. */
  reads: WorkshopReadView[];
}

/**
 * Maps the attempts of one operation to a request phase.
 *
 * A host-confirmed delivery is sticky: once any attempt was delivered, the input
 * went through, and a later retry (started, denied, ...) cannot downgrade it.
 * Otherwise the latest attempt decides. A send that was only ever "started" and
 * has now passed its delivery deadline is uncertain — we submitted but never saw
 * the host confirm, which is not a success.
 */
function packetPhase(events: readonly McpRequestEvent[], now: number): RequestPhase {
  if (events.some((event) => event.phase === "settled" && event.outcome === "delivered")) {
    return "delivered";
  }
  const latest = events.reduce((a, b) => (b.sequence > a.sequence ? b : a));
  if (latest.phase === "started") {
    return now >= latest.expiresAt ? "uncertain" : "submitted";
  }
  const outcome = latest.outcome;
  if (outcome === "delivery_uncertain" || outcome === "in_flight") return "uncertain";
  if (outcome === "denied" || outcome === "revoked") return "denied";
  if (outcome === "cancelled") return "cancelled";
  return "failed";
}

function packetLabel(phase: RequestPhase): string {
  switch (phase) {
    case "submitted": return "Awaiting delivery";
    case "delivered": return "Input delivered";
    case "uncertain": return "Delivery uncertain";
    case "denied": return "Denied";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

const READ_OUTCOME_LABELS: Record<string, string> = {
  ok: "Read completed",
  busy: "Read busy",
  denied: "Read denied",
  revoked: "Read revoked",
  error: "Read failed",
  timeout: "Read timed out",
  limit: "Read limit reached",
  disconnected: "Host disconnected",
  too_large: "Read too large",
  reset: "Session reset",
};

function readLabel(event: McpRequestEvent): string {
  if (event.phase === "started") return "Reading";
  return READ_OUTCOME_LABELS[event.outcome ?? ""] ?? "Read observed";
}

/**
 * Reduces a session's mcp_request events into instruction packets (sends) and
 * read observations. Reads and sends are kept in separate lists so a read can
 * never be mistaken for a sent instruction.
 *
 * Privacy: when the service has not shared the session's activity, no request,
 * read or reply projection is emitted at all — sharing is a complete boundary,
 * not just the worker pose.
 *
 * Retention is bounded by the fixed maximum observation age from the source
 * timestamp (not an unchecked supplied expiry), and future-dated beyond the skew
 * bound is dropped. The delivery deadline (expiresAt) is separate: a started
 * send that passes it becomes uncertain, and stays displayed within retention.
 *
 * Retries of one operation coalesce by a tagged key (sends by operation id,
 * reads by request id) so a send's operation id and a read's request id can never
 * merge. A host-confirmed delivery is sticky across retries.
 */
export function reduceRequests(session: WorkshopSession, now: number): WorkshopRequestViews {
  if (!session.activityShared) return { packets: [], reads: [] };

  const resolution = analyzeRun(session.events, session.runId);
  const byOperation = new Map<string, McpRequestEvent[]>();
  for (const event of resolution.accepted) {
    if (event.type !== "mcp_request") continue;
    if (event.observedAt > now + FUTURE_SKEW_MS) continue;
    if (now - event.observedAt >= MCP_OBSERVATION_EXPIRY_MS) continue;
    const key = classifyMcpTool(event.tool) === "send"
      ? `op:${event.operationId ?? event.requestId}`
      : `read:${event.requestId}`;
    const list = byOperation.get(key) ?? [];
    list.push(event);
    byOperation.set(key, list);
  }

  const replies = resolution.accepted.filter((event) => event.type === "message_available");
  const packets: WorkshopPacketView[] = [];
  const reads: WorkshopReadView[] = [];

  for (const events of byOperation.values()) {
    const latest = events.reduce((a, b) => (b.sequence > a.sequence ? b : a));
    if (classifyMcpTool(latest.tool) === "read") {
      reads.push({ requestId: latest.requestId, tool: latest.tool, at: latest.observedAt, label: readLabel(latest) });
      continue;
    }

    const requestIds = new Set(events.map((event) => event.requestId));
    const earliest = events.reduce((a, b) => (b.sequence < a.sequence ? b : a));
    // Stable presentation identity: the operation id, else the first attempt's
    // request id — so a retry cannot replay the receive gesture.
    const identity = latest.operationId ?? earliest.requestId;

    const packet: WorkshopPacketView = {
      requestId: identity,
      targetSessionId: session.sessionId,
      targetRunId: session.runId,
      phase: packetPhase(events, now),
      occurredAt: latest.observedAt,
      expiresAt: latest.expiresAt,
      label: "",
    };
    if (latest.operationId !== undefined) packet.operationId = latest.operationId;
    packet.label = packetLabel(packet.phase);

    // A correlated final response names any attempt of this operation. Host
    // output never sets this — output after a send is not a reply.
    packet.responseReceived = replies.some((event) =>
      event.replyTo !== undefined
      && requestIds.has(event.replyTo)
      && event.observedAt <= now + FUTURE_SKEW_MS
      && now < event.expiresAt
      && now - event.observedAt < MCP_OBSERVATION_EXPIRY_MS,
    );
    packets.push(packet);
  }

  packets.sort((a, b) => b.occurredAt - a.occurredAt || a.requestId.localeCompare(b.requestId));
  reads.sort((a, b) => b.at - a.at || a.requestId.localeCompare(b.requestId));
  return { packets: packets.slice(0, MAX_PACKETS), reads: reads.slice(0, MAX_READS) };
}
