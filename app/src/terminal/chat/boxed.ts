import type { TranscriptLine } from "./transcript";

/**
 * A table a terminal drew, read back as a table.
 *
 * A program asked to print a Markdown table prints box characters: the pipes
 * and dashes are gone by the time it reaches a screen and what arrives is
 * `┌───┬───┐` with rows under it. Kept as text, that only looks like a table
 * in a font whose box glyphs tile the cell exactly -- which is why terminals
 * draw those glyphs themselves rather than trusting the font. In a browser
 * they do not tile: `│` is drawn shorter than its cell, so the verticals
 * never meet the horizontals and the table reads as a field of dashes.
 *
 * So it is not kept as text. The rows are read, the cells are split out, and
 * a real table is built from them -- which tiles by construction, wraps on a
 * phone, and can be read aloud. The text is never trusted to draw itself.
 */

/** The characters a box is drawn with. */
const BOX = /^[\s─-╿]+$/u;

/** A row with content in it: at least two verticals and something between. */
const CONTENT = /^\s*[│┃].*[│┃]\s*$/u;

/** A row that is only rule: the top, the bottom, and the line under a heading. */
const RULE = /^\s*[┌-╿─━][\s─-╿]*$/u;

export interface BoxTable {
  /** How many lines of the input this table occupies. */
  length: number;
  /** The heading cells, when a rule separates the first row from the rest. */
  head: string[] | null;
  rows: string[][];
}

/** Splits a drawn row into its cells. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^[│┃]/u, "")
    .replace(/[│┃]$/u, "")
    .split(/[│┃]/u)
    .map((cell) => cell.trim());
}

/**
 * Reads a table starting at `from`, or null.
 *
 * A table is a rule, some content rows, and a rule -- with an optional rule
 * between the first row and the rest, which is what makes the first row a
 * heading. Anything less is not a table and is left as the text it is.
 */
export function boxTableAt(lines: readonly string[], from: number): BoxTable | null {
  if (!RULE.test(lines[from] ?? "") || !BOX.test(lines[from] ?? "")) return null;
  let at = from + 1;
  const rows: string[][] = [];
  let head: string[] | null = null;
  while (at < lines.length) {
    const line = lines[at];
    if (CONTENT.test(line)) {
      rows.push(cells(line));
      at += 1;
      continue;
    }
    if (BOX.test(line) && RULE.test(line)) {
      /* A rule straight after the first row makes that row the heading. */
      if (rows.length === 1 && head === null && at + 1 < lines.length && CONTENT.test(lines[at + 1])) {
        head = rows.pop() ?? null;
        at += 1;
        continue;
      }
      at += 1;
      break;
    }
    break;
  }
  if (rows.length === 0 && head === null) return null;
  return { length: at - from, head, rows };
}

/** Whether these lines hold a table worth building rather than printing. */
export function hasBoxTable(lines: readonly TranscriptLine[]): boolean {
  for (let at = 0; at < lines.length; at += 1) {
    if (boxTableAt(lines.map((line) => line.text), at)) return true;
  }
  return false;
}

export function buildBoxTable(table: BoxTable): HTMLElement {
  const element = document.createElement("table");
  element.className = "md-table";
  const width = Math.max(table.head?.length ?? 0, ...table.rows.map((row) => row.length));
  if (table.head) {
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (let at = 0; at < width; at += 1) {
      const cell = document.createElement("th");
      cell.textContent = table.head[at] ?? "";
      row.append(cell);
    }
    head.append(row);
    element.append(head);
  }
  const body = document.createElement("tbody");
  for (const cells of table.rows) {
    const row = document.createElement("tr");
    for (let at = 0; at < width; at += 1) {
      const cell = document.createElement("td");
      cell.textContent = cells[at] ?? "";
      row.append(cell);
    }
    body.append(row);
  }
  element.append(body);
  return element;
}
