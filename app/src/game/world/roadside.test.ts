import { describe, expect, it } from "vitest";
import { GARRISONS, MAP, ROADS, garrisonById, groundTiles, roadPath, roadPaths } from "./marches";
import { roadsideProps } from "./roadside";

/**
 * The roads, and what stands beside them.
 *
 * As with the scatter, almost none of this is about whether it looks good --
 * that is a question for eyes. It is about the handful of things that would
 * read as faults: a lane that does not reach the gate it is named for, a
 * lamp-post standing in the river, a fence through the middle of a holding,
 * and a country that is somewhere else the second time it is asked for.
 *
 * The bow is the one exception, and it is checked because it is the whole
 * point of the change: straight roads are what made nine lanes out of one Keep
 * read as a wheel with spokes rather than as a country.
 */

const paths = roadPaths();
const props = roadsideProps();
const tiles = groundTiles();

describe("the line a road takes", () => {
  it("starts and ends at the holdings it joins", () => {
    /*
     * A lane that wanders as it arrives misses the gate, and one that stops
     * three tiles short is worse than a straight one.
     */
    ROADS.forEach((road, index) => {
      const from = garrisonById(road.from);
      const to = garrisonById(road.to);
      const path = paths[index];
      expect(from && to).toBeTruthy();
      expect(path[0].x).toBeCloseTo(from!.x, 6);
      expect(path[0].y).toBeCloseTo(from!.y, 6);
      expect(path[path.length - 1].x).toBeCloseTo(to!.x, 6);
      expect(path[path.length - 1].y).toBeCloseTo(to!.y, 6);
    });
  });

  it("bends away from the straight line", () => {
    /*
     * Measured as the furthest any road gets from the chord between its ends.
     * Not every road has to bow -- the offset is drawn from the endpoints and
     * some of them land near zero, which is realistic -- but if none of them
     * does then the curve is not working and this is the wheel again.
     */
    const bows = ROADS.map((road, index) => {
      const from = garrisonById(road.from)!;
      const to = garrisonById(road.to)!;
      const span = Math.hypot(to.x - from.x, to.y - from.y);
      let worst = 0;
      for (const step of paths[index]) {
        /* Distance from the point to the line through the two ends. */
        const area = Math.abs(
          (to.x - from.x) * (from.y - step.y) - (from.x - step.x) * (to.y - from.y),
        );
        worst = Math.max(worst, area / span);
      }
      return worst;
    });

    expect(bows.filter((bow) => bow > 2).length).toBeGreaterThanOrEqual(6);
    /* And never so far that the road looks lost rather than diverted. */
    for (const bow of bows) expect(bow).toBeLessThan(26);
  });

  it("varies in width along its run", () => {
    const widths = paths.flat().map((step) => step.width);
    expect(Math.min(...widths)).toBeLessThan(Math.max(...widths) - 0.4);
  });

  it("is the same country every time it is asked for", () => {
    const again = roadPath(GARRISONS[0], GARRISONS[1]);
    const once = roadPath(GARRISONS[0], GARRISONS[1]);
    expect(again).toEqual(once);
  });

  it("takes the same line whichever end it is asked from", () => {
    /*
     * The seed is ordered by id rather than by argument, so a road is one road
     * however it is named. Without that, `keep -> relay` and `relay -> keep`
     * would be two different lanes between the same two gates.
     */
    const out = roadPath(GARRISONS[0], GARRISONS[1]).map((step) => step.width);
    const back = roadPath(GARRISONS[1], GARRISONS[0]).map((step) => step.width);
    expect(out).toEqual([...back].reverse());
  });
});

describe("what stands beside a road", () => {
  it("puts out all three kinds", () => {
    for (const kind of ["fence", "bale", "lantern"] as const) {
      expect(props.filter((prop) => prop.kind === kind).length).toBeGreaterThan(4);
    }
  });

  it("stands nothing in the water", () => {
    /*
     * The one that would read as a bug rather than as scenery: a lamp-post in
     * the middle of the river.
     */
    for (const prop of props) {
      const tx = Math.round(prop.x);
      const ty = Math.round(prop.y);
      expect(tx).toBeGreaterThanOrEqual(0);
      expect(ty).toBeGreaterThanOrEqual(0);
      expect(tx).toBeLessThan(MAP.width);
      expect(ty).toBeLessThan(MAP.height);
      expect(tiles[ty * MAP.width + tx]).not.toBe("water");
    }
  });

  it("keeps fences and bales off the holdings", () => {
    /*
     * The lamps are exempt: two of them are put at each holding's gates on
     * purpose, which is the whole reason a holding can be found from the road
     * after dark.
     */
    for (const prop of props) {
      if (prop.kind === "lantern") continue;
      for (const garrison of GARRISONS) {
        expect(Math.hypot(prop.x - garrison.x, prop.y - garrison.y)).toBeGreaterThan(
          garrison.radius,
        );
      }
    }
  });

  it("builds fences in runs rather than as strays", () => {
    /*
     * A single section of rail is a stray object; six along one side of a lane
     * is a field boundary, and the eye reads the second and not the first.
     */
    const fences = props.filter((prop) => prop.kind === "fence");
    const near = fences.filter((fence) =>
      fences.some(
        (other) =>
          other !== fence && Math.hypot(other.x - fence.x, other.y - fence.y) < 3.2,
      ),
    );
    expect(near.length / fences.length).toBeGreaterThan(0.8);
  });

  it("gives every fence a direction to run along", () => {
    for (const fence of props.filter((prop) => prop.kind === "fence")) {
      expect(Math.hypot(fence.dx, fence.dy)).toBeCloseTo(1, 3);
    }
  });

  it("is the same country every time it is asked for", () => {
    const again = roadsideProps();
    expect(again.length).toBe(props.length);
    expect(again[0]).toEqual(props[0]);
    expect(again[again.length - 1]).toEqual(props[props.length - 1]);
  });
});
