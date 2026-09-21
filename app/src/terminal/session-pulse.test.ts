import { describe, expect, it } from "vitest";
import { SessionPulseTracker } from "./session-pulse";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("SessionPulseTracker", () => {
  it("reports observed output and quiet without inferring process state", () => {
    const tracker = new SessionPulseTracker();
    expect(tracker.value(0)).toEqual({ activity: "unobserved", lastOutputAt: null, bytesSinceViewed: 0, hint: null });
    tracker.feed(bytes("hello"), 100);
    expect(tracker.value(15_099).activity).toBe("output");
    expect(tracker.value(15_100)).toEqual({ activity: "quiet", lastOutputAt: 100, bytesSinceViewed: 5, hint: null });
    tracker.feed(new Uint8Array(), 20_000);
    expect(tracker.value(20_000).lastOutputAt).toBe(100);
  });

  it("caps unread bytes and clears them when viewed or active", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(new Uint8Array(2 * 1024 * 1024).fill(97), 0);
    expect(tracker.value(0).bytesSinceViewed).toBe(1024 * 1024);
    tracker.viewed();
    expect(tracker.value(0).bytesSinceViewed).toBe(0);
    tracker.feed(bytes("x"), 1);
    tracker.feed(bytes("y"), 2, { active: true });
    expect(tracker.value(2).bytesSinceViewed).toBe(0);
  });

  it("seeds snapshot hints without creating live activity or unread bytes", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("Tests  12 passed (12)\n"), 400, { snapshot: true });
    expect(tracker.value(400)).toEqual({ activity: "unobserved", lastOutputAt: null, bytesSinceViewed: 0,
      hint: { kind: "result", label: "Test result reported" } });
    tracker.feed(bytes("live\n"), 500);
    tracker.feed(bytes("old\n"), 600, { snapshot: true });
    expect(tracker.value(600).lastOutputAt).toBe(500);
    expect(tracker.value(600).bytesSinceViewed).toBe(5);
  });

  it.each([
    ["Context too large", "Context limit reported"],
    ["Error: context window exceeded.", "Context limit reported"],
    ["Compaction failed: context too long", "Context limit reported"],
    ["Approval required", "Input may be needed"],
    ["Allow this command? [y/n]", "Input may be needed"],
    ["Tests: 2 failed, 3 passed, 5 total", "Test result reported"],
    ["Tests  2 failed | 3 passed (5)", "Test result reported"],
    ["==== 4 passed in 0.42s ====", "Test result reported"],
    ["test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; finished in 0.01s", "Test result reported"],
  ])("recognizes a fixed, qualified label for %s", (input, label) => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes(input), 0);
    expect(tracker.value(0).hint?.label).toBe(label);
  });

  it.each(["", "┃ ", "│ "])("recognizes the observed compaction error with border %j", (border) => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes(`  ${border}Session too large to compact - context exceeds model limit even after stripping media    \n`), 0);
    expect(tracker.value(0).hint).toEqual({ kind: "attention", label: "Context limit reported" });
  });

  it("does not classify prose quoting the observed compaction error", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("The session said: Session too large to compact - context exceeds model limit even after stripping media\n"), 0);
    expect(tracker.value(0).hint).toBeNull();
  });

  it.each([bytes("\x1b]unterminated"), bytes("partial line"), new Uint8Array([0xf0, 0x9f])])(
    "starts snapshot parsing independently of prior fragments %j", (fragment) => {
      const tracker = new SessionPulseTracker();
      tracker.feed(fragment, 10);
      tracker.feed(bytes("Tests 4 passed"), 20, { snapshot: true });
      expect(tracker.value(20)).toEqual({ activity: "output", lastOutputAt: 10, bytesSinceViewed: fragment.length,
        hint: { kind: "result", label: "Test result reported" } });
    },
  );

  it.each(["ordinary screen", ""])("clears old hints when a fresh snapshot contains %j", (screen) => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("Approval required"), 10);
    tracker.feed(bytes(screen), 20, { snapshot: true });
    expect(tracker.value(20).hint).toBeNull();
    expect(tracker.value(20).lastOutputAt).toBe(10);
    expect(tracker.value(20).bytesSinceViewed).toBe(17);
  });

  it("reclassifies the same matched line on an independent snapshot", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("Approval required"), 10);
    tracker.feed(bytes("Approval required"), 120_010, { snapshot: true });
    expect(tracker.value(120_010).hint?.label).toBe("Input may be needed");
  });

  it("handles every UTF-8 and ANSI chunk boundary", () => {
    const input = bytes("🔒\n\x1b]0;private title\x1b\\\x1b[32mTests  4 passed (4)\x1b[0m\n");
    for (let split = 0; split <= input.length; split++) {
      const tracker = new SessionPulseTracker();
      tracker.feed(input.subarray(0, split), 0);
      tracker.feed(input.subarray(split), 1);
      expect(tracker.value(1).hint).toEqual({ kind: "result", label: "Test result reported" });
    }
    const tracker = new SessionPulseTracker();
    for (const byte of input) tracker.feed(new Uint8Array([byte]), 0);
    expect(tracker.value(0).hint?.kind).toBe("result");
  });

  it.each(["\x1b]", "\x1bP", "\x1b_", "\x9d"])("discards unterminated escape string %j with bounded state", (prefix) => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes(prefix + "secret".repeat(200_000)), 0);
    tracker.feed(bytes("\nApproval required\nTests 4 passed\n"), 1);
    expect(tracker.value(1).hint).toBeNull();
    expect(JSON.stringify(tracker).length).toBeLessThan(3000);
    tracker.feed(bytes("\x1b\\\nApproval required\n"), 2);
    expect(tracker.value(2).hint?.label).toBe("Input may be needed");
  });

  it("bounds unterminated CSI sequences and long printable lines", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("\x1b[" + "1;".repeat(100_000)), 0);
    expect(JSON.stringify(tracker).length).toBeLessThan(3000);
    tracker.feed(bytes("m" + "x".repeat(100_000) + "Tests 4 passed\n"), 1);
    expect(tracker.value(1).hint).toBeNull();
    expect(JSON.stringify(tracker).length).toBeLessThan(3000);
    tracker.feed(bytes("Tests 4 passed\n"), 2);
    expect(tracker.value(2).hint?.kind).toBe("result");
  });

  it("never exposes terminal content in the public result", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("password=super-private\n\x1b]0;secret-title\x07Compaction failed: private-path\n"), 1);
    const result = tracker.value(1);
    expect(JSON.stringify(result)).not.toMatch(/super-private|secret-title|private-path|password/);
    result.hint!.label = "mutated";
    expect(tracker.value(1).hint?.label).toBe("Context limit reported");
  });

  it("does not interpret ticking output, prose, or hidden text as attention", () => {
    const tracker = new SessionPulseTracker();
    for (const line of ["working...", "tick 42", "I think all tests passed", "We discussed context too large",
      "$ echo 'Approval required'", "Tests should all have passed", "\x1b]0;Approval required\x07", "100% done"]) {
      tracker.feed(bytes(line + "\n"), 0);
      expect(tracker.value(0).hint).toBeNull();
    }
  });

  it("expires hints without renewing them on reads or unrelated output", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("Approval required\n"), 10);
    tracker.feed(bytes("tick\n"), 100_000);
    expect(tracker.value(120_009).hint).not.toBeNull();
    expect(tracker.value(120_010).hint).toBeNull();
    expect(tracker.value(120_011).activity).toBe("quiet");
  });

  it("resets activity, hints, unread bytes, decoder and escape state", () => {
    const tracker = new SessionPulseTracker();
    tracker.feed(bytes("Approval required\n\x1b]hidden"), 10);
    tracker.feed(new Uint8Array([0xf0, 0x9f]), 11);
    tracker.reset();
    expect(tracker.value(12)).toEqual({ activity: "unobserved", lastOutputAt: null, bytesSinceViewed: 0, hint: null });
    tracker.feed(bytes("Tests 4 passed"), 13);
    expect(tracker.value(13).hint?.label).toBe("Test result reported");
  });
});
