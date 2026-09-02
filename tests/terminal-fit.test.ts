import { describe, expect, it } from "vitest";
import {
  fittedTerminalFontSize,
} from "../web/terminal-fit";
import { DESKTOP_TERMINAL_GRID, MOBILE_TERMINAL_GRID, terminalGridForDevices } from "../shared/terminal-grid";

describe("viewer-local terminal fitting", () => {
  it("uses compatibility sizing only while a phone is connected", () => {
    expect(terminalGridForDevices([])).toEqual(DESKTOP_TERMINAL_GRID);
    expect(terminalGridForDevices(["desktop", "tablet"])).toEqual(DESKTOP_TERMINAL_GRID);
    expect(terminalGridForDevices(["desktop", "mobile"])).toEqual(MOBILE_TERMINAL_GRID);
  });

  it("fits each canonical grid to its viewer", () => {
    const phone = fittedTerminalFontSize(13, 46, 50, 100, 80, 24);
    const desktop = fittedTerminalFontSize(14, 170, 52, 100, 120, 36);

    expect(phone).toBeGreaterThanOrEqual(7);
    expect(phone).toBeLessThan(10);
    expect(desktop).toBeGreaterThan(16);
    expect(desktop).toBeLessThanOrEqual(24);
  });

  it("applies personal zoom without changing terminal dimensions", () => {
    const normal = fittedTerminalFontSize(13, 80, 24, 100, 80, 24);
    expect(fittedTerminalFontSize(13, 80, 24, 50, 80, 24)).toBeLessThan(normal);
    expect(fittedTerminalFontSize(13, 80, 24, 150, 80, 24)).toBeGreaterThan(normal);
  });
});
