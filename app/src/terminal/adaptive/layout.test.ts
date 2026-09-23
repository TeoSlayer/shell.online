import { describe, expect, it } from "vitest";
import headless from "@xterm/headless";
import { capture, type Capture } from "./fixtures/captures";
import {
  scrollAnchor,
  windowAtBottom,
  windowFrom,
  type Cell,
  type LaidRow,
  type LayoutOptions,
  type SourceRow,
  type SourceScreen,
} from "./layout";
import { BufferScreen, type BufferLike } from "./source";

/*
 * Everything below reads sessions captured from real programs (see
 * fixtures/README.md), replayed through the emulator the renderer uses.
 */
async function replay(name: Capture, cols = 120, rows = 36) {
  const term = new headless.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(capture(name), resolve));
  const buffer = term.buffer.active as unknown as BufferLike;
  const screen = new BufferScreen(buffer, cols);
  const alternate = buffer.type === "alternate";
  const options: LayoutOptions = {
    cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY },
    collapseBlankRuns: alternate,
    top: alternate ? buffer.baseY : 0,
  };
  return { term, buffer, screen, options };
}

const text = (row: LaidRow) => row.cells.map((cell) => cell.chars).join("").replace(/\s+$/u, "");
const texts = (rows: readonly LaidRow[]) => rows.map(text);
const width = (row: LaidRow) => row.cells.reduce((sum, cell) => sum + cell.width, 0);

/* A screen built from plain rows, for rules that are clearer stated than captured. */
function plain(rows: readonly string[], cols = 40, wrapped: readonly number[] = []): SourceScreen {
  const toRow = (line: string, index: number): SourceRow => ({
    cells: Array.from(line.padEnd(cols, " ")).slice(0, cols).map(
      (chars): Cell => ({ chars, width: 1, style: "", ink: chars !== " " }),
    ),
    wrapped: wrapped.includes(index),
  });
  const built = rows.map(toRow);
  return { width: cols, length: built.length, row: (y) => built[y] ?? { cells: [], wrapped: false } };
}

describe("Claude Code, which breaks its own prose at the session's width", () => {
  it("puts a paragraph back together and wraps it at the viewer's width", async () => {
    const { screen, options } = await replay("claude");
    const rows = texts(windowAtBottom(screen, 45, 200, options).rows);
    const start = rows.findIndex((row) => row.startsWith("  A pseudo-terminal (PTY)"));
    expect(start).toBeGreaterThan(0);
    const paragraph = rows.slice(start, rows.indexOf("", start));
    expect(paragraph.length).toBeGreaterThan(8);
    /* Every row is within the viewer, and keeps the answer's two-column indent. */
    for (const row of paragraph) {
      expect(row.length).toBeLessThanOrEqual(45);
      expect(row.startsWith("  ")).toBe(true);
    }
    /* The words are the program's, in the program's order. */
    expect(paragraph.map((row) => row.trim()).join(" ")).toContain(
      'a program such as a terminal emulator, ssh or tmux holds the "master" side',
    );
  });

  it("keeps each list item on its own line", async () => {
    const { screen, options } = await replay("claude");
    const rows = texts(windowAtBottom(screen, 45, 200, options).rows);
    expect(rows).toContain("  - notes.md");
    expect(rows).toContain("  - plan.txt");
    expect(rows).toContain("  - server.go");
  });

  it("hangs the continuation of a marked line under its text, not its marker", async () => {
    const { screen, options } = await replay("claude");
    const rows = texts(windowAtBottom(screen, 45, 200, options).rows);
    const said = rows.findIndex((row) => row.startsWith("⏺ The directory"));
    expect(rows[said + 1].startsWith("  ")).toBe(true);
    expect(rows[said + 1].startsWith("   ")).toBe(false);
  });

  it("draws the composer's rules across the viewer's width", async () => {
    const { screen, options } = await replay("claude");
    for (const cols of [45, 70]) {
      const rules = windowAtBottom(screen, cols, 200, options).rows.filter((row) => /^─+$/u.test(text(row)));
      expect(rules).toHaveLength(2);
      for (const rule of rules) expect(width(rule)).toBe(cols);
    }
  });

  it("keeps the cursor in the composer", async () => {
    const { screen, options } = await replay("claude");
    const rows = windowAtBottom(screen, 45, 200, options).rows;
    const cursorRow = rows.find((row) => row.cursor !== undefined);
    expect(cursorRow && text(cursorRow)).toBe("❯");
    expect(cursorRow?.cursor).toBe(2);
  });

  it("drops the padding a full-screen program leaves between its content and its composer", async () => {
    const { screen, options } = await replay("claude");
    const rows = texts(windowAtBottom(screen, 70, 200, options).rows);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index] === "" && rows[index - 1] === "").toBe(false);
    }
  });

  it("shows the grid unchanged at the session's own width", async () => {
    const { buffer, screen, options } = await replay("claude");
    const laid = texts(windowAtBottom(screen, 120, 200, { ...options, collapseBlankRuns: false }).rows);
    const original: string[] = [];
    for (let y = buffer.baseY; y < buffer.baseY + 36; y += 1) {
      original.push(screen.row(y).cells.map((cell) => cell.chars).join("").replace(/\s+$/u, ""));
    }
    while (original.length && original[original.length - 1] === "") original.pop();
    expect(laid).toEqual(original);
  });
});

