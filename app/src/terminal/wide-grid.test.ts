import { describe, expect, it } from "vitest";
import { canDrawWideGrid, layoutParameter } from "./wide-grid";

/*
 * The grid is the session's, so the widest one it may use is the one its
 * smallest viewer can draw. 160 columns in the canary's 385px pane is 2.4
 * pixels a character: not small text, no text -- the glyphs stop landing on
 * pixels and a full-screen program's borders disappear.
 */
describe("whether a window can draw the wider grid", () => {
  it("says yes to the panes people work in", () => {
    expect(canDrawWideGrid(1212, 765)).toBe(true);
    expect(canDrawWideGrid(1620, 900)).toBe(true);
  });

  it("says no to a pane too narrow to land the columns on pixels", () => {
    expect(canDrawWideGrid(385, 240)).toBe(false);
    expect(canDrawWideGrid(768, 1024)).toBe(false);
    expect(canDrawWideGrid(390, 844)).toBe(false);
  });

  it("says no to a pane wide enough but far too short", () => {
    expect(canDrawWideGrid(1920, 400)).toBe(false);
  });

  /*
   * The pane, not the window. The live canary runs the real pane at 385x240
   * inside a full-size browser window: measured from the window that pane
   * claimed it could draw 160 columns at 2.4 pixels each.
   */
  it("believes the pane over the window it sits in", () => {
    expect(layoutParameter({ width: 385, height: 240 }, { width: 1512, height: 945 })).toBe("");
    expect(layoutParameter({ width: 1212, height: 765 }, { width: 1512, height: 945 })).toBe("?layout=wide");
  });

  it("falls back to the window only when the pane has no size yet", () => {
    expect(layoutParameter(null, { width: 1512, height: 945 })).toBe("?layout=wide");
    expect(layoutParameter({ width: 0, height: 0 }, { width: 390, height: 844 })).toBe("");
  });
});
