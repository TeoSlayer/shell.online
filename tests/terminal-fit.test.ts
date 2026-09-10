import { describe, expect, it } from "vitest";
import { fittedTerminal, type TerminalCell } from "../web/terminal-fit";
import {
  DESKTOP_TERMINAL_GRID,
  LEGACY_MOBILE_TERMINAL_GRID,
  MOBILE_TERMINAL_GRID,
  terminalGridForDevices,
} from "../shared/terminal-grid";

/*
 * A monospaced font measured the way the browser measures one: an advance
 * width and a bounding box, both proportional to the size asked for.
 */
const font = (width = 0.6, height = 1.16) =>
  (fontSize: number): TerminalCell => ({ width: fontSize * width, height: fontSize * height });

/** What the emulator will draw at the size the fit chose. */
function drawn(
  cell: TerminalCell,
  lineHeight: number,
  grid: { cols: number; rows: number },
  pixelRatio = 2,
) {
  return {
    width: Math.round(cell.width * grid.cols),
    height: (Math.floor(Math.ceil(cell.height * pixelRatio) * lineHeight) * grid.rows) / pixelRatio,
  };
}

describe("viewer-local terminal fitting", () => {
  it("uses compatibility sizing only while a phone is connected", () => {
    expect(terminalGridForDevices([], true)).toEqual(DESKTOP_TERMINAL_GRID);
    expect(terminalGridForDevices(["desktop", "tablet"], true)).toEqual(DESKTOP_TERMINAL_GRID);
    expect(terminalGridForDevices(["desktop", "mobile"], true)).toEqual(MOBILE_TERMINAL_GRID);
    expect(terminalGridForDevices(["desktop", "portrait"], true)).toEqual(MOBILE_TERMINAL_GRID);
    expect(terminalGridForDevices(["mobile"], false)).toEqual(LEGACY_MOBILE_TERMINAL_GRID);
  });

  it("fills a pane wider than the grid instead of leaving it empty", () => {
    const box = { width: 1069, height: 668 };
    const measure = font();
    const fitted = fittedTerminal(box, DESKTOP_TERMINAL_GRID, measure, { pixelRatio: 2 });
    const size = drawn(measure(fitted.fontSize), fitted.lineHeight, DESKTOP_TERMINAL_GRID);

    /* Both axes used, neither exceeded. */
    expect(size.width).toBeLessThanOrEqual(box.width);
    expect(size.height).toBeLessThanOrEqual(box.height);
    expect(size.width / box.width).toBeGreaterThan(0.97);
    expect(size.height / box.height).toBeGreaterThan(0.97);
  });

  it("never overflows the box it was given", () => {
    for (const width of [320, 480, 720, 1069, 1400, 2189, 3400]) {
      for (const height of [240, 400, 588, 668, 848, 1208]) {
        for (const ratio of [1, 2, 3]) {
          const box = { width, height };
          const measure = font();
          const fitted = fittedTerminal(box, DESKTOP_TERMINAL_GRID, measure, { pixelRatio: ratio });
          const size = drawn(measure(fitted.fontSize), fitted.lineHeight, DESKTOP_TERMINAL_GRID, ratio);
          expect(size.width).toBeLessThanOrEqual(box.width);
          expect(size.height).toBeLessThanOrEqual(box.height);
        }
      }
    }
  });

  it("keeps the leading it was given when the height is not the constraint", () => {
    /* Tall and narrow: the columns run out first, so the rows have room. */
    const fitted = fittedTerminal({ width: 700, height: 1400 }, DESKTOP_TERMINAL_GRID, font(), {
      maxLineHeight: 1.35,
      pixelRatio: 2,
    });
    expect(fitted.lineHeight).toBe(1.35);
  });

  it("tightens the leading rather than shrinking the font", () => {
    const short = fittedTerminal({ width: 1069, height: 588 }, DESKTOP_TERMINAL_GRID, font(), {
      maxLineHeight: 1.35,
      pixelRatio: 2,
    });
    expect(short.lineHeight).toBeLessThan(1.35);
    expect(short.lineHeight).toBeGreaterThanOrEqual(1);
  });

  it("fits each canonical grid to its viewer", () => {
    const phone = fittedTerminal({ width: 380, height: 620 }, MOBILE_TERMINAL_GRID, font(), {
      pixelRatio: 3,
    });
    const desktop = fittedTerminal({ width: 1400, height: 900 }, DESKTOP_TERMINAL_GRID, font(), {
      pixelRatio: 2,
    });

    expect(phone.fontSize).toBeGreaterThanOrEqual(7);
    expect(phone.fontSize).toBeLessThan(10);
    expect(desktop.fontSize).toBeGreaterThan(16);
    expect(desktop.fontSize).toBeLessThanOrEqual(24);
  });

  it("uses most of a portrait pane with the taller mobile grid", () => {
    const box = { width: 380, height: 620 };
    const measure = font();
    const fitted = fittedTerminal(box, MOBILE_TERMINAL_GRID, measure, {
      maxLineHeight: 1.8,
      pixelRatio: 3,
    });
    const size = drawn(measure(fitted.fontSize), fitted.lineHeight, MOBILE_TERMINAL_GRID, 3);

    expect(size.width / box.width).toBeGreaterThan(0.95);
    expect(size.height / box.height).toBeGreaterThan(0.9);
    expect(size.height).toBeLessThanOrEqual(box.height);
  });

  it("applies personal zoom without changing terminal dimensions", () => {
    const box = { width: 1069, height: 668 };
    const normal = fittedTerminal(box, DESKTOP_TERMINAL_GRID, font(), { pixelRatio: 2 });
    const small = fittedTerminal(box, DESKTOP_TERMINAL_GRID, font(), {
      zoomPercent: 50,
      pixelRatio: 2,
    });
    const large = fittedTerminal(box, DESKTOP_TERMINAL_GRID, font(), {
      zoomPercent: 150,
      pixelRatio: 2,
    });

    expect(small.fontSize).toBeLessThan(normal.fontSize);
    expect(large.fontSize).toBeGreaterThan(normal.fontSize);
  });

  it("falls back rather than dividing by a pane that has no size yet", () => {
    const detached = fittedTerminal({ width: 0, height: 0 }, DESKTOP_TERMINAL_GRID, font());
    expect(detached.fontSize).toBeGreaterThan(0);
    expect(detached.lineHeight).toBeGreaterThanOrEqual(1);

    const unmeasurable = fittedTerminal({ width: 800, height: 600 }, DESKTOP_TERMINAL_GRID, () => ({
      width: 0,
      height: 0,
    }));
    expect(unmeasurable.fontSize).toBeGreaterThan(0);
  });
});
