import { describe, expect, it } from "vitest";
import { STONE, contrast, reskin, SLOT } from "./palette";
import {
  decodeSprite,
  frameAt,
  frameOffset,
  slotOf,
  spriteProblems,
  type Animation,
  type Sprite,
} from "./sprite";

const square: Sprite = {
  w: 2,
  h: 2,
  palette: "stone",
  rows: [
    "0f",
    ".7",
  ],
};

describe("reading an authored sprite", () => {
  it("maps hex digits to palette slots and dots to nothing", () => {
    expect(slotOf("0")).toBe(0);
    expect(slotOf("f")).toBe(15);
    expect(slotOf("a")).toBe(10);
    expect(slotOf(".")).toBe(-1);
  });

  it("treats anything it does not understand as transparent", () => {
    /* Better a hole than a wrong colour; the validator below names it anyway. */
    expect(slotOf("z")).toBe(-1);
    expect(slotOf(" ")).toBe(-1);
  });
});

describe("decoding to pixels", () => {
  it("writes the palette colour for each slot", () => {
    const pixels = decodeSprite(square, STONE);
    const red = Number.parseInt(STONE[0].slice(1, 3), 16);
    expect(pixels[0]).toBe(red);
    expect(pixels[3]).toBe(255);
  });

  it("leaves transparent pixels fully clear", () => {
    const pixels = decodeSprite(square, STONE);
    /* Row 1, column 0 is the '.' — its alpha byte is the fourth of that pixel. */
    const at = (1 * square.w + 0) * 4;
    expect(pixels[at + 3]).toBe(0);
  });

  it("produces exactly four bytes per pixel", () => {
    expect(decodeSprite(square, STONE)).toHaveLength(square.w * square.h * 4);
  });

  it("draws the same shape in a different palette, which is what a skin is", () => {
    const skin = reskin(STONE, { [SLOT.shadow]: "#ff0000" });
    const original = decodeSprite(square, STONE);
    const reskinned = decodeSprite(square, skin);
    /* The silhouette is identical... */
    expect(reskinned[3]).toBe(original[3]);
    /* ...and only the colour moved. */
    expect(reskinned[0]).toBe(255);
    expect(reskinned[1]).toBe(0);
  });
});

describe("catching an authoring mistake", () => {
  it("passes a sprite that counts up", () => {
    expect(spriteProblems("square", square)).toEqual([]);
  });

  it("notices a row of the wrong width", () => {
    /*
     * The mistake this exists for. One character short shifts every pixel after
     * it, which is obvious in a test and baffling on screen.
     */
    const problems = spriteProblems("short", { ...square, rows: ["0f", "7"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("row 1 is 1 wide, expected 2");
  });

  it("notices the wrong number of rows", () => {
    const problems = spriteProblems("tall", { ...square, rows: ["0f"] });
    expect(problems.join(" ")).toContain("2 rows tall but has 1");
  });

  it("notices a character that is not a palette slot", () => {
    const problems = spriteProblems("odd", { ...square, rows: ["0z", ".7"] });
    expect(problems.join(" ")).toContain("'z'");
  });

  it("reports every mistake at once rather than only the first", () => {
    const problems = spriteProblems("bad", { ...square, rows: ["0", "7f7"] });
    expect(problems.length).toBeGreaterThan(1);
  });

  it("refuses a sprite with no size at all", () => {
    expect(spriteProblems("empty", { w: 0, h: 0, palette: "stone", rows: [] })).toHaveLength(1);
  });
});

describe("running an animation", () => {
  const walk: Animation = {
    sprite: { w: 8, h: 2, palette: "stone", rows: ["01234567", "01234567"] },
    frames: 4,
    fps: 8,
  };

  it("advances through the frames and loops", () => {
    expect(frameAt(walk, 0)).toBe(0);
    expect(frameAt(walk, 125)).toBe(1);
    expect(frameAt(walk, 500)).toBe(0);
  });

  it("holds on the first frame when motion is turned down", () => {
    /*
     * This is the whole of how reduced motion reaches the field: the caller
     * passes the flag and every animation in the game stops, without any of
     * them knowing the setting exists.
     */
    expect(frameAt(walk, 375, true)).toBe(0);
  });

  it("holds still for a single-frame sprite", () => {
    expect(frameAt({ ...walk, frames: 1 }, 9999)).toBe(0);
  });

  it("finds each frame's column", () => {
    expect(frameOffset(walk, 0)).toBe(0);
    expect(frameOffset(walk, 2)).toBe(4);
  });
});

describe("the colourblind palettes", () => {
  it("keeps alarm clearly apart from the accent it must not be confused with", () => {
    /*
     * Colour is never the only signal in the keep -- every state carries an
     * icon and a word. This is the second line of defence, and a palette that
     * quietly stopped separating them would otherwise go unnoticed.
     */
    expect(contrast(STONE[SLOT.alarm], STONE[SLOT.accentLit])).toBeGreaterThan(100);
  });

  it("measures no distance between a colour and itself", () => {
    expect(contrast("#c8ff4d", "#c8ff4d")).toBe(0);
  });
});
