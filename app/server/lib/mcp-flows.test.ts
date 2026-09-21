import { describe, expect, it } from "vitest";
import { MCP_FLOW_TTL, mcpFlowExpiry, readMcpFlows, trimMcpFlowRows, type McpFlowEvent, type McpFlowRow } from "./mcp-flows";

const now = 1_000_000;
const event: McpFlowEvent = { id: "00000000-0000-4000-8000-000000000001", tool: "shell_wait", phase: "started", at: now };

function row(overrides: Partial<McpFlowRow> = {}): McpFlowRow {
  return {
    ownerUid: "owner",
    orgId: "org",
    binding: "binding-1",
    eventId: "00000000-0000-4000-8000-000000000001",
    phase: "started",
    tool: "shell_wait",
    at: now,
    targetSessionId: "session1",
    expiresAt: now + MCP_FLOW_TTL,
    ...overrides,
  };
}

describe("MCP flow metadata", () => {
  it("accepts only the strict metadata schema and clamps small clock skew", () => {
    expect(readMcpFlows({ events: [{ ...event, at: now + 5000 }] }, now)).toEqual([event]);
    expect(readMcpFlows({ events: [{ ...event, phase: "settled", outcome: "timeout" }] }, now)).toEqual([{ ...event, phase: "settled", outcome: "timeout" }]);
  });

  it.each([
    { id: "label" }, { tool: "shell_interrupt" }, { phase: "running" }, { at: now + 5001 }, { at: now - MCP_FLOW_TTL },
    { at: 1.5 }, { outcome: "ok" }, { phase: "settled", outcome: "secret output" },
    { label: "secret" }, { source: "another agent" }, { content: "terminal text" }, { targetSessionId: "foreign" },
    { phase: ["started"] },
    { phase: { started: true } },
    { phase: 1 },
  ])("rejects unexpected or stale event fields %#", (patch) => {
    expect(readMcpFlows({ events: [{ ...event, ...patch }] }, now)).toBeNull();
  });

  it("does not coerce a phase that stringifies to an allowed value", () => {
    expect(readMcpFlows({ events: [{ ...event, phase: ["started"] }] }, now)).toBeNull();
    expect(readMcpFlows({ events: [{ ...event, phase: Object.assign([], { toString: () => "started" }) }] }, now)).toBeNull();
  });

  it("requires an allowlisted outcome on every settled event", () => {
    const settled = { ...event, phase: "settled" as const };
    expect(readMcpFlows({ events: [settled] }, now)).toBeNull();
    const explicit = { ...settled, outcome: undefined };
    expect(readMcpFlows({ events: [explicit] }, now)).toBeNull();
    expect(readMcpFlows({ events: [{ ...settled, outcome: "ok" }] }, now)).toEqual([{ ...settled, outcome: "ok" }]);
  });

  it("pairs one id with one started and one settled per batch", () => {
    expect(readMcpFlows({ events: [event, { ...event }] }, now)).toBeNull();
    expect(readMcpFlows({ events: [event, { ...event, phase: "settled", outcome: "matched" }] }, now)).toHaveLength(2);
  });

  it.each([
    "00000000-0000-1000-8000-000000000001", // version 1
    "00000000-0000-7000-8000-000000000001", // version 7
    "00000000-0000-4000-0000-000000000001", // variant 0
    "00000000-0000-4000-c000-000000000001", // variant c
  ])("rejects a non-v4 uuid %s", (id) => {
    expect(readMcpFlows({ events: [{ ...event, id }] }, now)).toBeNull();
  });

  it("accepts an uppercase v4 uuid and stores it lowercase", () => {
    const parsed = readMcpFlows({ events: [{ ...event, id: "00000000-0000-4000-8000-00000000000A" }] }, now);
    expect(parsed?.[0].id).toBe("00000000-0000-4000-8000-00000000000a");
  });

  it("rejects extra batch fields and batches outside 1–32 events", () => {
    expect(readMcpFlows({ events: [event], source: "foreign" }, now)).toBeNull();
    expect(readMcpFlows({ events: [] }, now)).toBeNull();
    expect(readMcpFlows({ events: Array(33).fill(event) }, now)).toBeNull();
    expect(readMcpFlows({ events: Array.from({ length: 32 }, (_, i) => ({ ...event, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })) }, now)).toHaveLength(32);
  });
});

describe("MCP flow row bounds", () => {
  it("keeps the first write's lifetime: a retry cannot extend the expiry", () => {
    expect(mcpFlowExpiry(now, now + 60_000)).toBe(now + MCP_FLOW_TTL);
    expect(mcpFlowExpiry(now + 4_000, now)).toBe(now + MCP_FLOW_TTL);
  });

  it("drops expired rows and trims one owner past the limit, keeping the newest", () => {
    const expired = row({ eventId: "00000000-0000-4000-8000-0000000000ff", expiresAt: now });
    const kept = Array.from({ length: 128 }, (_, i) =>
      row({ eventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, at: now + i }),
    );
    /* Ten older rows for the same owner: 138 in, 128 out, these ten go. */
    const oldest = Array.from({ length: 10 }, (_, i) =>
      row({ eventId: `00000000-4000-4000-8000-${String(i).padStart(12, "0")}`, at: now - 100 + i }),
    );
    const otherOwner = row({ ownerUid: "other", eventId: "00000000-4000-4000-8000-0000000000aa" });
    const trimmed = trimMcpFlowRows([...kept, ...oldest, expired, otherOwner], now + 1);
    expect(trimmed).toHaveLength(129);
    expect(trimmed.filter((r) => r.ownerUid === "owner")).toHaveLength(128);
    expect(trimmed.map((r) => r.eventId)).not.toContain("00000000-0000-4000-8000-0000000000ff");
    expect(trimmed.map((r) => r.eventId)).toContain("00000000-4000-4000-8000-0000000000aa");
    for (const old of oldest) expect(trimmed.map((r) => r.eventId)).not.toContain(old.eventId);
    for (const live of kept) expect(trimmed.map((r) => r.eventId)).toContain(live.eventId);
  });
});
