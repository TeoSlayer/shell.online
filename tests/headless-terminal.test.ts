// Phase 0 spike 5 — prove a headless VT runs in a plain JS runtime (Node here,
// Workers isolate next) and produces a stable plain-text screen from an ANSI
// snapshot. This is the gate for `shell_screen`. If @xterm/headless does not run
// or mis-renders, we fall back to a minimal VT and defer shell_screen.
//
// FINDING: @xterm/headless write() is ASYNCHRONOUS — the buffer is not updated
// synchronously; you must await the write callback (or a tick) before reading the
// screen or matching patterns. The DO's TerminalModel must await writes the same
// way before producing a screen or advancing the wait cursor.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";

type VT = InstanceType<typeof Terminal>;

async function writeAll(term: VT, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
}

function visibleScreen(term: VT): string {
  const buf = term.buffer.active;
  const start = buf.viewportY;
  const lines: string[] = [];
  for (let i = 0; i < term.rows; i += 1) {
    const line = buf.getLine(start + i);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\n");
}

describe("headless terminal rendering", () => {
  it("constructs and writes with no DOM/Node-specific globals", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
    await writeAll(term, "line one\r\nline two\r\n");
    const lines = visibleScreen(term).split("\n");
    expect(lines[0]).toBe("line one");
    expect(lines[1]).toBe("line two");
  });

  it("renders a realistic colored prompt snapshot to a stable screen", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 120, rows: 36 });
    await writeAll(term, "\x1b[1;32mcalin@host\x1b[0m:\x1b[34m~/repo\x1b[0m$ npm test\r\n");
    await writeAll(term, "  \x1b[32m✓\x1b[0m 12 tests passed (450ms)\r\n");
    await writeAll(term, "\x1b[1;32mcalin@host\x1b[0m:\x1b[34m~/repo\x1b[0m$ ");
    const screen = visibleScreen(term);
    expect(screen).toContain("calin@host:~/repo$ npm test");
    expect(screen).toContain("12 tests passed");
    // SGR/CSI sequences must be interpreted, not leaked into the plain screen.
    expect(screen).not.toContain("\x1b[");
  });

  it("carriage return overwrites the current line", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
    await writeAll(term, "hello\rworld\r\n");
    expect(visibleScreen(term).split("\n")[0]).toBe("world");
  });

  it("tracks the active viewport across scrolling", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 4 });
    // No trailing newline on the last row, so the cursor rests on "row 10".
    for (let i = 1; i <= 10; i += 1) await writeAll(term, `row ${i}${i < 10 ? "\r\n" : ""}`);
    const lines = visibleScreen(term).split("\n");
    // Only the last 4 rows remain visible after scroll.
    expect(lines[0]).toBe("row 7");
    expect(lines[3]).toBe("row 10");
  });
});
