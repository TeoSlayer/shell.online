import { useEffect, useState } from "react";

/**
 * MCP request observations, as the game is allowed to see them.
 *
 * The service has already scoped these to the signed-in owner and to live
 * sessions its own devices are running; this file still validates every row
 * strictly, because a display must never be the place a malformed or
 * out-of-scope observation first gets trusted. What is shown is only ever
 * metadata: no arguments, no terminal content, no credentials.
 *
 * There is deliberately no source identity. The caller is an external MCP
 * client and the service cannot attest which agent, if any, made the request,
 * so nothing here may draw or name one.
 */
export type McpFlowTool = "shell_status" | "shell_screen" | "shell_output" | "shell_wait" | "shell_send";

export interface McpFlow {
  id: string;
  targetSessionId: string;
  tool: McpFlowTool;
  phase: "started" | "settled";
  at: number;
  outcome?: string;
}

export const FLOW_TTL_MS = 120_000;

export const MCP_FLOW_TOOLS: readonly McpFlowTool[] = [
  "shell_status", "shell_screen", "shell_output", "shell_wait", "shell_send",
];

/** Mirrors shared/mcp-audit.ts; a settled observation must carry one of these. */
export const MCP_FLOW_OUTCOMES: readonly string[] = [
  "ok", "busy", "denied", "too_large", "revoked", "error",
  "matched", "timeout", "cancelled", "reset", "limit", "disconnected",
  "delivered", "delivery_uncertain", "in_flight", "conflict",
];

const toolSet = new Set<string>(MCP_FLOW_TOOLS);
const outcomeSet = new Set<string>(MCP_FLOW_OUTCOMES);
const flowKeys = new Set(["id", "targetSessionId", "tool", "phase", "at", "outcome"]);

/** Canonical UUID version 4 only: the shape the relay issues. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Reads the endpoint's answer into the observations worth showing.
 *
 * `allowed` is the set of live, owned session ids, so an observation for any
 * other target is dropped even if the service were to send one. A settled
 * phase must carry a real outcome and a started phase must not; older than the
 * TTL and future-dated rows are dropped. One call has one id, so two rows
 * sharing a target and an id collapse to the most settled, latest one; two
 * different sessions may legitimately share an id and both stay.
 */
export function readMcpFlows(value: unknown, allowed: ReadonlySet<string>, now: number): McpFlow[] {
  if (!Array.isArray(value)) return [];
  const byTargetAndId = new Map<string, McpFlow>();
  for (const item of value.slice(0, 128)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !flowKeys.has(key))) continue;
    if (!isUuidV4(row.id)) continue;
    if (typeof row.targetSessionId !== "string" || !allowed.has(row.targetSessionId)) continue;
    if (typeof row.tool !== "string" || !toolSet.has(row.tool)) continue;
    if (row.phase !== "started" && row.phase !== "settled") continue;
    if (typeof row.at !== "number" || !Number.isSafeInteger(row.at)) continue;
    if (row.at > now + 5_000 || now - row.at >= FLOW_TTL_MS) continue;
    if (row.phase === "started" && row.outcome !== undefined) continue;
    if (row.phase === "settled" && (typeof row.outcome !== "string" || !outcomeSet.has(row.outcome))) continue;
    const flow: McpFlow = {
      id: row.id,
      targetSessionId: row.targetSessionId,
      tool: row.tool as McpFlowTool,
      phase: row.phase,
      at: row.at,
    };
    if (row.phase === "settled") flow.outcome = row.outcome as string;
    const key = `${flow.targetSessionId}:${flow.id}`;
    const held = byTargetAndId.get(key);
    const prefer = !held
      || (held.phase !== "settled" && flow.phase === "settled")
      || (held.phase === flow.phase && flow.at > held.at);
    if (prefer) byTargetAndId.set(key, flow);
  }
  return [...byTargetAndId.values()]
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 32);
}

/** The observations still inside their short life, whatever the fetches are doing. */
export function expiringMcpFlows(flows: readonly McpFlow[], now: number, ttl = FLOW_TTL_MS): McpFlow[] {
  return flows.filter((flow) => now - flow.at < ttl && flow.at <= now + 5_000);
}

/**
 * Re-renders while anything is on screen, so the panel empties on time even if
 * no fetch ever answers again. One second is the panel's whole resolution.
 */
export function useExpiringMcpFlows(flows: readonly McpFlow[], ttl = FLOW_TTL_MS): McpFlow[] {
  const [now, setNow] = useState(() => Date.now());
  const any = flows.length > 0;
  useEffect(() => {
    if (!any) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [any]);
  return expiringMcpFlows(flows, now, ttl);
}

/** What actually happened, in plain words. None of these mean "the agent finished". */
export function flowStatus(flow: McpFlow): string {
  if (flow.phase === "started") return "Request started";
  const labels: Record<string, string> = {
    ok: "Request completed",
    delivered: "Input delivered",
    delivery_uncertain: "Delivery uncertain",
    in_flight: "Input in flight",
    matched: "Wait matched",
    timeout: "Wait timed out",
    cancelled: "Request cancelled",
    reset: "Session reset",
    busy: "Request busy",
    denied: "Request denied",
    too_large: "Request too large",
    revoked: "Access revoked",
    error: "Request failed",
    limit: "Request limit reached",
    disconnected: "Host disconnected",
    conflict: "Request conflict",
  };
  return labels[flow.outcome ?? ""] ?? "Outcome unrecorded";
}

/** Blue while in flight, green when the tool did its job, amber otherwise. */
export function flowColor(flow: McpFlow): number {
  if (flow.phase === "started" || flow.outcome === "in_flight") return 0x89dceb;
  return ["ok", "delivered", "matched"].includes(flow.outcome ?? "") ? 0xa6e3a1 : 0xf9c27a;
}
