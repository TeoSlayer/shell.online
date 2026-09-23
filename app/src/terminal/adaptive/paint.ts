/**
 * Draws laid-out rows into the terminal the viewer sees.
 *
 * The visible terminal is a canvas: it has no scrollback of its own and is
 * never written process output. Each frame it is told what every row shows,
 * as cursor-addressed text, and only rows that changed since the last frame
 * are sent to it. A frame that changes nothing writes nothing.
 */

import type { LaidRow } from "./layout";

export interface PaintTarget {
  write(data: string): void;
}

export interface CursorPaint {
  row: number;
  column: number;
  visible: boolean;
}

/** One row as the escape sequences that draw it from its first column. */
export function rowSequence(row: LaidRow, index: number, columns: number): string {
  let out = `\x1b[${index + 1};1H\x1b[0m`;
  let style = "";
  let used = 0;
  for (const cell of row.cells) {
    if (used + cell.width > columns) break;
    if (cell.style !== style) {
      out += cell.style ? `\x1b[0;${cell.style}m` : "\x1b[0m";
      style = cell.style;
    }
    out += cell.chars || " ";
    used += cell.width;
  }
  if (style) out += "\x1b[0m";
  /* Erasing from a full row would take its last cell with it. */
  if (used < columns) out += "\x1b[K";
  return out;
}

export class Painter {
  private painted: string[] = [];
  private cursor = "";
  private columns = 0;
  /*
   * Whether the next frame starts from a cleared screen. Resizing the canvas
   * makes xterm reflow whatever it holds, and rows of an earlier size can
   * survive that where a row of this frame is blank; clearing first means a
   * frame never depends on what the canvas held before it.
   */
  private clear = true;

  constructor(private readonly target: PaintTarget) {}

  /** Forget what is on screen, so the next frame draws every row. */
  invalidate(): void {
    this.painted = [];
    this.cursor = "";
    this.clear = true;
  }

  paint(rows: readonly LaidRow[], height: number, columns: number, cursor: CursorPaint | null): void {
    if (columns !== this.columns) {
      this.columns = columns;
      this.invalidate();
    }
    let out = this.clear ? "\x1b[0m\x1b[H\x1b[2J" : "";
    this.clear = false;
    for (let index = 0; index < height; index += 1) {
      const sequence = rowSequence(rows[index] ?? { cells: [] }, index, columns);
      if (this.painted[index] === sequence) continue;
      this.painted[index] = sequence;
      out += sequence;
    }
    this.painted.length = height;
    const place = cursor && cursor.visible
      ? `\x1b[${cursor.row + 1};${Math.min(columns, cursor.column + 1)}H\x1b[?25h`
      : "\x1b[?25l";
    /* The cursor is placed after any row is drawn, because drawing moves it. */
    if (out !== "" || place !== this.cursor) {
      out += place;
      this.cursor = place;
    }
    if (out !== "") this.target.write(out);
  }
}
