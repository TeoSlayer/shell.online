import { describe, expect, it } from "vitest";
import { appendAudit, MAX_MCP_AUDIT, type McpAuditItem } from "../shared/mcp-audit";

describe("mcp-audit (bounded live-run trail)", () => {
  it("appends entries in order", () => {
    const audit: McpAuditItem[] = [];
    appendAudit(audit, { grantId: "g1", label: "a", scopes: ["observe"], tool: "shell_status", startedAt: 1, durationMs: 5, requestBytes: 10, outcome: "ok" });
    appendAudit(audit, { grantId: "g2", label: "b", kind: "revoked", at: 2 });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ grantId: "g1", tool: "shell_status", outcome: "ok" });
    expect(audit[1]).toMatchObject({ grantId: "g2", kind: "revoked" });
  });

  it("bounds the trail to the most recent MAX_MCP_AUDIT entries", () => {
    const audit: McpAuditItem[] = [];
    for (let i = 0; i < MAX_MCP_AUDIT + 50; i += 1) {
      appendAudit(audit, { grantId: `g${i}`, label: "a", scopes: ["observe"], tool: "shell_status", startedAt: i, durationMs: 1, requestBytes: 1, outcome: "ok" });
    }
    expect(audit).toHaveLength(MAX_MCP_AUDIT);
    // The oldest entries are dropped; the newest are retained.
    expect((audit[0] as { grantId: string }).grantId).toBe(`g50`);
    expect((audit[audit.length - 1] as { grantId: string }).grantId).toBe(`g${MAX_MCP_AUDIT + 49}`);
  });

  it("never grows beyond the bound regardless of call volume", () => {
    const audit: McpAuditItem[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      appendAudit(audit, { grantId: "g", label: "a", scopes: ["observe"], tool: "shell_output", startedAt: i, durationMs: 1, requestBytes: 1, outcome: "ok" });
    }
    expect(audit).toHaveLength(MAX_MCP_AUDIT);
  });
});
