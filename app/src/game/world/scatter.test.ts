import { describe, expect, it } from "vitest";
import { GARRISONS, groundTiles, MAP } from "./marches";
import { scatterProps, WOODS } from "./scatter";

/**
 * The woods, checked for the things that would look like bugs.
 *
 * Almost nothing here is about whether the scatter looks good, which is a
 * question for eyes. It is about the three places a prop must never be: in the
 * middle of a road, inside a holding, or standing in the river. Each of those
 * reads as a collision fault rather than as scenery, and each would send
 * somebody looking for a bug that is not there.
 */

const props = scatterProps();
const tiles = groundTiles();

describe("how much there is", () => {
  it("fills the country without carpeting it", () => {
    /*
     * The bounds are wide on purpose: this is a check that the density did not
     * collapse to nothing or explode to one prop per tile, not a promise about
     * a number somebody will want to tune.
     */
    expect(props.length).toBeGreaterThan(400);
    expect(props.length).toBeLessThan(MAP.width * MAP.height * 0.2);
  });

  it("is the same country every time it is asked for", () => {
    /*
     * A wood that is somewhere else on reload tells you, below the level of
     * noticing, that none of this is a place.
     */
    const again = scatterProps();
    expect(again.length).toBe(props.length);
    expect(again[0]).toEqual(props[0]);
    expect(again[again.length - 1]).toEqual(props[props.length - 1]);
  });

  it("uses more than one kind of thing", () => {
    expect(new Set(props.map((prop) => prop.sprite)).size).toBeGreaterThan(8);
  });
});

describe("where nothing may grow", () => {
  it("never stands in water", () => {
    for (const prop of props) {
      const tile = tiles[Math.round(prop.y) * MAP.width + Math.round(prop.x)];
      expect(tile).not.toBe("water");
    }
  });

  it("never stands inside a holding", () => {
    for (const prop of props) {
      for (const garrison of GARRISONS) {
        const distance = Math.hypot(prop.x - garrison.x, prop.y - garrison.y);
        expect(distance).toBeGreaterThan(garrison.radius);
      }
    }
  });

  it("never stands in a road", () => {
    /*
     * The one that matters most. A tree in the middle of a road is not a
     * charming detail; it is the thing that makes somebody look for the
     * collision bug that is not there.
     *
     * Checked against the worn earth itself rather than against the line the
     * roads take. This used to walk its own copy of that line, which agreed
     * with the map only because two identical straight-line expressions cannot
     * disagree; when the roads were given a curve, the copy went on describing
     * the old ones and the test failed on props that were nowhere near a lane.
     *
     * Reading `groundTiles` keeps the check independent of `roadPaths` -- it
     * asks whether a prop is standing on ground the renderer draws as earth,
     * which is the thing that would actually be seen -- while removing the
     * duplicate that broke.
     */
    for (const prop of props) {
      const tx = Math.round(prop.x);
      const ty = Math.round(prop.y);
      expect(tiles[ty * MAP.width + tx]).not.toBe("dirt");
    }
  });

  it("stays on the map", () => {
    for (const prop of props) {
      expect(prop.x).toBeGreaterThanOrEqual(-1);
      expect(prop.y).toBeGreaterThanOrEqual(-1);
      expect(prop.x).toBeLessThanOrEqual(MAP.width + 1);
      expect(prop.y).toBeLessThanOrEqual(MAP.height + 1);
    }
  });
});

describe("how it is placed", () => {
  it("never sits dead on the grid", () => {
    /* Props on tile centres read as a grid, which is what scatter is for. */
    const onCentre = props.filter(
      (prop) => Number.isInteger(prop.x) && Number.isInteger(prop.y),
    );
    expect(onCentre.length).toBe(0);
  });

  it("varies the size, within reason", () => {
    const scales = props.map((prop) => prop.scale);
    expect(new Set(scales).size).toBeGreaterThan(20);
    for (const scale of scales) {
      expect(scale).toBeGreaterThan(0.2);
      expect(scale).toBeLessThan(1.5);
    }
  });

  it("draws a tree taller than a shrub", () => {
    /*
     * One scale for everything suited the boulders and made a full-grown pine
     * half the height of a cottage, which reads as a herb garden rather than a
     * wood. Size is by what the thing is.
     */
    const heightOf = (names: string[]) => {
      const matching = props.filter((prop) => names.includes(prop.sprite));
      return matching.reduce((sum, prop) => sum + prop.scale, 0) / matching.length;
    };
    const trees = ["Environment_01", "Environment_02", "Environment_03", "Environment_21"];
    const shrubs = ["Environment_12", "Environment_19"];
    expect(heightOf(trees)).toBeGreaterThan(heightOf(shrubs) * 1.5);
  });

  it("makes a wood denser than open country", () => {
    /*
     * A forest is a place you can be inside or outside of; evenly-spread trees
     * are a texture. Measured where the claim actually lives -- inside a wood
     * against outside one -- rather than over quarters of the map, which are
     * far larger than any wood and came out even however the trees fell.
     */
    const inWood = (x: number, y: number) =>
      WOODS.some((wood) => Math.hypot(x - wood.x, y - wood.y) < wood.r);

    let woodTiles = 0;
    let openTiles = 0;
    for (let y = 0; y < MAP.height; y += 1) {
      for (let x = 0; x < MAP.width; x += 1) {
        if (tiles[y * MAP.width + x] !== "grass") continue;
        if (inWood(x, y)) woodTiles += 1;
        else openTiles += 1;
      }
    }

    const woodProps = props.filter((prop) => inWood(prop.x, prop.y)).length;
    const openProps = props.length - woodProps;

    expect(woodProps / woodTiles).toBeGreaterThan((openProps / openTiles) * 3);
  });
});
