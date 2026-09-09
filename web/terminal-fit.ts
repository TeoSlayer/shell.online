/**
 * Scale the current session-wide terminal grid into an individual viewport.
 *
 * How many columns and rows there are is not a viewer's decision: the relay
 * picks the grid and the CLI opens the PTY at it. What a viewer chooses is how
 * large to draw that grid, and there are two knobs for it rather than one — the
 * font size, and the leading between rows.
 *
 * Two, because a pane is almost never the shape of the grid. Scaling the font
 * alone fits the grid into the pane the way an image fits a frame: as soon as
 * one edge is reached the other stops growing, and a wide pane showing a 120x36
 * session was left with a third of its width empty and its text a third smaller
 * than the room allowed. So the font is taken from the width, where the columns
 * are, and the rows are then spread down the full height with whatever leading
 * that leaves. Neither axis is allowed to overflow: everything a viewer is
 * drawing is inside the box it was given.
 */

export interface TerminalBox {
  width: number;
  height: number;
}

export interface TerminalGridSize {
  cols: number;
  rows: number;
}

/** One character, in CSS pixels, as the emulator itself measures it. */
export interface TerminalCell {
  width: number;
  height: number;
}

export interface FittedTerminal {
  fontSize: number;
  lineHeight: number;
}

export interface TerminalFitOptions {
  /** Personal zoom, as a percentage. Above 100 it may deliberately overflow. */
  zoomPercent?: number;
  /** Cells are rounded to whole device pixels, so the ratio changes the fit. */
  pixelRatio?: number;
  /** The leading to use when the height is not the binding constraint. */
  maxLineHeight?: number;
}

/** Below this a terminal is unreadable, above it the grid is a poster. */
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 32;
/** Quarter-pixel steps: fine enough to fill a pane, coarse enough to settle. */
const FONT_STEP = 0.25;
/** A row is never drawn tighter than the font's own line box. */
const MIN_LINE_HEIGHT = 1;
const DEFAULT_MAX_LINE_HEIGHT = 1.35;
/** Big enough to measure accurately, and only ever used as a ratio. */
const REFERENCE_FONT_SIZE = 16;
/** Used only when there is nothing to measure, e.g. a detached pane. */
const FALLBACK_FONT_SIZE = 14;

/**
 * The largest font, and the leading to go with it, that draws the whole grid
 * inside the box.
 *
 * `measure` reports what one character occupies at a given font size, which is
 * a question only the browser can answer and only for the font in use.
 */
export function fittedTerminal(
  box: TerminalBox,
  grid: TerminalGridSize,
  measure: (fontSize: number) => TerminalCell,
  options: TerminalFitOptions = {},
): FittedTerminal {
  const maxLineHeight = Math.max(
    MIN_LINE_HEIGHT,
    positive(options.maxLineHeight) ? options.maxLineHeight : DEFAULT_MAX_LINE_HEIGHT,
  );
  const pixelRatio = positive(options.pixelRatio) ? options.pixelRatio : 1;
  const zoom = positive(options.zoomPercent) ? options.zoomPercent / 100 : 1;

  if (!positive(box.width) || !positive(box.height)) {
    return { fontSize: FALLBACK_FONT_SIZE, lineHeight: maxLineHeight };
  }
  if (!positive(grid.cols) || !positive(grid.rows)) {
    return { fontSize: FALLBACK_FONT_SIZE, lineHeight: maxLineHeight };
  }

  const reference = measure(REFERENCE_FONT_SIZE);
  if (!positive(reference.width) || !positive(reference.height)) {
    return { fontSize: FALLBACK_FONT_SIZE, lineHeight: maxLineHeight };
  }

  /* Character metrics scale with the font, so one measurement sizes them all. */
  const widthPerPixel = reference.width / REFERENCE_FONT_SIZE;
  const heightPerPixel = reference.height / REFERENCE_FONT_SIZE;
  const fromWidth = box.width / (grid.cols * widthPerPixel);
  const fromHeight = box.height / (grid.rows * heightPerPixel * MIN_LINE_HEIGHT);

  let fontSize = clamp(step(Math.min(fromWidth, fromHeight) * zoom), MIN_FONT_SIZE, MAX_FONT_SIZE);
  let cell = measure(fontSize);

  /*
   * Metrics are not exactly linear — hinting rounds them — so the size derived
   * from the reference can be a step too large. Asking what it really measures
   * costs one measurement per step, and there is rarely more than one. Zoom
   * above 100% is a request for text larger than fits, so it skips this.
   */
  while (zoom <= 1 && fontSize > MIN_FONT_SIZE && overflows(cell, box, grid, pixelRatio)) {
    fontSize = step(fontSize - FONT_STEP);
    cell = measure(fontSize);
  }

  /* Whatever height the rows did not need becomes the space between them. */
  const lineHeight = clamp(
    rowBudget(box.height, grid.rows, pixelRatio) / deviceHeight(cell.height, pixelRatio),
    MIN_LINE_HEIGHT,
    maxLineHeight,
  );

  return { fontSize, lineHeight };
}

/**
 * Whether the grid drawn at this cell size would spill out of the box, judged
 * the way the emulator lays it out: columns rounded to whole CSS pixels, rows
 * to whole device pixels at the tightest leading available.
 */
function overflows(
  cell: TerminalCell,
  box: TerminalBox,
  grid: TerminalGridSize,
  pixelRatio: number,
): boolean {
  if (Math.round(cell.width * grid.cols) > box.width) return true;
  const rows = Math.floor(deviceHeight(cell.height, pixelRatio) * MIN_LINE_HEIGHT) * grid.rows;
  return rows > box.height * pixelRatio;
}

function deviceHeight(height: number, pixelRatio: number): number {
  return Math.ceil(height * pixelRatio);
}

function rowBudget(height: number, rows: number, pixelRatio: number): number {
  return Math.floor((height * pixelRatio) / rows);
}

function step(value: number): number {
  return Math.floor(value / FONT_STEP) * FONT_STEP;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
