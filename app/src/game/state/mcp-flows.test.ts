import { describe, expect, it } from "vitest";
import {
  expiringMcpFlows,
  flowColor,
  flowStatus,
  isUuidV4,
  readMcpFlows,
  type McpFlow,
} from "./mcp-flows";

const NOW = 1_730_000_000_123;
const LIVE = "live-session-1";
const OTHER = "live-session-2";
const allowed = new Set([LIVE, OTHER]);
const id = (suffix: string) => `6f1d9f5e-4a1b-4c8d-9f2e-0b7c3a5d${suffix}`;
const ID1 = id("1e2f");

const row = (overrides: Record<string, unknown> = {}) => ({
  id: ID1,
  targetSessionId: LIVE,
  tool: "shell_screen",
  phase: "started",
  at: NOW - 1_000,
  ...overrides,
});

describe("MCP flow parsing", () => {
  it("accepts a well-formed started and settled pair", () => {
    const flows = readMcpFlows([
      row(),
      row({ phase: "settled", at: NOW - 500, outcome: "ok" }),
    ], allowed, NOW);
    expect(flows).toEqual([
      { id: ID1, targetSessionId: LIVE, tool: "shell_screen", phase: "settled", at: NOW - 500, outcome: "ok" },
    ]);
  });

  it("only accepts canonical v4 ids", () => {
    expect(isUuidV4(ID1)).toBe(true);
    expect(isUuidV4(ID1.toUpperCase())).toBe(true);
    expect(isUuidV4("6f1d9f5e-4a1b-3c8d-9f2e-0b7c3a5d1e2f")).toBe(false);
    expect(isUuidV4("6f1d9f5e-4a1b-4c8d-1f2e-0b7c3a5d1e2f")).toBe(false);
    expect(isUuidV4("not-a-uuid")).toBe(false);
    expect(isUuidV4(42)).toBe(false);
    expect(readMcpFlows([row({ id: "6f1d9f5e-4a1b-3c8d-9f2e-0b7c3a5d1e2f" })], allowed, NOW)).toEqual([]);
  });

  it("refuses unknown fields, tools, phases and outcomes", () => {
    expect(readMcpFlows([row({ args: "secret" })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ tool: "shell_hack" })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ phase: "finished" })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ phase: "started", outcome: "ok" })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ phase: "settled" })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ phase: "settled", outcome: "exploded" })], allowed, NOW)).toEqual([]);
  });

  it("drops targets that are not live and owned", () => {
    expect(readMcpFlows([row({ targetSessionId: "somebody-elses" })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ targetSessionId: 7 })], allowed, NOW)).toEqual([]);
  });

  it("drops rows outside the short life, and anything future-dated far enough", () => {
    expect(readMcpFlows([row({ at: NOW - 120_000 })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ at: NOW + 6_000 })], allowed, NOW)).toEqual([]);
    expect(readMcpFlows([row({ at: 1.5 })], allowed, NOW)).toEqual([]);
  });

  it("dedups by target session and id, keeping the settled or latest phase", () => {
    const flows = readMcpFlows([
      row({ phase: "settled", at: NOW - 800, outcome: "timeout" }),
      row({ phase: "started", at: NOW - 100 }),
    ], allowed, NOW);
    expect(flows).toHaveLength(1);
    expect(flows[0].phase).toBe("settled");
    expect(flows[0].outcome).toBe("timeout");

    /* The same id on two different sessions is two real calls. */
    const two = readMcpFlows([
      row(),
      row({ targetSessionId: OTHER }),
    ], allowed, NOW);
    expect(two).toHaveLength(2);
    expect(new Set(two.map((flow) => flow.targetSessionId))).toEqual(new Set([LIVE, OTHER]));
  });

  it("bounds what is kept and orders newest first", () => {
    const many = Array.from({ length: 40 }, (_, index) => row({
      id: `6f1d9f5e-4a1b-4c8d-9f2e-${String(index).padStart(12, "0")}`,
      at: NOW - index * 100,
    }));
    const flows = readMcpFlows(many, allowed, NOW);
    expect(flows.length).toBeLessThanOrEqual(32);
    for (let index = 1; index < flows.length; index += 1) {
      expect(flows[index - 1].at).toBeGreaterThanOrEqual(flows[index].at);
    }
  });

  it("returns nothing for a malformed answer", () => {
    expect(readMcpFlows(null, allowed, NOW)).toEqual([]);
    expect(readMcpFlows({ flows: [] }, allowed, NOW)).toEqual([]);
    expect(readMcpFlows([null, 7, "x"], allowed, NOW)).toEqual([]);
  });
});

describe("flow presentation", () => {
  const flow = (overrides: Partial<McpFlow> = {}): McpFlow => ({
    id: ID1, targetSessionId: LIVE, tool: "shell_send", phase: "settled", at: NOW, outcome: "delivered", ...overrides,
  });

  it("keeps delivered, cancelled, timeout and error distinct, and none says finished", () => {
    const labels = ["delivered", "cancelled", "timeout", "error", "delivery_uncertain", "in_flight"]
      .map((outcome) => flowStatus(flow({ outcome })));
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.toLowerCase()).not.toContain("finished");
    expect(flowStatus(flow({ outcome: "delivered" }))).toContain("delivered");
    expect(flowStatus(flow({ outcome: "cancelled" }))).toContain("cancelled");
    expect(flowStatus(flow({ outcome: "timeout" }))).toContain("timed out");
    expect(flowStatus(flow({ phase: "started", outcome: undefined }))).toBe("Request started");
  });

  it("expires without any fetch, and colors by state", () => {
    const fresh = flow({ at: NOW - 1_000 });
    expect(expiringMcpFlows([fresh], NOW)).toHaveLength(1);
    expect(expiringMcpFlows([fresh], NOW + 120_000)).toHaveLength(0);
    expect(flowColor(flow({ phase: "started", outcome: undefined }))).toBe(0x89dceb);
    expect(flowColor(flow({ outcome: "delivered" }))).toBe(0xa6e3a1);
    expect(flowColor(flow({ outcome: "timeout" }))).toBe(0xf9c27a);
  });
});
