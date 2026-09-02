import { describe, expect, it } from "vitest";
import {
  fittedTerminalFontSize,
  SHARED_TERMINAL_COLS,
  SHARED_TERMINAL_ROWS,
} from "../web/terminal-fit";

describe("viewer-local terminal fitting", () => {
  it("keeps one standard shared grid", () => {
    expect([SHARED_TERMINAL_COLS, SHARED_TERMINAL_ROWS]).toEqual([80, 24]);
  });

  it("fits the same grid independently on phone and desktop", () => {
    const phone = fittedTerminalFontSize(13, 46, 50);
    const desktop = fittedTerminalFontSize(14, 170, 52);

    expect(phone).toBeGreaterThanOrEqual(7);
    expect(phone).toBeLessThan(10);
    expect(desktop).toBeGreaterThan(24);
    expect(desktop).toBeLessThanOrEqual(32);
  });

  it("applies personal zoom without changing terminal dimensions", () => {
    const normal = fittedTerminalFontSize(13, 80, 24, 100);
    expect(fittedTerminalFontSize(13, 80, 24, 50)).toBeLessThan(normal);
    expect(fittedTerminalFontSize(13, 80, 24, 150)).toBeGreaterThan(normal);
  });
});
