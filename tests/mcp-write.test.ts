import { describe, expect, it } from "vitest";
import {
  evictMcpOps,
  isUuidV4,
  MAX_MCP_OPS,
  mcpOpKey,
  resolveMcpOp,
  SEND_MAX_TEXT_BYTES,
  shellSendFingerprintInput,
  validateShellSendText,
  type McpOpRecord,
} from "../shared/mcp-write";

const utf8 = (s: string) => new TextEncoder().encode(s);
const OP = "550e8400-e29b-41d4-a716-446655440000";

function op(partial: Partial<McpOpRecord> & { operationId: string }): McpOpRecord {
  return {
    runId: "run-1",
    grantId: "grant-1",
    fingerprint: "fp",
    state: "claiming",
    claimedAt: 1000,
    result: null,
    ...partial,
  };
}

describe("shell_send strict text validation", () => {
  it("accepts printable text including multibyte and TAB", () => {
    expect(validateShellSendText("hello world", utf8)).toBeNull();
    expect(validateShellSendText("héllo → 世界", utf8)).toBeNull();
    expect(validateShellSendText("tab\there", utf8)).toBeNull();
  });

  it("rejects empty text", () => {
    expect(validateShellSendText("", utf8)).toMatch(/non-empty/);
  });

  it("rejects text over the byte cap (multibyte counts bytes, not chars)", () => {
    // 8192 ASCII bytes is fine; one more is not.
    expect(validateShellSendText("a".repeat(SEND_MAX_TEXT_BYTES), utf8)).toBeNull();
    expect(validateShellSendText("a".repeat(SEND_MAX_TEXT_BYTES + 1), utf8)).toMatch(/exceeds/);
    // A multibyte char near the cap: 3-byte chars, so the byte length exceeds sooner.
    const cjk = "世".repeat(Math.ceil(SEND_MAX_TEXT_BYTES / 3) + 1);
    expect(validateShellSendText(cjk, utf8)).toMatch(/exceeds/);
  });

  it("rejects NUL and C0 controls except TAB", () => {
    expect(validateShellSendText("a\u0000b", utf8)).toMatch(/forbidden/); // NUL
    expect(validateShellSendText("a\nb", utf8)).toMatch(/forbidden/); // LF
    expect(validateShellSendText("a\rb", utf8)).toMatch(/forbidden/); // CR
    expect(validateShellSendText("a\x1bb", utf8)).toMatch(/forbidden/); // ESC
    expect(validateShellSendText("a\x07b", utf8)).toMatch(/forbidden/); // BEL
    expect(validateShellSendText("a\tb", utf8)).toBeNull(); // TAB allowed
  });

  it("rejects C1 controls (DEL and the U+0080-U+009F block)", () => {
    expect(validateShellSendText("a\x7fb", utf8)).toMatch(/forbidden/); // DEL
    expect(validateShellSendText("a\u009fb", utf8)).toMatch(/forbidden/); // C1 end
  });
});

