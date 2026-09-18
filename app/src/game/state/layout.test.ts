import { describe, expect, it } from "vitest";
import { isCompact, layoutFor } from "./layout";

const phone = { width: 390, height: 844, coarse: true };
const phoneSideways = { width: 844, height: 390, coarse: true };
const tablet = { width: 834, height: 1112, coarse: true };
const laptop = { width: 1440, height: 900, coarse: false };

describe("which shape of screen this is", () => {
  it("knows a phone held upright", () => {
    expect(layoutFor(phone)).toBe("phone");
  });

  it("knows the same phone held sideways", () => {
    /*
     * The bug this function exists for. A handset in landscape is 844 pixels
     * across, which sails past every `width <= 640px` rule in the stylesheet
     * and then has 390 pixels of height to fit the whole interface into.
     */
    expect(layoutFor(phoneSideways)).toBe("phone");
  });

  it("does not mistake a tablet for a phone", () => {
    /*
     * A tablet is a touch device with room, which is a real third case: the
     * HUD fits, so it stays. What a finger needs there is hit targets, and
     * those are 48px for everybody already.
     */
    expect(layoutFor(tablet)).toBe("room");
  });

  it("gives a laptop the whole interface", () => {
    expect(layoutFor(laptop)).toBe("room");
    expect(isCompact(layoutFor(laptop))).toBe(false);
  });

  it("calls a short window snug, and does not trim it", () => {
    /*
     * Snug tightens the padding and keeps every panel. A short desktop window
     * has room for four corners and no thumb over any of them; taking
     * somebody's purse away because they dragged the window shorter would be
     * the interface deciding it knows better.
     */
    const layout = layoutFor({ width: 1440, height: 560, coarse: false });
    expect(layout).toBe("snug");
    expect(isCompact(layout)).toBe(false);
  });

  it("trims a handset, either way up", () => {
    expect(isCompact(layoutFor(phone))).toBe(true);
    expect(isCompact(layoutFor(phoneSideways))).toBe(true);
  });
});