describe("a shell, in the normal buffer", () => {
  it("rewraps a line the terminal wrapped", async () => {
    const { screen, options } = await replay("shell");
    const rows = texts(windowAtBottom(screen, 50, 400, options).rows);
    const start = rows.indexOf("This is one long logical line that a program");
    expect(start).toBeGreaterThan(0);
    const joined = rows.slice(start, start + 5).join(" ");
    expect(joined).toContain("instead of cutting it in half.");
  });

  it("breaks a listing at a column gap rather than inside a word", async () => {
    const { screen, options } = await replay("shell");
    const rows = texts(windowAtBottom(screen, 50, 400, options).rows);
    let cut = 0;
    for (let index = 0; index + 1 < rows.length; index += 1) {
      if (!/^[-d]rw/u.test(rows[index]) || /^[-d]rw|^dev@host/u.test(rows[index + 1])) continue;
      /* The row and its continuation are the original line, cut where a space was. */
      cut += 1;
      expect(rows[index].length).toBe(rows[index].trimEnd().length);
      expect(rows[index + 1].startsWith(" ")).toBe(false);
      expect(rows[index]).not.toMatch(/\d:$|:\d$/u);
    }
    expect(cut).toBeGreaterThan(10);
  });

  it("keeps a right-aligned line against the viewer's right edge", async () => {
    const { screen, options } = await replay("shell");
    const rows = windowAtBottom(screen, 50, 400, options).rows;
    const status = rows.find((row) => text(row).endsWith("right aligned status · 12:04") && text(row).startsWith(" "));
    expect(status && width(status)).toBe(50);
  });

  it("never draws a row wider than the viewer, wide characters included", async () => {
    const { screen, options } = await replay("shell");
    for (const cols of [23, 24, 37, 50]) {
      for (const row of windowAtBottom(screen, cols, 400, options).rows) expect(width(row)).toBeLessThanOrEqual(cols);
    }
  });

  it("keeps color", async () => {
    const { screen, options } = await replay("shell");
    const rows = windowAtBottom(screen, 50, 400, options).rows;
    const error = rows.find((row) => text(row).startsWith(" ERROR"));
    expect(error?.cells[1].style).toContain("41");
  });

  it("puts the cursor after the prompt", async () => {
    const { screen, options } = await replay("shell");
    const rows = windowAtBottom(screen, 50, 20, options).rows;
    const last = rows[rows.length - 1];
    expect(text(last)).toBe("dev@host:~/shell.online$");
    expect(last.cursor).toBe(25);
  });
});

