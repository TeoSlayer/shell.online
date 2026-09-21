import { describe, expect, it } from "vitest";

// Isolated regressions for the staging-harness lib (P02 false-pass / redaction / classification
// fixes). These run WITHOUT network: the classification and redaction logic is pure.
// @ts-expect-error - .mjs module has no type declarations in the Workers type surface
import { redact, validateStagingUrl, classifyMcpResponse, classifyAbort, Evidence } from "../scripts/staging-harness/lib.mjs";
// @ts-expect-error - .mjs module has no type declarations in the Workers type surface
import { parseArgs } from "../scripts/staging-harness/run.mjs";

const sse = (obj: unknown) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;

describe("redact", () => {
  it("strips http(s) URLs (the share link)", () => {
    expect(redact("link https://shell.online/s/abc123?x=1 here")).not.toContain("shell.online");
    expect(redact("link https://shell.online/s/abc123?x=1 here")).toContain("[URL]");
  });
  it("strips the e2ee_password field value", () => {
    const out = redact('{"e2ee_password":"s3cret","session_id":"abc"}');
    expect(out).not.toContain("s3cret");
    expect(out).toContain('"e2ee_password":"[REDACTED]"');
    // the session id is intentionally kept (it is recorded in evidence)
    expect(out).toContain("abc");
  });
  it("strips explicitly-passed secrets (bearer, session id)", () => {
    const out = redact("bearer mcp_abc123 used", ["mcp_abc123"]);
    expect(out).not.toContain("mcp_abc123");
    expect(out).toContain("[REDACTED]");
  });
  it("returns empty string for null/undefined", () => {
    expect(redact(null)).toBe("");
    expect(redact(undefined)).toBe("");
  });
});

describe("validateStagingUrl", () => {
  it("accepts the exact pinned staging origin", () => {
    expect(validateStagingUrl("https://shell-online-staging.vulturelabs01.workers.dev")).toBe(
      "https://shell-online-staging.vulturelabs01.workers.dev",
    );
  });
  it("accepts explicit loopback http(s) for local testing", () => {
    expect(validateStagingUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(validateStagingUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(validateStagingUrl("https://localhost:9443")).toBe("https://localhost:9443");
  });
  it("rejects an unrelated account's shell-online-staging.*.workers.dev (a different deployment)", () => {
    expect(() =>
      validateStagingUrl("https://shell-online-staging.someotheraccount.workers.dev"),
    ).toThrow(/exact staging origin/);
  });
  it("rejects the staging custom route (not the pinned origin, not loopback)", () => {
    expect(() => validateStagingUrl("https://staging.shell.online")).toThrow(/exact staging origin/);
  });
  it("rejects production hostnames", () => {
    expect(() => validateStagingUrl("https://shell.online")).toThrow(/exact staging origin/);
    expect(() => validateStagingUrl("https://www.shell.online")).toThrow(/exact staging origin/);
  });
  it("rejects userinfo, query, and fragment", () => {
    expect(() =>
      validateStagingUrl("https://user:pass@shell-online-staging.vulturelabs01.workers.dev"),
    ).toThrow(/userinfo, query, or fragment/);
    expect(() =>
      validateStagingUrl("https://shell-online-staging.vulturelabs01.workers.dev?x=1"),
    ).toThrow(/userinfo, query, or fragment/);
    expect(() =>
      validateStagingUrl("https://shell-online-staging.vulturelabs01.workers.dev#frag"),
    ).toThrow(/userinfo, query, or fragment/);
  });
  it("rejects invalid URLs and non-http(s) schemes", () => {
    expect(() => validateStagingUrl("not a url")).toThrow(/not a valid URL/);
    expect(() =>
      validateStagingUrl("ftp://shell-online-staging.vulturelabs01.workers.dev"),
    ).toThrow(/exact staging origin/);
    expect(() => validateStagingUrl("ftp://localhost:8787")).toThrow(/loopback must be http/);
  });
});

describe("classifyMcpResponse", () => {
  it("treats an HTTP 200 with result.isError:true as a tool error (not success)", () => {
    const body = sse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "boom" }] } });
    const r = classifyMcpResponse(200, body);
    expect(r.toolError).toBe(true);
    expect(r.error).toBe("tool error: boom");
    expect(r.toolResult).toBeNull();
  });
  it("treats a normal success as error:null", () => {
    const body = sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"ok":true}' }] } });
    const r = classifyMcpResponse(200, body);
    expect(r.toolError).toBe(false);
    expect(r.error).toBeNull();
    expect(r.toolResult).toEqual({ ok: true });
  });
  it("distinguishes the concurrency 429 from the rate-limiter 429 by body", () => {
    expect(classifyMcpResponse(429, '{"error":"too many concurrent MCP requests"}').busy).toBe("concurrency");
    expect(classifyMcpResponse(429, '{"error":"too many MCP requests"}').busy).toBe("rate_limiter");
  });
  it("falls back to Retry-After when the 429 body is not JSON", () => {
    expect(classifyMcpResponse(429, "rate limited", { retryAfter: "1" }).busy).toBe("concurrency");
    expect(classifyMcpResponse(429, "rate limited", { retryAfter: "60" }).busy).toBe("rate_limiter");
  });
  it("surfaces a JSON-RPC error", () => {
    const body = sse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } });
    const r = classifyMcpResponse(200, body);
    expect(r.error).toBe("nope");
    expect(r.toolError).toBe(false);
  });
  it("reports an unparseable body as an error, not a success", () => {
    const r = classifyMcpResponse(200, "garbage");
    expect(r.error).toMatch(/unparseable/);
    expect(r.toolResult).toBeNull();
  });
});

