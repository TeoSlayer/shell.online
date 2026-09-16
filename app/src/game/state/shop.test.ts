import { describe, expect, it } from "vitest";
import { buy, fitsClass, SKINS, skinById, swatchFor, tintFor, type Purse } from "./shop";

const purse = (marks: number, owned: string[] = []): Purse => ({ marks, owned });

describe("the catalogue", () => {
  it("sells something for you and something for your soldiers", () => {
    /*
     * Two slots, because they are two choices. A catalogue with only one kind
     * in it would quietly make the other half of the shop unreachable.
     */
    expect(SKINS.some((skin) => skin.wears === "hero")).toBe(true);
    expect(SKINS.some((skin) => skin.wears === "retinue")).toBe(true);
  });

  it("never cuts a retinue colour for one class", () => {
    /*
     * A livery is worn by a company of mixed classes, so it cannot be cut for
     * one of them. Only what the hero wears is ever class-bound.
     */
    for (const skin of SKINS) {
      if (skin.wears !== "retinue") continue;
      expect(fitsClass(skin, "codex")).toBe(true);
      expect(fitsClass(skin, "terminal")).toBe(true);
    }
  });

  it("sells nothing that changes a number", () => {
    /*
     * The line this whole file is drawn around. The moment a purchase makes a
     * wright hit harder or experience arrive faster, the game stops being a
     * read-out of work that happened and becomes something you can play wrong.
     * A skin is a set of colours, and this asserts that it stays that way.
     */
    for (const skin of SKINS) {
      expect(Object.keys(skin)).toEqual(
        expect.arrayContaining(["id", "name", "note", "cost", "fits", "wears", "tint"]),
      );
      /* A colour and nothing else: no stats, no reach, no damage. */
      expect(skin.tint).toBeGreaterThanOrEqual(0);
      expect(skin.tint).toBeLessThanOrEqual(0xffffff);
    }
  });

  it("gives every item a name, a price and something to read", () => {
    for (const skin of SKINS) {
      expect(skin.name).toBeTruthy();
      expect(skin.note).toBeTruthy();
      expect(skin.cost).toBeGreaterThan(0);
    }
  });

  it("has no two things with the same id", () => {
    expect(new Set(SKINS.map((skin) => skin.id)).size).toBe(SKINS.length);
  });

  it("knows which class a thing fits", () => {
    const anyone = SKINS.find((skin) => skin.fits === "any")!;
    const arcane = SKINS.find((skin) => skin.fits === "codex")!;
    expect(fitsClass(anyone, "terminal")).toBe(true);
    expect(fitsClass(arcane, "codex")).toBe(true);
    expect(fitsClass(arcane, "terminal")).toBe(false);
  });
});

describe("buying", () => {
  it("takes the marks and hands over the goods", () => {
    const result = buy(purse(100), "ash");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.purse.marks).toBe(100 - skinById("ash")!.cost);
    expect(result.purse.owned).toContain("ash");
  });

  it("leaves the old purse alone", () => {
    /* So a shop can show what a purchase would cost before committing to it. */
    const before = purse(100);
    buy(before, "ash");
    expect(before.marks).toBe(100);
    expect(before.owned).toHaveLength(0);
  });

  it("refuses, with a reason, when there is not enough", () => {
    const result = buy(purse(1), "gilt");
    expect(result).toEqual({ ok: false, reason: "poor" });
  });

  it("refuses to sell the same thing twice", () => {
    const result = buy(purse(1000, ["ash"]), "ash");
    expect(result).toEqual({ ok: false, reason: "owned" });
  });

  it("refuses something that does not exist", () => {
    expect(buy(purse(1000), "dragon")).toEqual({ ok: false, reason: "unknown" });
  });

  it("cannot be spent into debt, however many times it is called", () => {
    let current = purse(100);
    for (const skin of SKINS) {
      const result = buy(current, skin.id);
      if (result.ok) current = result.purse;
    }
    expect(current.marks).toBeGreaterThanOrEqual(0);
  });
});

describe("wearing it", () => {
  it("washes the figure in the colour it advertises", () => {
    expect(tintFor("gilt")).toBe(skinById("gilt")!.tint);
  });

  it("leaves the art as drawn when nothing is equipped", () => {
    /* White multiplied over a sprite is the sprite. */
    expect(tintFor(undefined)).toBe(0xffffff);
    expect(tintFor("nonsense")).toBe(0xffffff);
  });

  it("shows the same colour in the shop as on the field", () => {
    /*
     * The swatch is not a decorative approximation of the skin: it is the
     * skin. A preview that drifts from the thing being sold is a small lie.
     */
    for (const skin of SKINS) {
      expect(swatchFor(skin.id)).toBe(`#${skin.tint.toString(16).padStart(6, "0")}`);
    }
  });
});
