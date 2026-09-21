import { flowOutcomeChip, flowStatus, flowSummary, MCP_FLOW_OUTCOMES, type McpFlow } from "../state/mcp-flows";
import type { Actor } from "../world/sim";

/**
 * What external MCP clients are asking this garrison to do.
 *
 * The panel is deliberately about a *caller*, not an agent: the service can
 * attest that a tool call happened and which session it landed on, and nothing
 * more. So every row reads "External MCP client → <a real figure on this
 * field>", never an invented sender, and a request whose target is not
 * standing on the map says so rather than naming a session that is not here.
 *
 * The summary and the outcome chips are counted from the observed rows in
 * code. They say what was seen — a request in flight, an input delivered, a
 * cancellation, an error — and never that a request succeeded: host delivery
 * is not agent completion.
 */
export function McpFlows({ flows, actors }: { flows: readonly McpFlow[]; actors: readonly Actor[] }) {
  if (!flows.length) return null;
  const summary = flowSummary(flows, Date.now());
  const chips: { key: string; label: string; count: number }[] = [];
  if (summary.pending > 0) {
    const age = summary.pendingAgeMs === null ? "" : ` · ${Math.max(0, Math.round(summary.pendingAgeMs / 1000))}s`;
    chips.push({ key: "pending", label: `pending confirmation${age}`, count: summary.pending });
  }
  /* Every allowlisted outcome is named, in a fixed order, never folded together. */
  for (const outcome of MCP_FLOW_OUTCOMES) {
    const count = summary.outcomes[outcome] ?? 0;
    if (count > 0) chips.push({ key: outcome, label: flowOutcomeChip(outcome), count });
  }
  if (summary.unrecognized > 0) chips.push({ key: "unrecognized", label: "unrecognized outcome", count: summary.unrecognized });

  return (
    <details className="keep-mcp-flows" data-pending={summary.pending > 0 ? "true" : "false"}>
      <summary>
        <span className="keep-mcp-flows-count">
          {flows.length === 1 ? "1 MCP request" : `${flows.length} MCP requests`}
        </span>
        {summary.pending > 0 && (
          <span className="keep-mcp-flows-active" role="status">
            <span className="keep-mcp-flows-dot" aria-hidden="true" />
            {summary.pending === 1 ? "1 pending" : `${summary.pending} pending`}
          </span>
        )}
      </summary>
      <p className="keep-mcp-flows-note">
        External MCP client → session. The caller’s agent is not verified.
      </p>
      {chips.length > 0 && (
        <ul className="keep-mcp-flows-chips" aria-label="Observed MCP outcomes">
          {chips.map((chip) => (
            <li key={chip.key} data-outcome={chip.key}>
              {chip.label} · {chip.count}
            </li>
          ))}
        </ul>
      )}
      <ul className="keep-mcp-flows-list">
        {flows.slice(0, 4).map((flow) => {
          const target = actors.find((actor) => actor.session?.id === flow.targetSessionId);
          return (
            <li key={`${flow.targetSessionId}:${flow.id}`} data-phase={flow.phase} data-outcome={flow.outcome ?? ""}>
              <span className="keep-mcp-flows-target">
                {target ? target.name : "a session not shown here"}
              </span>
              <span className="keep-mcp-flows-tool">{flow.tool.replace(/^shell_/, "")}</span>
              <span className="keep-mcp-flows-status">{flowStatus(flow)}</span>
            </li>
          );
        })}
      </ul>
      <p className="keep-mcp-flows-note">
        Pending confirmation means no settled row was observed — it is not proof the request
        is still running, and observations expire. Input delivered means the terminal accepted
        it — not that the agent finished.
        {summary.newestAgeMs !== null ? ` Newest result ${Math.max(0, Math.round(summary.newestAgeMs / 1000))}s ago.` : ""}
      </p>
    </details>
  );
}
