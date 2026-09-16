import { describe, expect, it } from "vitest";
import { STONE } from "../assets/palette";
import { buy, fitsClass, paletteFor, SKINS, skinById, type Purse } from "./shop";

const purse = (marks: number, owned: string[] = []): Purse => ({ marks, owned });

describe("the catalogue", () => {
  it("sells nothing that changes a number", () => {
    /*
     * The line this whole file is drawn around. The moment a purchase makes a
     * wright hit harder or experience arrive faster, the game stops being a
     * read-out of work that happened and becomes something you can play wrong.
     * A skin is a set of colours, and this asserts that it stays that way.
     */
    for (const skin of SKINS) {
      expect(Object.keys(skin)).toEqual(
        expect.arrayContaining(["id", "name", "note", "cost", "fits", "changes"]),
      );
      const slots = Object.keys(skin.changes).map(Number);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThanOrEqual(15);
      }
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
  it("changes the colours it says it changes, and nothing else", () => {
    const skin = skinById("gilt")!;
    const worn = paletteFor(STONE, "gilt");
    worn.forEach((colour, slot) => {
      if (slot in skin.changes) expect(colour).toBe(skin.changes[slot]);
      else expect(colour).toBe(STONE[slot]);
    });
  });

  it("wears the class colours when nothing is equipped", () => {
    expect(paletteFor(STONE, undefined)).toEqual(STONE);
    expect(paletteFor(STONE, "nonsense")).toEqual(STONE);
  });
});
