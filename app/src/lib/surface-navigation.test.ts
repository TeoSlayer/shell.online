import { describe, expect, it } from "vitest";
import { shouldOpenSurface } from "./surface-navigation";

function target(insideControl: boolean): EventTarget {
  return { closest: () => (insideControl ? {} : null) } as unknown as EventTarget;
}

describe("session surface navigation", () => {
  it("opens when an inert part of the row or card is clicked", () => {
    expect(shouldOpenSurface(target(false))).toBe(true);
  });

  it("does not open when a row button or picker descendant is clicked", () => {
    expect(shouldOpenSurface(target(true))).toBe(false);
  });

  it("honours controls that already consumed the click", () => {
    expect(shouldOpenSurface(target(false), true)).toBe(false);
  });
});
