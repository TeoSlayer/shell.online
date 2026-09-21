import { describe, expect, it } from "vitest";
import { TerminalModel } from "../shared/terminal-model";

const enc = (s: string) => new TextEncoder().encode(s);
const opts = { cols: 80, rows: 24, maxTailChars: 10_000, maxOutputBytes: 10_000 };

describe("TerminalModel: output + cursor contract", () => {
  it("returns the tail with no cursor", () => {
    const model = new TerminalModel(opts);
    model.append(enc("hello world"));
    const result = model.output();
    expect(result.text).toBe("hello world");
    expect(result.reset).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.epoch).toBe(model.epoch);
  });

  it("returns text after a supplied cursor", () => {
    const model = new TerminalModel(opts);
    model.append(enc("hello world"));
    const result = model.output({ epoch: model.epoch, offset: 6 });
    expect(result.text).toBe("world");
    expect(result.reset).toBe(false);
  });

  it("returns empty for a cursor at the current offset", () => {
    const model = new TerminalModel(opts);
    model.append(enc("hello"));
    const result = model.output({ epoch: model.epoch, offset: model.currentOffset });
    expect(result.text).toBe("");
    expect(result.reset).toBe(false);
  });

  it("resets for a stale cursor (epoch mismatch) and returns the whole tail", () => {
    const model = new TerminalModel(opts);
    model.append(enc("hello"));
    model.reseed();
    model.append(enc("world"));
    // A cursor from a different (older) epoch is stale, even if its offset is valid.
    const result = model.output({ epoch: model.epoch + 1000, offset: 0 });
    expect(result.reset).toBe(true);
    expect(result.text).toBe("world");
  });

  it("resets for a cursor trimmed away from the bounded tail", () => {
    const model = new TerminalModel({ ...opts, maxTailChars: 5 });
    model.append(enc("abcdefghij"));
    const result = model.output({ epoch: model.epoch, offset: 0 });
    expect(result.reset).toBe(true);
    expect(result.text).toBe("fghij");
  });

  it("truncates output to maxOutputBytes, keeping the most recent text", () => {
    const model = new TerminalModel({ ...opts, maxOutputBytes: 5 });
    model.append(enc("abcdefghij"));
    const result = model.output();
    expect(result.text).toBe("fghij");
    expect(result.truncated).toBe(true);
  });

  it("caps CJK output by UTF-8 bytes, not characters", () => {
    const model = new TerminalModel({ ...opts, maxOutputBytes: 6 });
    // Each CJK char is 3 UTF-8 bytes; 6 bytes = exactly 2 chars (the most recent).
    model.append(enc("日本語テスト"));
    const result = model.output();
    expect(result.text).toBe("スト");
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(6);
  });

  it("flags truncated when the bounded tail omitted earlier output", () => {
    const model = new TerminalModel({ ...opts, maxTailChars: 5 });
    model.append(enc("abcdefghij"));
    const result = model.output();
    expect(result.truncated).toBe(true);
  });

  it("sanitizes ANSI from output", () => {
    const model = new TerminalModel(opts);
    model.append(enc("\x1b[1;32mcolored\x1b[0m text"));
    expect(model.output().text).toBe("colored text");
  });
});

describe("TerminalModel: F2 OSC safety across trim + wait boundaries", () => {
  it("does not leak an OSC payload when the tail boundary falls mid-sequence", () => {
    const model = new TerminalModel({ ...opts, maxTailChars: 10 });
    // An OSC title sequence whose payload straddles the trim boundary: the retained tail begins
    // inside the OSC, so a sanitizer that starts in ground state would leak the payload tail.
    model.append(enc("AAAA\x1b]0;SECRET TITLE\x07BBBB"));
    const result = model.output();
    // Only the text after the OSC ("BBBB") is real terminal content; the OSC payload is stripped.
    expect(result.text).toBe("BBBB");
    expect(result.text).not.toContain("SECRET");
    expect(result.text).not.toContain("TITLE");
  });

  it("does not leak an OSC payload straddling a wait-result baseline boundary", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("AA\x1b]0;SECRET\x07BB"));
    // Baseline the wait mid-OSC (offset 8 lands on 'C' of the OSC payload "SECRET").
    const cursor = { epoch: model.epoch, offset: 8 };
    const promise = model.wait("DONE", cursor, 1000, new AbortController().signal);
    model.append(enc("DONE"));
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.text).toContain("DONE");
    // The OSC payload tail ("RET") must not leak into the wait result.
    expect(result.text).not.toContain("RET");
  });
});