describe("classifyAbort", () => {
  const abortErr = { name: "AbortError" };
  it("reports an intentional abort as aborted:true", () => {
    const r = classifyAbort(abortErr, { abortReason: "intentional" });
    expect(r.aborted).toBe(true);
    expect(r.abortedBy).toBe("intentional");
    expect(r.error).toBeNull();
  });
  it("reports a guard timeout as a timeout, NOT an intentional abort", () => {
    const r = classifyAbort(abortErr, { abortReason: "guard" });
    expect(r.aborted).toBe(false);
    expect(r.abortedBy).toBe("guard");
    expect(r.error).toBe("timeout");
  });
  it("reports an abort with no reason as a timeout, not an intentional abort", () => {
    const r = classifyAbort(abortErr, { abortReason: null });
    expect(r.aborted).toBe(false);
    expect(r.error).toBe("timeout");
  });
  it("reports a non-abort network error with its message", () => {
    const r = classifyAbort(new Error("network down"), { abortReason: null });
    expect(r.aborted).toBe(false);
    expect(r.error).toContain("network down");
  });
});

describe("Evidence.write secret scan", () => {
  it("refuses to write when a secret leaked into the evidence", () => {
    const e = new Evidence("case-x", { git: { rev: "abc", dirtyFiles: 0 } });
    e.step("s", { note: "bearer mcp_leak123 here" });
    expect(() => e.write("/tmp/should-not-exist-harness", ["mcp_leak123"])).toThrow(/secret leaked/);
  });
  it("writes when no secret is present", () => {
    const e = new Evidence("case-y", { git: { rev: "abc", dirtyFiles: 0 } });
    e.step("s", { note: "clean" });
    const file = e.write("/tmp/harness-evidence-test", ["mcp_leak123"]);
    expect(file).toContain("harness-case-y-");
  });
});

describe("parseArgs --trials validation", () => {
  it("accepts a positive integer", () => {
    expect(parseArgs(["--trials", "5"]).trials).toBe(5);
  });
  it("defaults to 20 trials and all cases when no args", () => {
    const a = parseArgs([]);
    expect(a.trials).toBe(20);
    expect(a.cases.length).toBeGreaterThan(0);
  });
  it("rejects a missing --trials value (would otherwise run zero trials)", () => {
    expect(() => parseArgs(["--trials"])).toThrow(/positive integer/);
  });
  it("rejects zero, negative, and non-integer --trials", () => {
    expect(() => parseArgs(["--trials", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--trials", "-1"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--trials", "2.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--trials", "abc"])).toThrow(/positive integer/);
  });
});
