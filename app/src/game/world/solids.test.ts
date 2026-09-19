import { describe, expect, it } from "vitest";
import { pushOut, solids } from "./solids";
import { GARRISONS } from "./marches";

/**
 * The rules the correction has to keep, rather than the numbers it happens to
 * produce. What matters is that nobody stands inside a wall, that the fix never
 * argues with itself, and that walking along a wall still gets you somewhere --
 * the last one being what separates this from the steering that was deleted for
 * shaking.
 */
describe("solid ground", () => {
  const keep = GARRISONS.find((holding) => holding.id === "keep")!;

  it("has a footprint for every building on every holding", () => {
    const buildings = GARRISONS.reduce((total, holding) => total + holding.buildings.length, 0);
    /* Every building, and the castle, which belongs to no holding's list. */
    expect(solids().length).toBe(buildings + 1);
  });

  it("leaves open ground alone", () => {
    /* A corner of the map with nothing built on it. */
    const at = pushOut(12, 12);
    expect(at.x).toBe(12);
    expect(at.y).toBe(12);
  });

  it("puts somebody standing in the castle back outside it", () => {
    const inside = pushOut(keep.x, keep.y - 1 + 0.2);
    const dx = inside.x - keep.x;
    const dy = (inside.y - (keep.y - 1)) * 2;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(3.3);
  });

  it("does not argue with itself", () => {
    /*
     * The whole reason this is a correction and not a steering decision: the
     * answer depends on the position and nothing else, so applying it twice
     * changes nothing. A rule that moved a figure on every tick from a settled
     * position is a rule that makes it shake.
     */
    const once = pushOut(keep.x + 1, keep.y);
    const twice = pushOut(once.x, once.y);
    expect(twice.x).toBeCloseTo(once.x, 10);
    expect(twice.y).toBeCloseTo(once.y, 10);
  });

  it("never leaves anybody inside a wall, from any direction", () => {
    for (let angle = 0; angle < 32; angle += 1) {
      const t = (angle / 32) * Math.PI * 2;
      const at = pushOut(keep.x + Math.cos(t) * 0.5, keep.y - 1 + Math.sin(t) * 0.25);
      const dx = at.x - keep.x;
      const dy = (at.y - (keep.y - 1)) * 2;
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(3.39);
    }
  });

  it("lets somebody slide along a wall rather than stopping dead on it", () => {
    /*
     * Pressed against the castle and walking past it rather than into it. The
     * correction is perpendicular to the wall, so the part of the step that
     * runs along the wall survives -- which is what makes a blocked route feel
     * like walking round a building instead of hitting a pane of glass.
     */
    const start = pushOut(keep.x + 3.4, keep.y - 1);
    const nudged = pushOut(start.x, start.y + 0.3);
    expect(Math.hypot(nudged.x - start.x, nudged.y - start.y)).toBeGreaterThan(0.1);
  });
});
