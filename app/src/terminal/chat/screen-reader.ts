/**
 * Reads finished lines out of a terminal emulator.
 *
 * The chat view needs settled text, and a terminal grid is the opposite of
 * that: a process overwrites rows, redraws a progress bar in place, wraps a
 * long line without a newline, and leaves its prompt on the cursor row. None
 * of that can be recovered by stripping escape codes out of the byte stream,
 * which is why this reads an emulator's buffer instead of the wire.
 *
 * Two rules make a row safe to release.
 *
 * The cursor row is never released. Whatever is on it is still being written,
 * and a shell's prompt lives there between commands, so the prompt falls out
 * of the conversation for free.
 *
 * A wrapped line is released whole. The emulator marks a row that continues
 * the row above it, so the pieces are joined back into the line the process
 * meant to print rather than being cut at the terminal's width.
 *
 * Where reading resumes is tracked with an emulator marker rather than a row
 * number. Row numbers shift when scrollback fills and the oldest rows are
 * dropped; a marker is moved by the emulator and tells us when the row it held
 * was dropped, which is the one case where output really was lost.
 */

import type { StyleRun, TranscriptLine } from "./transcript";

/* The slice of xterm's cell interface this needs, so tests can supply a fake. */
export interface ReaderCell {
  getChars(): string;
  getWidth(): number;
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  getFgColor(): number;
  isBgDefault(): boolean;
  isBgPalette(): boolean;
  isBgRGB(): boolean;
  getBgColor(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
  isInvisible(): number;
}

export interface ReaderLine {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell(x: number, cell?: ReaderCell): ReaderCell | undefined;
}

export interface ReaderBuffer {
  readonly type: "normal" | "alternate";
  readonly baseY: number;
  readonly cursorY: number;
  readonly length: number;
  getLine(y: number): ReaderLine | undefined;
  getNullCell(): ReaderCell;
}

export interface ReaderMarker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

export interface ReaderTerminal {
  readonly rows: number;
  readonly buffer: { readonly active: ReaderBuffer };
  registerMarker(cursorYOffset?: number): ReaderMarker | undefined;
}

export interface ReadResult {
  lines: TranscriptLine[];
  /**
   * True when scrollback dropped rows this reader had not released yet. The
   * session is intact; the conversation has a hole in it, and saying so is
   * better than silently skipping output.
   */
  gap: boolean;
}

/** The sixteen named entries of xterm's palette, in their ANSI order. */
const NAMED = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

export type Palette = Record<string, string | undefined>;

export class ScreenReader {
  /** Where reading resumes. Null means "from the top of the buffer". */
  private mark: ReaderMarker | null = null;
  /** Rows released so far, only to tell a first read from a later one. */
  private started = false;
  private palette: Palette = {};

  constructor(palette: Palette = {}) {
    this.palette = palette;
  }

  /** The palette follows the app theme, and a session can outlive a change of it. */
  setPalette(palette: Palette): void {
    this.palette = palette;
  }

  /** Forgets where it was reading. Used when the emulator is reset. */
  rewind(): void {
    this.mark?.dispose();
    this.mark = null;
    this.started = false;
  }

  /**
   * Releases every line the process has finished writing since the last read.
   *
   * Nothing is released while a full-screen program holds the alternate
   * screen: that grid is a picture, not a transcript, and the normal buffer
   * under it is frozen until the program exits.
   */
  read(terminal: ReaderTerminal): ReadResult {
    const buffer = terminal.buffer.active;
    if (buffer.type === "alternate") return { lines: [], gap: false };

    const cursor = buffer.baseY + buffer.cursorY;
    /*
     * Back up over a line the cursor is in the middle of. A row that continues
     * the one above it belongs to a line that is still being written, and
     * releasing its first half now would print the line twice, in pieces.
     */
    let limit = Math.min(cursor, buffer.length);
    while (limit > 0 && buffer.getLine(limit)?.isWrapped) limit -= 1;

    let gap = false;
    let start: number;
    if (!this.started) {
      start = 0;
      this.started = true;
    } else if (this.mark && !this.mark.isDisposed && this.mark.line >= 0) {
      start = this.mark.line;
    } else {
      /* The row we were holding fell out of scrollback with output on it. */
      start = Math.max(0, buffer.length - terminal.rows);
      gap = true;
    }

    const lines: TranscriptLine[] = [];
    for (let y = start; y < limit; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      /* Gather the whole logical line: this row plus the rows that continue it. */
      const rows: ReaderLine[] = [line];
      while (y + 1 < limit) {
        const next = buffer.getLine(y + 1);
        if (!next?.isWrapped) break;
        rows.push(next);
        y += 1;
      }
      lines.push(this.compose(rows, buffer));
    }

    this.remark(terminal, limit);
    return { lines, gap };
  }

