import { describe, expect, it, vi } from "vitest";
import { hostMcpFlowSink, trackMcpFlow, type McpFlowEvent } from "../shared/mcp-flow";

describe("MCP flow observations", () => {
  it("settles only when the actual handler completes, using one UUID", async () => {
    const events: McpFlowEvent[] = [];
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const result = trackMcpFlow("shell_wait", event => events.push(event), () => pending, () => "matched");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "shell_wait", phase: "started" });
    expect(events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    finish("private terminal response");
    expect(await result).toBe("private terminal response");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ id: events[0].id, phase: "settled", outcome: "matched" });
    expect(JSON.stringify(events)).not.toContain("private");
  });
  it("reports cancellation/errors without swallowing the handler error", async () => {
    const emit = vi.fn();
    await expect(trackMcpFlow("shell_screen", emit, async () => { throw new Error("private details"); }, failed => failed ? "cancelled" : "ok")).rejects.toThrow("private details");
    expect(emit.mock.calls[1][0]).toMatchObject({ phase: "settled", outcome: "cancelled" });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
  });
  it("only sends allowlisted metadata to the captured host, never viewers", async () => {
    const host = { readyState: 1, send: vi.fn() };
    const viewer = { readyState: 1, send: vi.fn() };
    let sameRun = true;
    const sink = hostMcpFlowSink(host, () => sameRun);
    sink({ id: "id", tool: "shell_send", phase: "started", at: 1, args: "secret", bearer: "secret", label: "secret" } as McpFlowEvent);
    expect(JSON.parse(host.send.mock.calls[0][0])).toEqual({ type: "mcp_flow", event: { id: "id", tool: "shell_send", phase: "started", at: 1 } });
    expect(viewer.send).not.toHaveBeenCalled();
    sameRun = false;
    sink({ id: "id", tool: "shell_send", phase: "settled", at: 2, outcome: "delivered" });
    expect(host.send).toHaveBeenCalledTimes(1);
    sameRun = true; host.readyState = 3;
    sink({ id: "id", tool: "shell_send", phase: "settled", at: 2, outcome: "delivered" });
    expect(host.send).toHaveBeenCalledTimes(1);
  });
  it("does not let missing hosts or telemetry failures fail a tool", async () => {
    expect(await trackMcpFlow("shell_status", hostMcpFlowSink(undefined, () => true), async () => 42, () => "ok")).toBe(42);
    expect(await trackMcpFlow("shell_status", () => { throw new Error("socket closed"); }, async () => 42, () => "ok")).toBe(42);
  });
});
