import { describe, expect, it } from "vitest";
import { MAP } from "./marches";
import { depthOf, diamond, ORIGIN_X, TILE_H, TILE_W, toScreen, toTile } from "./iso";

/**
 * The projection, checked both ways.
 *
 * `toTile` is the inverse of `toScreen`, and clicking anything on the map is
 * that inverse being right. It is two lines of algebra that were wrong once
 * already -- the shift that keeps the map out of negative coordinates has to
 * be applied in one direction and undone in the other, and a version that
 * shifted only one way put every click half a map away from the thing under
 * the cursor.
 */

describe("the projection", () => {
  it("comes back to where it started", () => {
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [12, 47], [63, 63], [31.5, 8.25]]) {
      const screen = toScreen(x, y);
      const back = toTile(screen.x, screen.y);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it("keeps the whole map at positive coordinates", () => {
    /*
     * What ORIGIN_X is for. pixi-viewport describes the world as a box from
     * the origin, so a map running into negative x cannot be clamped and the
     * camera slides off it. Every corner has to land inside the box the stage
     * declares, or the clamp is against the wrong rectangle.
     */
    const corners = [[0, 0], [MAP.width, 0], [0, MAP.height], [MAP.width, MAP.height]];
    for (const [x, y] of corners) {
      const screen = toScreen(x, y);
      expect(screen.x).toBeGreaterThanOrEqual(0);
      expect(screen.y).toBeGreaterThanOrEqual(0);
      expect(screen.x).toBeLessThanOrEqual(MAP.width * TILE_W);
      expect(screen.y).toBeLessThanOrEqual(MAP.height * TILE_H);
    }
  });

  it("puts the far corners exactly on the edges of that box", () => {
    /* Not merely inside it: the map is the world, with nothing spare. */
    expect(toScreen(0, MAP.height).x).toBe(0);
    expect(toScreen(MAP.width, 0).x).toBe(MAP.width * TILE_W);
    expect(toScreen(0, 0).y).toBe(0);
    expect(toScreen(MAP.width, MAP.height).y).toBe(MAP.height * TILE_H);
  });

  it("is the 2:1 grid the art was drawn for", () => {
    const origin = toScreen(0, 0);
    expect(toScreen(1, 0).x - origin.x).toBe(TILE_W / 2);
    expect(toScreen(1, 0).y - origin.y).toBe(TILE_H / 2);
    expect(ORIGIN_X).toBe(MAP.width * (TILE_W / 2));
  });
});

describe("depth", () => {
  it("draws what is further down the screen in front", () => {
    expect(depthOf(4, 4)).toBeGreaterThan(depthOf(3, 4));
    expect(depthOf(4, 4)).toBeGreaterThan(depthOf(4, 3));
  });

  it("puts a thing in the air over the thing it is passing", () => {
    expect(depthOf(4, 4, 40)).toBeGreaterThan(depthOf(4, 4, 0));
  });

  it("orders two things on the same tile the same way every time", () => {
    expect(depthOf(9, 2)).toBe(depthOf(9, 2));
    /* x + y is the view axis, so these genuinely are at the same depth. */
    expect(depthOf(9, 2)).toBe(depthOf(2, 9));
  });
});

describe("a tile's diamond", () => {
  it("has four corners around the middle of that tile", () => {
    const middle = toScreen(3, 5);
    const points = diamond(3, 5);
    expect(points).toHaveLength(8);
    expect(points[0]).toBe(middle.x);
    expect(points[1]).toBe(middle.y - TILE_H / 2);
    expect(points[4]).toBe(middle.x);
    expect(points[5]).toBe(middle.y + TILE_H / 2);
  });
});
