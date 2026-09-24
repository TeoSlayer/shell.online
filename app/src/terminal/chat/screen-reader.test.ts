import { describe, expect, it } from "vitest";
import {
  ScreenReader,
  paletteFromTheme,
  xterm256,
  type ReaderBuffer,
  type ReaderCell,
  type ReaderLine,
  type ReaderMarker,
  type ReaderTerminal,
} from "./screen-reader";

/*
 * A terminal grid, written out as the rows a process left on it.
 *
 * A row is text, optionally prefixed with ">" to say it continues the row
 * above it, which is how an emulator records a line too long for the width.
 * Cells carry an optional colour, given as a palette index in braces.
 */
const COLS = 40;

interface FakeMarker extends ReaderMarker {
  line: number;
  isDisposed: boolean;
}

class Grid implements ReaderTerminal {
  readonly rows: number;
  private lines: { text: string; wrapped: boolean; fg?: number }[];
  private cursor: number;
  private base = 0;
  private kind: "normal" | "alternate" = "normal";
  private markers: FakeMarker[] = [];
  /** Rows that have fallen out of scrollback, so markers can be invalidated. */
  private dropped = 0;

  constructor(rows = 6) {
    this.rows = rows;
    this.lines = [];
    this.cursor = 0;
  }

  /** Appends rows and leaves the cursor on the last one, as a process does. */
  print(...rows: string[]): this {
    for (const row of rows) {
      const wrapped = row.startsWith(">");
      const body = wrapped ? row.slice(1) : row;
      const colored = /^\{(\d+)\}/u.exec(body);
      this.lines.push({
        text: colored ? body.slice(colored[0].length) : body,
        wrapped,
        fg: colored ? Number(colored[1]) : undefined,
      });
    }
    this.cursor = this.lines.length - 1;
    return this;
  }

  /** Moves the cursor onto a row that is still being written. */
  cursorOn(index: number): this {
    this.cursor = index;
    return this;
  }

  alternate(): this {
    this.kind = "alternate";
    return this;
  }

  /** Drops rows off the top, as a full scrollback does. */
  trim(count: number): this {
    this.lines.splice(0, count);
    this.cursor -= count;
    this.dropped += count;
    for (const marker of this.markers) {
      marker.line -= count;
      if (marker.line < 0) {
        marker.line = -1;
        marker.isDisposed = true;
      }
    }
    return this;
  }

  get buffer(): { active: ReaderBuffer } {
    const lines = this.lines;
    return {
      active: {
        type: this.kind,
        baseY: this.base,
        cursorY: this.cursor,
        length: lines.length,
        getLine: (y: number): ReaderLine | undefined => {
          const line = lines[y];
          if (!line) return undefined;
          return {
            isWrapped: line.wrapped,
            length: lines[y + 1]?.wrapped ? line.text.length : COLS,
            /*
             * A row that is continued by the next one is a row the process
             * filled to the width, so it has no padding to report. The rest
             * are padded, exactly as an emulator reports them.
             */
            translateToString: () => (lines[y + 1]?.wrapped ? line.text : line.text.padEnd(COLS, " ")),
            getCell: (x: number, cell?: ReaderCell) => {
              const character = line.text[x] ?? " ";
              return fillCell(cell, character, x < line.text.length ? line.fg : undefined);
            },
          };
        },
        getNullCell: () => fillCell(undefined, " ", undefined),
      },
    };
  }

  registerMarker(offset = 0): ReaderMarker {
    const marker: FakeMarker = {
      line: this.base + this.cursor + offset,
      isDisposed: false,
      dispose() {
        this.isDisposed = true;
      },
    };
    this.markers.push(marker);
    return marker;
  }
}

function fillCell(cell: ReaderCell | undefined, character: string, fg: number | undefined): ReaderCell {
  const made = (cell ?? {}) as Record<string, unknown>;
  made.getChars = () => character;
  made.getWidth = () => 1;
  made.isFgDefault = () => fg === undefined;
  made.isFgPalette = () => fg !== undefined;
  made.isFgRGB = () => false;
  made.getFgColor = () => fg ?? -1;
  made.isBgDefault = () => true;
  made.isBgPalette = () => false;
  made.isBgRGB = () => false;
  made.getBgColor = () => -1;
  made.isBold = () => 0;
  made.isDim = () => 0;
  made.isItalic = () => 0;
  made.isUnderline = () => 0;
  made.isInverse = () => 0;
  made.isInvisible = () => 0;
  return made as unknown as ReaderCell;
}