  /**
   * Everything the alternate screen is showing, for the still image kept after
   * a full-screen program exits.
   */
  snapshot(terminal: ReaderTerminal): TranscriptLine[] {
    const buffer = terminal.buffer.active;
    const lines: TranscriptLine[] = [];
    const top = buffer.baseY;
    for (let y = top; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      if (line) lines.push(this.compose([line], buffer));
    }
    /* A screen is mostly empty at the bottom; the blank rows are not content. */
    while (lines.length > 0 && lines[lines.length - 1].text.trim() === "") lines.pop();
    return lines;
  }

  dispose(): void {
    this.mark?.dispose();
    this.mark = null;
  }

  /**
   * Moves the mark to the first row not yet released, so the next read resumes
   * there however much scrollback has moved underneath it.
   */
  private remark(terminal: ReaderTerminal, limit: number): void {
    const buffer = terminal.buffer.active;
    const cursor = buffer.baseY + buffer.cursorY;
    this.mark?.dispose();
    this.mark = terminal.registerMarker(limit - cursor) ?? null;
  }

  /**
   * Joins the rows of one logical line and splits it where its appearance
   * changes, so a red error stays red in the conversation.
   */
  private compose(rows: readonly ReaderLine[], buffer: ReaderBuffer): TranscriptLine {
    const text = rows.map((row) => row.translateToString(false)).join("").replace(/\s+$/u, "");
    if (text === "") return { text: "", runs: [] };

    const runs: StyleRun[] = [];
    const cell = buffer.getNullCell();
    let current: StyleRun | null = null;
    let taken = 0;

    for (const row of rows) {
      for (let x = 0; x < row.length && taken < text.length; x += 1) {
        if (!row.getCell(x, cell)) continue;
        /*
         * A wide character occupies two cells and reports its glyph on the
         * first; the second is empty and must not become a space.
         */
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        const style = this.styleOf(cell);
        if (current && sameStyle(current, style)) {
          current.text += chars;
        } else {
          current = { ...style, text: chars };
          runs.push(current);
        }
        taken += chars.length;
      }
    }

    /* Trailing blanks were trimmed out of the text, so trim the runs to match. */
    let total = 0;
    const kept: StyleRun[] = [];
    for (const run of runs) {
      if (total >= text.length) break;
      const room = text.length - total;
      kept.push(run.text.length > room ? { ...run, text: run.text.slice(0, room) } : run);
      total += run.text.length;
    }
    return { text, runs: kept };
  }

  private styleOf(cell: ReaderCell): Omit<StyleRun, "text"> {
    let fg = this.colorOf(cell.isFgDefault(), cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor());
    let bg = this.colorOf(cell.isBgDefault(), cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor());
    if (cell.isInverse()) {
      const swap = fg ?? this.palette.background;
      fg = bg ?? this.palette.foreground;
      bg = swap;
    }
    if (cell.isInvisible()) fg = bg;
    return {
      fg,
      bg,
      bold: cell.isBold() !== 0 || undefined,
      dim: cell.isDim() !== 0 || undefined,
      italic: cell.isItalic() !== 0 || undefined,
      underline: cell.isUnderline() !== 0 || undefined,
    };
  }

  /**
   * Resolves one of the terminal's three color modes to a CSS color.
   *
   * Default means "whatever the page uses", which is left undefined so the
   * bubble's own color shows through and light and dark both read correctly.
   */
  private colorOf(isDefault: boolean, isPalette: boolean, isRGB: boolean, value: number): string | undefined {
    if (isDefault) return undefined;
    if (isRGB) return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
    if (!isPalette) return undefined;
    if (value < 16) return this.palette[NAMED[value]] ?? xterm256(value);
    return xterm256(value);
  }
}

function sameStyle(a: StyleRun, b: Omit<StyleRun, "text">): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

/**
 * xterm's built-in 256-color palette, used for any index the app theme does
 * not name: the sixteen basics, a 6x6x6 cube, and a greyscale ramp.
 */
const BASIC_16 = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

const CUBE = [0, 95, 135, 175, 215, 255];

export function xterm256(index: number): string {
  if (index < 16) return BASIC_16[index];
  if (index < 232) {
    const n = index - 16;
    return rgb(CUBE[Math.floor(n / 36) % 6], CUBE[Math.floor(n / 6) % 6], CUBE[n % 6]);
  }
  const grey = 8 + (index - 232) * 10;
  return rgb(grey, grey, grey);
}

function rgb(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}

/** Pulls the palette the chat needs out of the theme the pane already supplies. */
export function paletteFromTheme(theme: Record<string, string> | undefined): Palette {
  if (!theme) return {};
  const palette: Palette = { foreground: theme.foreground, background: theme.background };
  for (const name of NAMED) palette[name] = theme[name];
  return palette;
}
