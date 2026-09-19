import { describe, expect, it } from "vitest";
import { firstEnabled, nextIndex, restoreIndex } from "./menu";

/*
 * The rule these protect is "a pad can always get out of a menu". Every case
 * below is a dead end somebody would otherwise find by picking up a controller
 * and discovering the game had stopped responding.
 */

const all = (count: number) => Array.from({ length: count }, () => true);

describe("moving through a menu", () => {
  it("steps forward and back", () => {
    expect(nextIndex(0, 1, all(3))).toBe(1);
    expect(nextIndex(2, -1, all(3))).toBe(1);
  });

  it("wraps at both ends, so neither is a wall", () => {
    expect(nextIndex(2, 1, all(3))).toBe(0);
    expect(nextIndex(0, -1, all(3))).toBe(2);
  });

  it("steps over a disabled item rather than landing on it", () => {
    /* Resume, [unaffordable], Quit. */
    expect(nextIndex(0, 1, [true, false, true])).toBe(2);
    expect(nextIndex(2, 1, [true, false, true])).toBe(0);
  });

  it("steps over a run of disabled items", () => {
    expect(nextIndex(0, 1, [true, false, false, false, true])).toBe(4);
  });

  it("stays put when nothing at all can be selected", () => {
    /* Rather than looping forever looking for somewhere to go. */
    expect(nextIndex(1, 1, [false, false, false])).toBe(1);
  });

  it("stays put in an empty menu", () => {
    expect(nextIndex(0, 1, [])).toBe(0);
  });

  it("does not get stuck on the only selectable item", () => {
    expect(nextIndex(1, 1, [false, true, false])).toBe(1);
  });
});

describe("where a menu opens", () => {
  it("lands on the first thing that can be chosen", () => {
    expect(firstEnabled([false, false, true])).toBe(2);
  });

  it("falls back to the top when nothing can be chosen", () => {
    expect(firstEnabled([false, false])).toBe(0);
  });
});

describe("returning to a menu", () => {
  it("puts you back where you were", () => {
    expect(restoreIndex(2, all(4))).toBe(2);
  });

  it("clamps a position the menu has since outgrown", () => {
    /* Items were removed while this menu was closed. */
    expect(restoreIndex(9, all(3))).toBe(2);
  });

  it("moves on when the remembered item has become unaffordable", () => {
    expect(restoreIndex(1, [true, false, true])).toBe(2);
  });

  it("survives a menu that has emptied", () => {
    expect(restoreIndex(3, [])).toBe(0);
  });
});
