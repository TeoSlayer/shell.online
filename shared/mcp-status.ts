// Pure builder for the `shell_status` MCP tool result. Kept runtime-neutral so it can be unit
// tested and so the DO stays thin. The payload deliberately omits the session ID, browser URL,
// host token, bearer, E2EE key, and command environment — only bounded structured state.
import type { McpGrantRecord } from "./mcp-grants";

export interface McpStatusInput {
  status: string;
  label: string;
  humanViewers: number;
  activeControllers: number;
  freshModelAvailable: boolean;
}

export function buildStatusPayload(
  input: McpStatusInput,
  grant: McpGrantRecord,
): Record<string, unknown> {
  return {
    status: input.status,
    label: input.label,
    human_viewers: input.humanViewers,
    active_controllers: input.activeControllers,
    grant: {
      scopes: grant.scopes,
      expires_at: new Date(grant.expiresAt * 1000).toISOString(),
    },
    run: {
      state: input.status,
      fresh_model_available: input.freshModelAvailable,
    },
  };
}

// Low-cardinality analytics/log event for an MCP request. The design forbids grant labels, grant
// IDs, session IDs, tokens, arguments, patterns, and content in analytics — only low-cardinality
// action/tool/outcome names and the scope set are allowed. The function accepts the full
// high-cardinality request context (grant, session, token, bearer) for call-site convenience and
// redacts it: only the low-cardinality fields reach the returned event. This is the single
// redaction point every MCP request path funnels through.
export interface McpAnalyticsInput {
  action: string;
  tool?: string;
  outcome?: string;
  // High-cardinality context — accepted, then redacted (never echoed in the event):
  grant?: { scopes: readonly string[]; grantId?: string; label?: string };
  sessionId?: string;
  hostToken?: string;
  bearer?: string;
}

export function mcpAnalyticsEvent(input: McpAnalyticsInput): Record<string, unknown> {
  const event: Record<string, unknown> = { action: input.action };
  if (input.tool !== undefined) event.tool = input.tool;
  if (input.outcome !== undefined) event.outcome = input.outcome;
  if (input.grant) event.scopes = [...input.grant.scopes].sort();
  // grant.grantId, grant.label, sessionId, hostToken, and bearer are deliberately omitted.
  return event;
}

// --- MCP telemetry (cross-cutting redaction gate) -----------------------------------------
//
// Every MCP request path funnels its analytics through recordMcpEvent, which passes the full
// high-cardinality context (grant id/label, session id, host token, bearer) to mcpAnalyticsEvent
// and lets only the low-cardinality fields reach the sink. The sink is injectable so the redaction
// gate test can capture what would actually be logged.

export type McpTelemetrySink = (event: Record<string, unknown>) => void;

let mcpTelemetrySink: McpTelemetrySink = (event) => {
  console.log(JSON.stringify(event));
};

export function setMcpTelemetrySink(sink: McpTelemetrySink): void {
  mcpTelemetrySink = sink;
}

export function recordMcpEvent(input: {
  action: string;
  tool?: string;
  outcome?: string;
  grant?: McpGrantRecord;
  sessionId?: string;
  hostToken?: string;
  bearer?: string;
}): void {
  const event = mcpAnalyticsEvent({
    action: input.action,
    tool: input.tool,
    outcome: input.outcome,
    grant: input.grant
      ? { scopes: input.grant.scopes, grantId: input.grant.grantId, label: input.grant.label }
      : undefined,
    sessionId: input.sessionId,
    hostToken: input.hostToken,
    bearer: input.bearer,
  });
  mcpTelemetrySink({ mcp: event });
}
