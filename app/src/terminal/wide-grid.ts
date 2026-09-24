import { WIDE_DESKTOP_TERMINAL_GRID } from "./terminal-grid";

/**
 * Whether this window can actually draw the wider session grid.
 *
 * The grid is the session's: the pty opens at it and every viewer draws it,
 * so the widest grid a session may use is the one its *smallest* viewer can
 * render. A viewer that cannot render it does not get a smaller picture, it
 * gets an unreadable one -- 160 columns in a 385px pane is 2.4 pixels a
 * character, which is not small text but no text: the glyphs stop landing on
 * pixels at all, and the borders of a full-screen program disappear.
 *
 * So a viewer says whether it can, and the relay only picks the wide grid
 * when every viewer watching has said so. A viewer that says nothing -- an
 * older app, another client, a test harness -- is taken at its word and the
 * session stays at the size it has always used.
 */

/** A character's advance as a fraction of its size, for the monospace faces this ships. */
const ADVANCE = 0.6;

/** The leading a terminal is drawn with; see terminal-fit.ts. */
const LINE_HEIGHT = 1.2;

/**
 * The smallest type this is worth doing at.
 *
 * Not the smallest that renders. Below about this the gain -- more of the
 * session at once -- is paid for with text nobody reads, and the point of the
 * wider grid is to see more of the work, not to fit more of it off the edge
 * of legibility.
 */
const LEGIBLE_FONT_PX = 9;

/**
 * How much of the window the pane gets, once the rail and the tab line are
 * out of it. Only used when the pane has not been measured yet.
 */
const CHROME_WIDTH = 300;
const CHROME_HEIGHT = 180;

/**
 * `width` and `height` are the *pane's*, not the window's.
 *
 * The pane is what draws the grid, and the two are not the same number: the
 * live canary runs the real pane at 385x240 inside a full-size browser
 * window, and a window is also split, tabbed and shared. Measured from the
 * window, that pane claimed it could draw 160 columns at 2.4 pixels each.
 */
export function canDrawWideGrid(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const byWidth = width / WIDE_DESKTOP_TERMINAL_GRID.cols / ADVANCE;
  const byHeight = height / WIDE_DESKTOP_TERMINAL_GRID.rows / LINE_HEIGHT;
  return Math.min(byWidth, byHeight) >= LEGIBLE_FONT_PX;
}

/**
 * What this viewer tells the relay about itself, or nothing.
 *
 * The pane's own box where there is one. A pane that has not been laid out
 * yet is judged by the window it is in, less what the rail and the tab line
 * take, which is the best guess available before the first layout.
 */
export function layoutParameter(pane: { width: number; height: number } | null, window: { width: number; height: number }): string {
  const box = pane && pane.width > 0 && pane.height > 0
    ? pane
    : { width: window.width - CHROME_WIDTH, height: window.height - CHROME_HEIGHT };
  return canDrawWideGrid(box.width, box.height) ? "?layout=wide" : "";
}