describe("operation_id (UUID v4)", () => {
  it("accepts a well-formed UUID v4", () => {
    expect(isUuidV4(OP)).toBe(true);
    expect(isUuidV4("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
  it("rejects non-UUID and wrong-version/variant strings", () => {
    expect(isUuidV4("not-a-uuid")).toBe(false);
    expect(isUuidV4("550e8400-e29b-11d4-a716-446655440000")).toBe(false); // version 1
    expect(isUuidV4("550e8400-e29b-41d4-0716-446655440000")).toBe(false); // variant 0
    expect(isUuidV4("550e8400e29b41d4a716446655440000")).toBe(false); // no dashes
  });
});

describe("canonical fingerprint input", () => {
  it("includes the tool name and the validated args, excluding the operation_id", () => {
    expect(shellSendFingerprintInput({ text: "hi", enter: false })).toBe(
      `shell_send\u001f${JSON.stringify({ enter: false, text: "hi" })}`,
    );
  });
  it("is stable for the same args and different for different args", () => {
    const a = shellSendFingerprintInput({ text: "hi", enter: true });
    const b = shellSendFingerprintInput({ text: "hi", enter: true });
    const c = shellSendFingerprintInput({ text: "hi", enter: false });
    const d = shellSendFingerprintInput({ text: "ho", enter: true });
    expect(a).toBe(b);
    expect(a).not.toBe(c); // enter differs
    expect(a).not.toBe(d); // text differs
  });
});

describe("at-most-once operation resolution", () => {
  it("claims a new id", () => {
    expect(resolveMcpOp([], "run-1", "grant-1", OP, "fp")).toEqual({ action: "claim" });
  });

  it("replays a terminal delivered/uncertain with the same fingerprint", () => {
    expect(resolveMcpOp([op({ operationId: OP, state: "delivered", result: "delivered" })], "run-1", "grant-1", OP, "fp")).toEqual({
      action: "replay",
      result: "delivered",
    });
    expect(resolveMcpOp([op({ operationId: OP, state: "uncertain", result: "delivery_uncertain" })], "run-1", "grant-1", OP, "fp")).toEqual({
      action: "replay",
      result: "delivery_uncertain",
    });
  });

  it("coalesces an in-flight id (claiming/dispatched) to in_flight", () => {
    expect(resolveMcpOp([op({ operationId: OP, state: "claiming" })], "run-1", "grant-1", OP, "fp")).toEqual({ action: "in_flight" });
    expect(resolveMcpOp([op({ operationId: OP, state: "dispatched" })], "run-1", "grant-1", OP, "fp")).toEqual({ action: "in_flight" });
  });

  it("conflicts on the same id with a different fingerprint (tool name or args)", () => {
    expect(resolveMcpOp([op({ operationId: OP, state: "delivered", fingerprint: "other" })], "run-1", "grant-1", OP, "fp")).toEqual({
      action: "conflict",
    });
  });

  it("scopes by run + grant + operation_id (a different grant/run is a fresh claim)", () => {
    expect(resolveMcpOp([op({ operationId: OP, grantId: "grant-2" })], "run-1", "grant-1", OP, "fp")).toEqual({ action: "claim" });
    expect(resolveMcpOp([op({ operationId: OP, runId: "run-2" })], "run-1", "grant-1", OP, "fp")).toEqual({ action: "claim" });
  });
});

describe("bounded op-store eviction", () => {
  it("does not evict when under the cap", () => {
    const { madeRoom } = evictMcpOps([op({ operationId: "a" })], () => true, MAX_MCP_OPS);
    expect(madeRoom).toBe(true);
  });

  it("evicts non-live entries first, oldest-first, and never a live grant's entry", () => {
    // Fill the store to the cap with a mix of live and non-live entries.
    const ops: McpOpRecord[] = [];
    for (let i = 0; i < MAX_MCP_OPS; i += 1) {
      const live = i % 2 === 0;
      ops.push(op({ operationId: `op-${i}`, grantId: live ? "live" : "dead", claimedAt: i, state: "delivered" }));
    }
    const { evicted, madeRoom } = evictMcpOps(ops, (gid) => gid === "live", MAX_MCP_OPS);
    expect(madeRoom).toBe(true);
    // Every evicted entry is from a non-live grant.
    for (const e of evicted) expect(e.grantId).toBe("dead");
  });

  it("rejects the new claim (madeRoom=false) when only live entries remain", () => {
    const ops: McpOpRecord[] = [];
    for (let i = 0; i < MAX_MCP_OPS; i += 1) ops.push(op({ operationId: `op-${i}`, grantId: "live", claimedAt: i }));
    const { madeRoom } = evictMcpOps(ops, () => true, MAX_MCP_OPS);
    expect(madeRoom).toBe(false);
  });
});

describe("full operation key (runId, grantId, operationId)", () => {
  it("is stable and distinguishes records that share an operation_id across grants or runs", () => {
    expect(mcpOpKey("run-1", "grant-1", OP)).toBe(mcpOpKey("run-1", "grant-1", OP));
    expect(mcpOpKey("run-1", "grant-1", OP)).not.toBe(mcpOpKey("run-1", "grant-2", OP));
    expect(mcpOpKey("run-1", "grant-1", OP)).not.toBe(mcpOpKey("run-2", "grant-1", OP));
    expect(mcpOpKey("run-1", "grant-1", OP)).not.toBe(mcpOpKey("run-2", "grant-2", OP));
  });
});

describe("conflict resolution preserves the original record", () => {
  it("does not mutate the stored record when the same id is reused with a different fingerprint", () => {
    const original = op({ operationId: OP, state: "delivered", result: "delivered", fingerprint: "fp" });
    const ops = [original];
    const resolution = resolveMcpOp(ops, "run-1", "grant-1", OP, "different-fp");
    expect(resolution).toEqual({ action: "conflict" });
    // The conflict is reported without touching the original: no new record, no state/result/
    // fingerprint change (the original operation's record is preserved for its own retry).
    expect(ops).toHaveLength(1);
    expect(ops[0]).toBe(original);
    expect(original).toEqual({
      runId: "run-1",
      grantId: "grant-1",
      operationId: OP,
      fingerprint: "fp",
      state: "delivered",
      claimedAt: 1000,
      result: "delivered",
    });
  });
});

describe("eviction removal is keyed by the full operation key", () => {
  it("removing evicted records by full key keeps a live record that shares an evicted record's operation_id", () => {
    // The store is full: a live grant's record (run-1, grant-live, OP) coexists with an expired
    // record from another grant (run-1, grant-dead, OP) — same UUID, different key.
    const live = op({ operationId: OP, grantId: "grant-live", state: "delivered", claimedAt: 5 });
    const dead = op({ operationId: OP, grantId: "grant-dead", state: "delivered", claimedAt: 1 });
    const ops: McpOpRecord[] = [dead, live];
    // Cap = 2: the store is full, so claiming one more op needs exactly one eviction.
    const { evicted } = evictMcpOps(ops, (gid) => gid === "grant-live", ops.length);
    expect(evicted).toEqual([dead]); // the expired record is evicted, the live one is not
    // The DO removes evicted entries by the FULL key — filtering by operationId alone would drop
    // the live record too.
    const evictedKeys = new Set(evicted.map((o) => mcpOpKey(o.runId, o.grantId, o.operationId)));
    const remaining = ops.filter((o) => !evictedKeys.has(mcpOpKey(o.runId, o.grantId, o.operationId)));
    expect(remaining).toEqual([live]);
    // By contrast, an operationId-only filter drops both (the bug).
    const byIdOnly = ops.filter((o) => !evicted.some((e) => e.operationId === o.operationId));
    expect(byIdOnly).toEqual([]);
  });
});
