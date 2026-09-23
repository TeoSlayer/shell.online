import { describe, expect, it } from "vitest";
import headless from "@xterm/headless";
import { capture } from "./fixtures/captures";
import { windowAtBottom, type LaidRow } from "./layout";
import { Painter } from "./paint";
import { BufferScreen, type BufferLike } from "./source";

async function written(term: headless.Terminal, data: string | Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
}

function canvasText(term: headless.Terminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y += 1) rows.push((buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "").replace(/\s+$/u, ""));
  return rows;
}

const text = (row: LaidRow) => row.cells.map((cell) => cell.chars).join("").replace(/\s+$/u, "");

async function laidOut(cols: number, rows: number) {
  const copy = new headless.Terminal({ cols: 120, rows: 36, scrollback: 5000, allowProposedApi: true });
  await written(copy, capture("claude"));
  const buffer = copy.buffer.active as unknown as BufferLike;
  const screen = new BufferScreen(buffer, 120);
  return windowAtBottom(screen, cols, rows, {
    cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY },
    collapseBlankRuns: true,
    top: buffer.baseY,
  }).rows;
}

describe("painting a window into the canvas", () => {
  it("draws exactly the laid-out rows, with the cursor where the layout put it", async () => {
    const rows = await laidOut(45, 30);
    const canvas = new headless.Terminal({ cols: 45, rows: 30, scrollback: 0, allowProposedApi: true });
    const out: string[] = [];
    new Painter({ write: (data) => out.push(data) }).paint(rows, 30, 45, { row: 26, column: 2, visible: true });
    await written(canvas, out.join(""));
    expect(canvasText(canvas)).toEqual(Array.from({ length: 30 }, (_, index) => (rows[index] ? text(rows[index]) : "")));
    expect(canvas.buffer.active.cursorY).toBe(26);
    expect(canvas.buffer.active.cursorX).toBe(2);
    /* Nothing was pushed into the canvas's scrollback: every row was addressed. */
    expect(canvas.buffer.active.baseY).toBe(0);
  });

  it("keeps the program's colors", async () => {
    const canvas = new headless.Terminal({ cols: 20, rows: 2, scrollback: 0, allowProposedApi: true });
    const out: string[] = [];
    const red = { chars: "E", width: 1, style: "1;41;97", ink: true };
    new Painter({ write: (data) => out.push(data) }).paint([{ cells: [red] }], 2, 20, null);
    await written(canvas, out.join(""));
    const cell = canvas.buffer.active.getLine(0)!.getCell(0)!;
    expect(cell.isBold()).toBeTruthy();
    expect(cell.getBgColor()).toBe(1);
    expect(cell.getFgColor()).toBe(15);
  });

  it("writes nothing when the frame has not changed", async () => {
    const rows = await laidOut(45, 30);
    const out: string[] = [];
    const painter = new Painter({ write: (data) => out.push(data) });
    painter.paint(rows, 30, 45, { row: 26, column: 2, visible: true });
    painter.paint(rows, 30, 45, { row: 26, column: 2, visible: true });
    painter.paint(rows, 30, 45, { row: 26, column: 2, visible: true });
    expect(out).toHaveLength(1);
  });

  it("sends only the rows that changed", async () => {
    const rows = await laidOut(45, 30);
    const out: string[] = [];
    const painter = new Painter({ write: (data) => out.push(data) });
    painter.paint(rows, 30, 45, null);
    const changed = rows.slice();
    changed[3] = { cells: [{ chars: "x", width: 1, style: "", ink: true }] };
    painter.paint(changed, 30, 45, null);
    expect(out).toHaveLength(2);
    expect(out[1].match(/\x1b\[\d+;1H/gu)).toEqual(["\x1b[4;1H"]);
  });

  /* Seen in a browser: a row that was blank in the new frame kept text from before a resize. */
  it("leaves nothing of an earlier size behind after the canvas is resized", async () => {
    const canvas = new headless.Terminal({ cols: 20, rows: 4, scrollback: 0, allowProposedApi: true });
    const painter = new Painter({ write: (data) => canvas.write(data) });
    const word = (text: string) => ({ cells: Array.from(text, (chars) => ({ chars, width: 1, style: "", ink: true })) });
    painter.paint([word("aaaa"), word("bbbb"), word("cccc"), word("dddd")], 4, 20, null);
    await written(canvas, "");
    canvas.resize(8, 4);
    painter.invalidate();
    painter.paint([word("x")], 4, 8, null);
    canvas.resize(20, 4);
    painter.invalidate();
    painter.paint([word("x")], 4, 20, null);
    await written(canvas, "");
    expect(canvasText(canvas)).toEqual(["x", "", "", ""]);
  });

  it("repaints everything after the canvas changes width", async () => {
    const out: string[] = [];
    const painter = new Painter({ write: (data) => out.push(data) });
    const rows = [{ cells: [{ chars: "a", width: 1, style: "", ink: true }] }];
    painter.paint(rows, 3, 20, null);
    painter.paint(rows, 3, 30, null);
    expect(out).toHaveLength(2);
    expect(out[1].match(/\x1b\[\d+;1H/gu)).toHaveLength(3);
  });
});
