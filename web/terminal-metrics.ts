/**
 * The two browser measurements a viewer needs before it can size a terminal:
 * what one character occupies, and how much room there is to draw in.
 *
 * The emulator measures its own cells from the font's metrics, so a viewer
 * choosing a font size has to ask the same question the same way, or the size
 * it picks is not the size that reaches the screen. That is the advance width
 * of a capital W and the font's bounding box for its height, which is what
 * xterm asks a canvas for; the element fallback below is the one xterm falls
 * back to, for a browser that does not report bounding-box metrics.
 */

import type { TerminalBox, TerminalCell } from "./terminal-fit";

/** What xterm reserves for a scrollbar before it has drawn one. */
const ASSUMED_SCROLLBAR_WIDTH = 14;
/** Enough repeats that a fractional advance width survives being rounded. */
const MEASURE_REPEATS = 32;

/**
 * A cached measurer for one font family. Sizes repeat constantly — every refit
 * asks about the same handful — and measuring is a layout, so it is worth
 * keeping the answers.
 */
export function cellMeasurer(fontFamily: string): (fontSize: number) => TerminalCell {
  const measured = new Map<number, TerminalCell>();
  return (fontSize) => {
    const held = measured.get(fontSize);
    if (held) return held;
    const cell = measureCell(fontFamily, fontSize);
    if (cell.width > 0 && cell.height > 0) measured.set(fontSize, cell);
    return cell;
  };
}

/**
 * The room a terminal has, in CSS pixels.
 *
 * A classic scrollbar takes its width from the columns, an overlay scrollbar
 * takes none, and which one is on this computer is not something to guess at:
 * the viewport reports it. Before the emulator has drawn a viewport, the
 * pessimistic figure keeps the last column off the scrollbar either way.
 */
export function terminalBox(element: HTMLElement): TerminalBox {
  const viewport = element.querySelector<HTMLElement>(".xterm-viewport");
  const scrollbar = viewport
    ? Math.max(0, viewport.offsetWidth - viewport.clientWidth)
    : ASSUMED_SCROLLBAR_WIDTH;
  return {
    width: Math.max(0, element.clientWidth - scrollbar),
    height: Math.max(0, element.clientHeight),
  };
}

let context: CanvasRenderingContext2D | null | undefined;

function measureCell(fontFamily: string, fontSize: number): TerminalCell {
  if (context === undefined) context = document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = `${fontSize}px ${fontFamily}`;
    const metrics = context.measureText("W");
    const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    if (metrics.width > 0 && Number.isFinite(height) && height > 0) {
      return { width: metrics.width, height };
    }
  }
  return measureElement(fontFamily, fontSize);
}

/* A span of Ws, laid out and read back, for browsers without font metrics. */
function measureElement(fontFamily: string, fontSize: number): TerminalCell {
  const span = document.createElement("span");
  span.style.position = "absolute";
  span.style.top = "-9999px";
  span.style.whiteSpace = "pre";
  span.style.fontKerning = "none";
  span.style.fontFamily = fontFamily;
  span.style.fontSize = `${fontSize}px`;
  span.textContent = "W".repeat(MEASURE_REPEATS);
  document.body.appendChild(span);
  const cell = { width: span.offsetWidth / MEASURE_REPEATS, height: span.offsetHeight };
  span.remove();
  return cell;
}
