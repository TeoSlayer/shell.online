import { describe, expect, it } from "vitest";
import { terminalAutoFitEnabled } from "./auto-fit";

describe("automatic terminal fitting switches", () => {
  it("defaults on for existing sessions", () => {
    expect(terminalAutoFitEnabled("", "")).toBe(true);
  });

  it("lets one page opt out without changing the deployment", () => {
    expect(terminalAutoFitEnabled("?terminalAutoFit=0", "1")).toBe(false);
    expect(terminalAutoFitEnabled("?terminalAutoFit=1", "1")).toBe(true);
  });

  it("does not let a URL override a deployment rollback", () => {
    for (const flag of ["0", "false"]) {
      expect(terminalAutoFitEnabled("?terminalAutoFit=1", flag)).toBe(false);
    }
  });
});
