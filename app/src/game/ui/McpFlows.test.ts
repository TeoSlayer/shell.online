import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { McpFlow } from "../state/mcp-flows";
import type { Actor } from "../world/sim";
import { McpFlows } from "./McpFlows";

const actor = { name: "Wright One", session: { id: "live-1" } } as unknown as Actor;
const ID = "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d1e2f";
const ID2 = "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d2e3f";
const ID3 = "6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d3e4f";

const flow = (overrides: Partial<McpFlow>): McpFlow => ({
  id: ID,
  targetSessionId: "live-1",
  tool: "shell_send",
  phase: "settled",
  at: Date.now() - 1_000,
  outcome: "delivered",
  ...overrides,
});

describe("MCP activity panel", () => {
  it("counts an in-flight request as active until its own settled row exists", () => {
    const started = flow({ id: ID2, phase: "started", outcome: undefined });
    const onlyStarted = renderToStaticMarkup(createElement(McpFlows, { flows: [started], actors: [actor] }));
    expect(onlyStarted).toContain("pending confirmation");
    expect(onlyStarted).toContain("1 pending");

    const paired = renderToStaticMarkup(
      createElement(McpFlows, { flows: [started, flow({ id: ID2, outcome: "delivered" })], actors: [actor] }),
    );
    expect(paired).not.toContain("keep-mcp-flows-active");
    expect(paired).toContain('data-pending="false"');
    expect(paired).toContain("input delivered · 1");
  });

  it("keeps delivered, cancelled and error distinct and claims no completion", () => {
    const html = renderToStaticMarkup(
      createElement(McpFlows, {
        flows: [
          flow({ id: ID, outcome: "delivered" }),
          flow({ id: ID2, outcome: "cancelled" }),
          flow({ id: ID3, outcome: "error" }),
        ],
        actors: [actor],
      }),
    );
    expect(html).toContain("input delivered · 1");
    expect(html).toContain("cancelled · 1");
    expect(html).toContain("request failed · 1");
    expect(html).not.toContain("unrecognized outcome");
    /* The neutral attribution and the delivery disclaimer survive. */
    expect(html).toMatch(/External MCP client/);
    expect(html).toContain("not that the agent finished");
    /* And nothing in the panel reads as success or as an action. */
    expect(html).not.toMatch(/success|approved|deploy|task complete|request complete/i);
  });

  it("lists a request whose session is not on the field without inventing a figure", () => {
    const html = renderToStaticMarkup(
      createElement(McpFlows, { flows: [flow({ targetSessionId: "live-unknown" })], actors: [actor] }),
    );
    expect(html).toContain("a session not shown here");
  });

  it("renders nothing when there are no observations", () => {
    expect(renderToStaticMarkup(createElement(McpFlows, { flows: [], actors: [] }))).toBe("");
  });
});
