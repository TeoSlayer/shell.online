import { describe, expect, it } from "vitest";
import { PROPS } from "./props";
import { STRUCTURES } from "./structures";
import { MEADOW, PAVING, ROAD, TERRAIN } from "./terrain";
import { spriteProblems, TRANSPARENT, type Sprite } from "./sprite";

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
  MEADOW.forEach((sprite, index) => entries.push([`meadow.${index}`, sprite]));
  PAVING.forEach((sprite, index) => entries.push([`paving.${index}`, sprite]));
  ROAD.forEach((sprite, index) => entries.push([`road.${index}`, sprite]));
  for (const [name, prop] of Object.entries(PROPS)) {
    entries.push([`prop.${name}`, prop.sprite]);
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
    for (const set of [MEADOW, PAVING, ROAD]) {
      for (const sprite of set) expect(sprite.w).toBe(sprite.h);
    }
  });

  it("leaves no hole in a ground tile", () => {
    /*
     * The ground is the bottom layer: a transparent pixel in it is a hole
     * through to the page behind, which shows up as a single stray dark dot
     * somewhere in a field of grass and is very hard to find by looking.
     */
    for (const [name, sprite] of Object.entries(TERRAIN)) {
      const holes = sprite.rows.some((row) => row.includes(TRANSPARENT));
      expect(holes, `${name} has a transparent pixel`).toBe(false);
    }
  });

  it("gives every prop somewhere to stand", () => {
    /*
     * Props sit on whatever ground they land on, so they must have transparent
     * edges. One drawn to the edge of its tile carries a square of the wrong
     * surface around with it.
     */
    for (const [name, prop] of Object.entries(PROPS)) {
      const { rows, h } = prop.sprite;
      const solidEdge =
        !rows[0]?.includes(TRANSPARENT) && !rows[h - 1]?.includes(TRANSPARENT);
      expect(solidEdge, `${name} fills its whole tile`).toBe(false);
      expect(prop.name).toBeTruthy();
    }
  });
});
