import type { McpAuditOutcome } from "./mcp-audit";

export type McpFlowTool = "shell_status" | "shell_screen" | "shell_output" | "shell_wait" | "shell_send";
export interface McpFlowEvent {
  id: string;
  tool: McpFlowTool;
  phase: "started" | "settled";
  at: number;
  outcome?: McpAuditOutcome;
}

/** Observe handler execution, never the HTTP stream or a client's claimed task state. */
export async function trackMcpFlow<T>(
  tool: McpFlowTool,
  emit: (event: McpFlowEvent) => void,
  handler: () => Promise<T>,
  outcome: (failed: boolean) => McpAuditOutcome,
): Promise<T> {
  const id = crypto.randomUUID();
  const publish = (event: McpFlowEvent) => { try { emit(event); } catch { /* Telemetry cannot affect tool execution. */ } };
  publish({ id, tool, phase: "started", at: Date.now() });
  let failed = true;
  try {
    const value = await handler();
    failed = false;
    return value;
  } finally {
    publish({ id, tool, phase: "settled", at: Date.now(), outcome: outcome(failed) });
  }
}

/** Capturing the host and run prevents delayed completions leaking into a new host/run. */
export function hostMcpFlowSink(
  host: { readyState: number; send(value: string): void } | undefined,
  currentRun: () => boolean,
): (event: McpFlowEvent) => void {
  return (event) => {
    if (!host || host.readyState !== 1 || !currentRun()) return;
    // Construct an explicit allowlist projection: never forward grant data or tool args.
    const safe: McpFlowEvent = { id: event.id, tool: event.tool, phase: event.phase, at: event.at };
    if (event.phase === "settled") safe.outcome = event.outcome;
    try { host.send(JSON.stringify({ type: "mcp_flow", event: safe })); } catch { /* Best effort. */ }
  };
}
