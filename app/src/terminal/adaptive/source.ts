/**
 * Reads the session's grid out of an emulator, as the rows `layout.ts` lays
 * out and `paint.ts` draws.
 *
 * Typed against the slice of xterm's buffer API it uses, so the browser's
 * emulator and the headless one the tests replay captures through are both
 * accepted.
 */

import type { Cell, SourceRow, SourceScreen } from "./layout";

export interface BufferCellLike {
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
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
}

export interface BufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number, cell?: BufferCellLike): BufferCellLike | undefined;
}

export interface BufferLike {
  readonly type: "normal" | "alternate";
  readonly baseY: number;
  readonly viewportY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
  getNullCell(): BufferCellLike;
}

/** The SGR parameters that reproduce one cell's appearance. */
export function styleOf(cell: BufferCellLike): string {
  const parts: string[] = [];
  if (cell.isBold()) parts.push("1");
  if (cell.isDim()) parts.push("2");
  if (cell.isItalic()) parts.push("3");
  if (cell.isUnderline()) parts.push("4");
  if (cell.isBlink()) parts.push("5");
  if (cell.isInverse()) parts.push("7");
  if (cell.isInvisible()) parts.push("8");
  if (cell.isStrikethrough()) parts.push("9");
  if (cell.isOverline()) parts.push("53");
  if (cell.isFgRGB()) {
    const value = cell.getFgColor();
    parts.push(`38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`);
  } else if (cell.isFgPalette()) {
    const value = cell.getFgColor();
    parts.push(value < 8 ? `${30 + value}` : value < 16 ? `${90 + value - 8}` : `38;5;${value}`);
  }
  if (cell.isBgRGB()) {
    const value = cell.getBgColor();
    parts.push(`48;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`);
  } else if (cell.isBgPalette()) {
    const value = cell.getBgColor();
    parts.push(value < 8 ? `${40 + value}` : value < 16 ? `${100 + value - 8}` : `48;5;${value}`);
  }
  return parts.join(";");
}

/**
 * A view of one buffer as a `SourceScreen`. Rows are read on demand and kept
 * until `invalidate`, because laying out one window asks for the same rows
 * several times.
 */
export class BufferScreen implements SourceScreen {
  private readonly cache = new Map<number, SourceRow>();
  private scratch: BufferCellLike | undefined;

  constructor(
    private buffer: BufferLike,
    public width: number,
  ) {}

  get length(): number {
    return this.buffer.length;
  }

  /** Point at the buffer as it is now. Rows read before this are dropped. */
  reset(buffer: BufferLike, width: number): void {
    this.buffer = buffer;
    this.width = width;
    this.cache.clear();
  }

  row(y: number): SourceRow {
    const cached = this.cache.get(y);
    if (cached) return cached;
    const line = this.buffer.getLine(y);
    const row: SourceRow = line ? this.read(line) : { cells: [], wrapped: false };
    this.cache.set(y, row);
    return row;
  }

  private read(line: BufferLineLike): SourceRow {
    const cells: Cell[] = [];
    this.scratch ??= this.buffer.getNullCell();
    const length = Math.min(line.length, this.width);
    for (let x = 0; x < length; x += 1) {
      const cell = line.getCell(x, this.scratch);
      if (!cell) break;
      const width = cell.getWidth();
      /* The second half of a wide character: its glyph is on the first half. */
      if (width === 0) continue;
      const chars = cell.getChars();
      const style = styleOf(cell);
      const colored = !cell.isBgDefault() || cell.isInverse() !== 0;
      cells.push({
        chars: chars || " ",
        width,
        style,
        ink: (chars !== "" && chars !== " ") || colored,
      });
    }
    return { cells, wrapped: line.isWrapped };
  }
}