const read = (reader: ScreenReader, grid: Grid) => reader.read(grid).lines.map((line) => line.text);

describe("which rows are finished", () => {
  it("releases every row the cursor has moved past", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("first", "second", "third");

    expect(read(reader, grid)).toEqual(["first", "second"]);
  });

  it("never releases the row the cursor is on, which is where a shell keeps its prompt", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("alex@mac ~ % ls", "a.txt", "alex@mac ~ % ");

    expect(read(reader, grid)).toEqual(["alex@mac ~ % ls", "a.txt"]);
  });

  it("releases nothing twice", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("first", "second");
    expect(read(reader, grid)).toEqual(["first"]);

    grid.print("third");
    expect(read(reader, grid)).toEqual(["second"]);
  });

  it("releases nothing at all while a full-screen program holds the screen", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("drawing", "a screen", "now").alternate();

    expect(read(reader, grid)).toEqual([]);
  });
});

describe("a line longer than the terminal is wide", () => {
  it("is put back together rather than cut at the width", () => {
    const reader = new ScreenReader();
    /* A real wrap happens at the width, mid-word and with no space at the join. */
    const grid = new Grid().print("error: could not open the configura", ">tion file", "next");

    expect(read(reader, grid)).toEqual(["error: could not open the configuration file"]);
  });

  it("is held back while it is still being written", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("keeping", "a long line that runs on and", ">still going").cursorOn(2);

    expect(read(reader, grid)).toEqual(["keeping"]);
  });
});

describe("output that scrolled past", () => {
  it("resumes where it was, however far the buffer has moved underneath it", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("one", "two", "three");
    expect(read(reader, grid)).toEqual(["one", "two"]);

    grid.print("four", "five").trim(2);
    expect(read(reader, grid)).toEqual(["three", "four"]);
  });

  it("says so when rows were dropped before they could be kept", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("one", "two", "three");
    read(reader, grid);

    grid.print("four", "five", "six", "seven").trim(6);
    const result = reader.read(grid);
    expect(result.gap).toBe(true);
  });
});

describe("what output looked like", () => {
  it("keeps the colour a process chose, so an error is still red in the thread", () => {
    const reader = new ScreenReader(paletteFromTheme({ red: "#b3261e" }));
    const grid = new Grid().print("{1}fatal: not a repository", "done");

    const [line] = reader.read(grid).lines;
    expect(line.text).toBe("fatal: not a repository");
    expect(line.runs).toHaveLength(1);
    expect(line.runs[0].fg).toBe("#b3261e");
  });

  it("leaves unstyled text with no colour of its own, so the page's own ink shows", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("plain", "done");

    expect(reader.read(grid).lines[0].runs[0].fg).toBeUndefined();
  });

  it("falls back to the terminal's own palette for a colour the theme does not name", () => {
    expect(xterm256(0)).toBe("#000000");
    expect(xterm256(196)).toBe("#ff0000");
    expect(xterm256(244)).toBe("#808080");
  });
});

describe("the still image of a full-screen program", () => {
  it("is the screen it was showing, without the blank rows below it", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("NORMAL  notes.md", "the first line", "", "").alternate();

    expect(reader.snapshot(grid).map((line) => line.text)).toEqual(["NORMAL  notes.md", "the first line"]);
  });
});

describe("a reset", () => {
  it("reads the buffer from the top again", () => {
    const reader = new ScreenReader();
    const grid = new Grid().print("one", "two");
    read(reader, grid);

    reader.rewind();
    expect(read(reader, grid)).toEqual(["one"]);
  });
});

describe('cursor-only repaints', () => {
  it('does not rewind released output when the cursor visits an earlier row', () => {
    const reader = new ScreenReader();
    const grid = new Grid().print('one', 'two', 'three', 'prompt');
    expect(read(reader, grid)).toEqual(['one', 'two', 'three']);
    grid.cursorOn(0);
    expect(read(reader, grid)).toEqual([]);
    grid.cursorOn(3);
    expect(read(reader, grid)).toEqual([]);
  });
});
