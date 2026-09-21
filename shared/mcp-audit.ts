// Bounded live-run MCP audit trail (metadata only). The DO keeps one bounded in-memory array per
// live run. Entries carry only the approved metadata fields — grant id/label, tool name, scope
// set, timestamp and duration, byte count (never the bytes), and an outcome — plus revocation/
// expiry events. They never carry request/response content, tool arguments, patterns, tokens, or
// credentials. The trail is deleted when the run ends (task exit, session expiry, resume).
// The tool's actual completion outcome, recorded at tool completion (not just the HTTP status).
// For shell_wait this is the wait reason (matched/timeout/cancelled/reset) or the non-error
// limit/disconnected states; for the other observe tools it is "ok" (or "error" on a thrown
// recheck). A 200 response can still carry a "timeout" outcome — the audit reflects what the tool
// did, not the transport status.
export type McpAuditOutcome =
  | "ok"
  | "busy"
  | "denied"
  | "too_large"
  | "revoked"
  | "error"
  | "matched"
  | "timeout"
  | "cancelled"
  | "reset"
  | "limit"
  | "disconnected"
  // shell_send (control) outcomes — host-acknowledged delivery of the complete operation, not
  // target-agent task completion.
  | "delivered"
  | "delivery_uncertain"
  | "in_flight"
  | "conflict";

export interface McpAuditEntry {
  grantId: string;
  label: string;
  scopes: string[];
  // Tool name for a tools/call, or "request" for a non-tool MCP request (initialize, tools/list).
  tool: string;
  startedAt: number; // unix ms
  durationMs: number;
  requestBytes: number;
  outcome: McpAuditOutcome;
}

// A revocation/expiry event (no tool/duration/bytes — it is a lifecycle transition, not a call).
export interface McpAuditEvent {
  grantId: string;
  label: string;
  kind: "revoked" | "expired" | "run_end";
  at: number; // unix ms
}

export type McpAuditItem = McpAuditEntry | McpAuditEvent;

// Bounded: keep only the most recent entries so a long run with many calls cannot grow the trail
// without bound. The DO reassigns the array (not this helper) to delete it on run end.
export const MAX_MCP_AUDIT = 200;

export function appendAudit(audit: McpAuditItem[], item: McpAuditItem): void {
  audit.push(item);
  if (audit.length > MAX_MCP_AUDIT) audit.splice(0, audit.length - MAX_MCP_AUDIT);
}