describe("TerminalModel: screen (headless VT)", () => {
  it("renders a plain-text screen and strips ANSI", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("\x1b[1;32mcalin@host\x1b[0m:~/repo$ npm test\r\n"));
    model.append(enc("  \x1b[32m✓\x1b[0m 12 tests passed\r\n"));
    const { text, epoch } = await model.screen();
    expect(text).toContain("calin@host:~/repo$ npm test");
    expect(text).toContain("12 tests passed");
    expect(text).not.toContain("\x1b[");
    expect(epoch).toBe(model.epoch);
  });

  it("reflects carriage-return overwrite on the screen", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("hello\rworld\r\n"));
    const { text } = await model.screen();
    expect(text.split("\n")[0]).toBe("world");
  });

  it("returns an empty screen before any output", async () => {
    const model = new TerminalModel(opts);
    const { text } = await model.screen();
    expect(text.replace(/\s+/g, "")).toBe("");
  });
});

describe("TerminalModel: wait", () => {
  it("matches new output after the baseline", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("hello "));
    const promise = model.wait("WORLD", undefined, 1000, new AbortController().signal);
    model.append(enc("WORLD"));
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("matched");
    expect(result.text).toContain("WORLD");
  });

  it("matches output after a supplied cursor only", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("PROMPT first"));
    const cursor = { epoch: model.epoch, offset: model.currentOffset };
    const promise = model.wait("second", cursor, 1000, new AbortController().signal);
    model.append(enc("PROMPT second"));
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.text).toContain("second");
  });

  it("does not match pre-existing output when no cursor is supplied", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("already here"));
    const result = await model.wait("already", undefined, 50, new AbortController().signal);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("times out when the pattern never appears", async () => {
    const model = new TerminalModel(opts);
    const start = Date.now();
    const result = await model.wait("NEVER", undefined, 50, new AbortController().signal);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it("cancels on the abort signal", async () => {
    const model = new TerminalModel(opts);
    const controller = new AbortController();
    const promise = model.wait("NEVER", undefined, 1000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("cancelled");
  });

  it("resets when the model is re-seeded during the wait", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("start"));
    const promise = model.wait("NEVER", undefined, 1000, new AbortController().signal);
    model.reseed();
    const result = await promise;
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("reset");
    expect(result.reset).toBe(true);
  });

  it("matches a pattern that spans two appends", async () => {
    const model = new TerminalModel(opts);
    const promise = model.wait("SPAN", undefined, 1000, new AbortController().signal);
    model.append(enc("pre-"));
    model.append(enc("SPAN-post"));
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.text).toContain("SPAN");
  });

  it("with no pattern, settles as soon as ANY new output arrives", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("baseline"));
    const promise = model.wait(null, undefined, 1000, new AbortController().signal);
    model.append(enc("anything"));
    const result = await promise;
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("matched");
    expect(result.text).toContain("anything");
  });

  it("with no pattern, does NOT match pre-existing output (times out if nothing new)", async () => {
    const model = new TerminalModel(opts);
    model.append(enc("already here"));
    const result = await model.wait(null, undefined, 50, new AbortController().signal);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("settles immediately as cancelled when the signal is already aborted", async () => {
    const model = new TerminalModel(opts);
    const controller = new AbortController();
    controller.abort();
    const result = await model.wait("NEVER", undefined, 1000, controller.signal);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe("cancelled");
  });

  it("matches a pattern in the full history even when the response is byte-capped", async () => {
    // A tiny byte cap would cut the response text, but the match is against the full tail.
    const model = new TerminalModel({ ...opts, maxOutputBytes: 8 });
    const promise = model.wait(null, undefined, 1000, new AbortController().signal);
    model.append(enc("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxNEAR-END"));
    const result = await promise;
    expect(result.matched).toBe(true);
    // The returned text is capped to the most recent 8 bytes, but the match still succeeded.
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(8);
  });
});

describe("TerminalModel: lifecycle", () => {
  it("reseed bumps the epoch and clears the tail", () => {
    const model = new TerminalModel(opts);
    model.append(enc("old"));
    const before = model.epoch;
    model.reseed();
    expect(model.epoch).toBe(before + 1);
    expect(model.currentOffset).toBe(0);
    expect(model.output().text).toBe("");
  });

  it("free cancels pending waits", async () => {
    const model = new TerminalModel(opts);
    const promise = model.wait("NEVER", undefined, 1000, new AbortController().signal);
    model.free();
    const result = await promise;
    expect(result.reason).toBe("cancelled");
  });

  it("ignores empty appends", () => {
    const model = new TerminalModel(opts);
    model.append(new Uint8Array(0));
    expect(model.currentOffset).toBe(0);
    expect(model.output().text).toBe("");
  });
});
