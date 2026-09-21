import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs module has no type declarations in the Workers type surface
import { sanitizeTailStream, splitTopLevelObjects, extractTopLevelObjects, sanitizeObjects } from "../scripts/sanitize-tail-capture.mjs";

// A realistic wrangler-tail event: the request headers carry the MCP bearer (the thing a raw
// capture must never persist), and the logs carry one safe trace line plus one unrelated line.
const BEARER = "eyJhbGciOiJFQ0RILUVTIi.fake-outer.fake-encrypted-payload";
const SAFE_TRACE = "mcp_settle_trace event=settled reason=cancelled pending=0 ts=1789913787419";

function tailEvent(extraLogs: unknown[] = [], withSafeTrace = true): string {
  return JSON.stringify({
    outcome: "canceled",
    eventTimestamp: 1789913787300,
    logs: [
      ...(withSafeTrace ? [{ message: [SAFE_TRACE], level: "log", timestamp: 1789913787419 }] : []),
      ...extraLogs,
    ],
    event: {
      request: {
        url: "https://session.internal/internal/mcp",
        method: "POST",
        headers: {
          "x-mcp-bearer": BEARER,
          "x-mcp-route": "{\"sessionId\":\"Hg9blzqVNOk0wrAbS0MzRM4-UPmoqW2Z\"}",
        },
      },
    },
  });
}

describe("sanitized tail capture (allowlist before write)", () => {
  it("writes only the allowlisted trace line; the bearer and all other fields never appear", () => {
    const out = sanitizeTailStream(tailEvent());
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed).toEqual({ ts: 1789913787419, trace: SAFE_TRACE });
    const all = out.join("\n");
    expect(all).not.toContain(BEARER);
    expect(all).not.toContain("x-mcp-bearer");
    expect(all).not.toContain("Hg9blzqVNOk0wrAbS0MzRM4-UPmoqW2Z");
    expect(all).not.toContain("session.internal");
  });

  it("drops a trace line that does not match the allowlist (e.g. the old identifier-carrying format)", () => {
    const oldFormat = "mcp_settle_trace session=Hg9blzqVNO grant=cJ0v1wPl event=settled reason=cancelled ts=1789913787419";
    const out = sanitizeTailStream(tailEvent([{ message: [oldFormat], level: "log", timestamp: 1789913787420 }]));
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain("Hg9blzqVNO");
    expect(out[0]).not.toContain("cJ0v1wPl");
  });

  it("drops unrelated console logs even when they look trace-like", () => {
    const out = sanitizeTailStream(
      tailEvent([
        { message: ["responseMode: 'json' drops mid-call notifications."], level: "warn", timestamp: 1 },
        { message: ["mcp_settle_trace event=admitted timeout_ms=45000 ts=1789913785546"], level: "log", timestamp: 2 },
        { message: ["mcp_settle_trace event=registered pending=1 ts=1789913785547"], level: "log", timestamp: 3 },
      ]),
    );
    // SAFE_TRACE (settled) + admitted + registered = 3 kept; the responseMode warning is dropped.
    expect(out).toHaveLength(3);
    expect(out.join("\n")).not.toContain("responseMode");
  });

  it("handles multiple concatenated events and skips malformed chunks", () => {
    const stream = tailEvent() + "\n" + "not json at all" + "\n" + tailEvent();
    const out = sanitizeTailStream(stream);
    expect(out).toHaveLength(2);
  });

  it("splits top-level objects without breaking on braces inside strings", () => {
    const text = tailEvent() + tailEvent();
    const chunks = splitTopLevelObjects(text);
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0]).event.request.headers["x-mcp-bearer"]).toBe(BEARER);
  });

  it("emits nothing for a stream with no trace lines", () => {
    expect(sanitizeTailStream(tailEvent([{ message: ["plain log"], level: "log", timestamp: 1 }], false))).toEqual([]);
    expect(sanitizeTailStream("")).toEqual([]);
  });

  // Regression: the first version buffered ALL of stdin until EOF, so a live `wrangler tail`
  // (which never reaches EOF) captured nothing. The streaming loop must emit each complete
  // object as soon as it arrives and carry only the incomplete tail (rest) to the next chunk.
  it("streams: emits a complete object before EOF and carries the incomplete tail forward", () => {
    const objA = tailEvent();
    const objB = tailEvent();
    const stream = `${objA}\n${objB}`;
    // Chunk boundary: all of objA (complete) plus 30 chars into objB (incomplete).
    const cut = objA.length + 1 + 30;
    const chunk1 = stream.slice(0, cut);
    const chunk2 = stream.slice(cut);

    // Drive the exact loop the script's main block runs on each stdin "data" event.
    const emitted: string[] = [];
    let buffer = "";
    const onChunk = (text: string) => {
      buffer += text;
      const { objects, rest } = extractTopLevelObjects(buffer);
      buffer = rest;
      emitted.push(...sanitizeObjects(objects));
    };

    onChunk(chunk1);
    // objA is complete -> emitted WITHOUT waiting for EOF; objB's partial tail is retained.
    expect(emitted).toHaveLength(1);
    expect(buffer).toBe(objB.slice(0, 30));

    onChunk(chunk2);
    // objB completes on the next chunk -> emitted; nothing left over.
    expect(emitted).toHaveLength(2);
    expect(buffer).toBe("");
    expect(emitted.join("\n")).not.toContain(BEARER);
  });
});
