import { describe, expect, it } from "vitest";
import { placeSummaryCard } from "./SessionSummaryHover";

const desktop = { width: 1280, height: 800 };

describe("summary card placement", () => {
  it("sits under the anchor, aligned to its left edge", () => {
    expect(placeSummaryCard({ left: 200, top: 100, bottom: 140 }, desktop)).toEqual({ left: 200, width: 360, top: 146 });
  });

  it("flips above the anchor when there is no room below", () => {
    const placed = placeSummaryCard({ left: 200, top: 700, bottom: 740 }, desktop);
    expect(placed.top).toBeUndefined();
    expect(placed.bottom).toBe(800 - 700 + 6);
  });

  it("stays inside the viewport on the right and left", () => {
    expect(placeSummaryCard({ left: 1200, top: 100, bottom: 140 }, desktop).left).toBe(1280 - 16 - 360);
    expect(placeSummaryCard({ left: -50, top: 100, bottom: 140 }, desktop).left).toBe(16);
  });

  it("narrows to the screen on a phone", () => {
    const placed = placeSummaryCard({ left: 0, top: 100, bottom: 160 }, { width: 375, height: 700 });
    expect(placed).toEqual({ left: 16, width: 375 - 32, top: 166 });
  });
});