describe("at every width", () => {
  const visible = (value: string) => value.replace(/[\s─]/gu, "");

  for (const name of ["shell", "claude", "vim"] as const) {
    it(`fits and keeps every character of ${name}`, async () => {
      const { buffer, screen, options } = await replay(name);
      const top = options.top ?? 0;
      let source = "";
      for (let y = top; y < buffer.length; y += 1) source += screen.row(y).cells.map((cell) => cell.chars).join("");
      for (let cols = 10; cols <= 130; cols += 1) {
        const rows = windowAtBottom(screen, cols, 100_000, options).rows;
        for (const row of rows) expect(width(row)).toBeLessThanOrEqual(cols);
        expect(visible(rows.map((row) => row.cells.map((cell) => cell.chars).join("")).join(""))).toBe(visible(source));
      }
    });
  }
});

describe("the rule that recovers a program's own line breaks", () => {
  it("joins a row that ran to the edge with the row it continues on", () => {
    const screen = plain(["the quick brown fox jumps over the lazy", "dog and keeps running"], 40);
    expect(texts(windowAtBottom(screen, 20, 20).rows)).toEqual(["the quick brown fox", "jumps over the lazy", "dog and keeps", "running"]);
  });

  it("leaves a row that stopped short of the edge where it stopped", () => {
    const screen = plain(["first line", "second line"], 40);
    expect(texts(windowAtBottom(screen, 20, 20).rows)).toEqual(["first line", "second line"]);
  });

  /* Seen in a real shell: a wrapped command's output ended near the edge and the next prompt was glued on. */
  it("never joins onto a line the terminal wrapped, which ended where the program ended it", () => {
    const screen = plain(["one long line that the terminal had to w", "rap and that ends close to the right ed", "$ next"], 40, [1]);
    const rows = texts(windowAtBottom(screen, 40, 20).rows);
    expect(rows.at(-1)).toBe("$ next");
    expect(rows.slice(0, -1).join(" ")).toBe("one long line that the terminal had to wrap and that ends close to the right ed");
  });

  it("does not join into a list item", () => {
    const screen = plain(["the quick brown fox jumps over the lazy", "- dog"], 40);
    expect(texts(windowAtBottom(screen, 30, 20).rows)).toEqual(["the quick brown fox jumps over", "the lazy", "- dog"]);
  });

  it("does not join columns", () => {
    const screen = plain(["name    size    modified  owner   group", "a.txt   12      today"], 40);
    expect(texts(windowAtBottom(screen, 40, 20).rows)).toEqual(["name    size    modified  owner   group", "a.txt   12      today"]);
  });
});

describe("the same screen at the same width", () => {
  it("lays out identically however often it is asked", async () => {
    const { screen, options } = await replay("claude");
    const first = windowAtBottom(screen, 45, 30, options);
    for (let index = 0; index < 5; index += 1) expect(windowAtBottom(screen, 45, 30, options)).toEqual(first);
  });

  it("returns to the same window after resizing away and back", async () => {
    const { screen, options } = await replay("shell");
    const before = windowAtBottom(screen, 50, 20, options);
    windowAtBottom(screen, 33, 11, options);
    windowAtBottom(screen, 120, 36, options);
    expect(windowAtBottom(screen, 50, 20, options)).toEqual(before);
  });

  it("shows the same rows from an anchor as from the bottom it was taken at", async () => {
    const { screen, options } = await replay("shell");
    const bottom = windowAtBottom(screen, 50, 20, options);
    expect(windowFrom(screen, 50, 20, bottom.anchor, options).rows).toEqual(bottom.rows);
  });

  it("scrolls up and back down to where it started", async () => {
    const { screen, options } = await replay("shell");
    const bottom = windowAtBottom(screen, 50, 20, options);
    const up = scrollAnchor(screen, 50, bottom.anchor, -17, options);
    expect(up).not.toEqual(bottom.anchor);
    const back = scrollAnchor(screen, 50, up, 17, options);
    expect(windowFrom(screen, 50, 20, back, options).rows).toEqual(bottom.rows);
  });

  it("stops at the top of the document", async () => {
    const { screen, options } = await replay("shell");
    const bottom = windowAtBottom(screen, 50, 20, options);
    expect(scrollAnchor(screen, 50, bottom.anchor, -100_000, options)).toEqual({ y: 0, offset: 0 });
  });
});
