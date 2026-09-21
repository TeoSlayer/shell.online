import { flowStatus, type McpFlow } from "../state/mcp-flows";
import type { Actor } from "../world/sim";

/**
 * What external MCP clients are asking this garrison to do.
 *
 * The panel is deliberately about a *caller*, not an agent: the service can
 * attest that a tool call happened and which session it landed on, and nothing
 * more. So every row reads "External MCP client → <a real figure on this
 * field>", never an invented sender, and a request whose target is not
 * standing on the map says so rather than naming a session that is not here.
 */
export function McpFlows({ flows, actors }: { flows: readonly McpFlow[]; actors: readonly Actor[] }) {
  if (!flows.length) return null;
  return (
    <details className="keep-mcp-flows">
      <summary>
        {flows.length === 1 ? "1 MCP request" : `${flows.length} MCP requests`}
      </summary>
      <p className="keep-mcp-flows-note">
        External MCP client → session. The caller’s agent is not verified.
      </p>
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
        Input delivered means the terminal accepted it — not that the agent finished.
      </p>
    </details>
  );
}
