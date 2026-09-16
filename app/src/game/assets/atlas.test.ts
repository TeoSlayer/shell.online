import { describe, expect, it } from "vitest";
import { STRUCTURES } from "./structures";
import { TERRAIN } from "./terrain";
import { spriteProblems, type Sprite } from "./sprite";

/**
 * Every sprite in the game, checked for the mistakes hand-authoring makes.
 *
 * This is the test that makes text-as-pixel-art safe to work in. A row one
 * character short shifts every pixel after it and looks, on screen, like the
 * artwork was simply drawn badly -- there is no error, nothing throws, it just
 * comes out wrong. Here it is a line number and a count.
 */
const everySprite = (): [string, Sprite][] => {
  const entries: [string, Sprite][] = [];
  for (const [name, sprite] of Object.entries(TERRAIN)) {
    entries.push([`terrain.${name}`, sprite]);
  }
  for (const [name, art] of Object.entries(STRUCTURES)) {
    art.tiers.forEach((sprite, tier) => entries.push([`${name}.tier${tier + 1}`, sprite]));
  }
  return entries;
};

describe("the atlas", () => {
  it("has no miscounted rows anywhere", () => {
    const problems = everySprite().flatMap(([name, sprite]) => spriteProblems(name, sprite));
    expect(problems).toEqual([]);
  });

  it("gives every structure the same footprint at every tier", () => {
    /*
     * An upgrade that changed size would jump out of its plot on the field, or
     * overlap the thing next to it. Taller is allowed and is most of how an
     * upgrade reads; wider is not.
     */
    for (const [name, art] of Object.entries(STRUCTURES)) {
      const widths = new Set(art.tiers.map((tier) => tier.w));
      expect(widths, `${name} changes width between tiers`).toHaveProperty("size", 1);
    }
  });

  it("gives every structure a name and a description", () => {
    /* Colour and silhouette are not enough on their own; see the colour rules. */
    for (const art of Object.values(STRUCTURES)) {
      expect(art.name).toBeTruthy();
      expect(art.blurb).toBeTruthy();
      expect(art.tiers.length).toBeGreaterThan(0);
    }
  });

  it("keeps the ground tiles square and tileable", () => {
    for (const [name, sprite] of Object.entries(TERRAIN)) {
      expect(sprite.w, `${name} is not square`).toBe(sprite.h);
    }
  });
});
