import { GARRISONS, MAP, groundTiles, roadPaths, type RoadStep } from "./marches";
import { campSites } from "./camps";

/**
 * The things people leave beside a road.
 *
 * Fences, hay bales and lanterns. None of them is a mechanic and none of them
 * can be touched; they are here because a lane running through open grass is a
 * line on a floor, and the same lane with a rail along one side, a stack of
 * bales at the corner and a lamp at the junction is somewhere that is used.
 *
 * The scatter says what grows on the Marches; this says what was *put* there,
 * and the difference decides where each goes. A tree stands wherever the wood
 * reaches. A fence follows a road, because a fence with nothing on either side
 * of it is a fence nobody built.
 *
 * Deterministic, like everything else on this map, and for the same reason: a
 * country whose lamp-posts are somewhere else on reload is not a place.
 */

export type RoadsideKind = "fence" | "bale" | "lantern";

export interface Roadside {
  kind: RoadsideKind;
  x: number;
  y: number;
  /**
   * Which way it faces, as a unit vector in tile space. Only the fences use
   * it -- a rail has to run along the road rather than across it -- but it is
   * cheap to carry and it keeps the shape of the list the same for all three.
   */
  dx: number;
  dy: number;
}

/** The murmur3 finaliser again. See `world/scatter.ts` for why not something cheaper. */
function noise(a: number, b: number, channel: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(channel + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** The direction a road is heading at one of its steps. */
function tangent(path: RoadStep[], index: number): { dx: number; dy: number } {
  const back = path[Math.max(0, index - 1)];
  const on = path[Math.min(path.length - 1, index + 1)];
  const dx = on.x - back.x;
  const dy = on.y - back.y;
  const length = Math.hypot(dx, dy) || 1;
  return { dx: dx / length, dy: dy / length };
}

/**
 * Whether a point is on a holding's own ground.
 *
 * Roadside things are pushed off the holdings, which are already dense with
 * buildings. A lantern in the middle of the Keep's courtyard is hidden behind
 * a roof; the same lantern on the road outside the gate is the thing that
 * tells you where the gate is.
 */
function insideHolding(x: number, y: number, margin: number): boolean {
  for (const garrison of GARRISONS) {
    if (Math.hypot(x - garrison.x, y - garrison.y) < garrison.radius + margin) return true;
  }
  return false;
}

/** Nothing stands in a river. The scatter checks this too, for the same reason. */
function onLand(x: number, y: number): boolean {
  const tiles = groundTiles();
  const tx = Math.round(x);
  const ty = Math.round(y);
  if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) return false;
  return tiles[ty * MAP.width + tx] !== "water";
}

/**
 * Everything beside the roads, worked out once.
 *
 * The three kinds are placed by three different rules, because they are three
 * different things:
 *
 * **Fences** come in runs. A single section of rail is a stray object; six of
 * them along one side of a lane is a field boundary, and the eye reads the
 * second and not the first. A run picks a side and stays on it.
 *
 * **Bales** come in twos and threes, off the verge. They are what a field is
 * for, so they sit back from the road rather than on it.
 *
 * **Lanterns** are spaced along each run and set at every gate, because a lamp
 * is a thing somebody put where it was needed rather than where it fitted.
 * They are also what lights this map now that it is dusk, so where they go
 * decides where anything can be seen.
 */
export function roadsideProps(): Roadside[] {
  const out: Roadside[] = [];

  const put = (kind: RoadsideKind, x: number, y: number, dx = 0, dy = 0) => {
    if (!onLand(x, y)) return;
    out.push({ kind, x, y, dx, dy });
  };

  roadPaths().forEach((path, road) => {
    if (path.length < 6) return;

    /* Where the current fence run ends, so a run stays on one side of the lane. */
    let fenceUntil = -1;
    let fenceSide = 1;

    for (let index = 2; index < path.length - 2; index += 1) {
      const step = path[index];
      const { dx, dy } = tangent(path, index);
      /* The verge: perpendicular to the road, just clear of the worn earth. */
      const nx = -dy;
      const ny = dx;
      const verge = step.width + 1.1;

      if (insideHolding(step.x, step.y, 1)) continue;

      /* Lanterns: one every twenty-two steps, alternating sides. */
      if (index % 22 === 8) {
        const side = index % 44 === 8 ? 1 : -1;
        put("lantern", step.x + nx * verge * side, step.y + ny * verge * side);
      }

      /*
       * Half as many runs, and not half as many sections in each.
       *
       * There was too much fence on this map, but thinning every run would have
       * been the wrong half to take: a run with gaps in it is not a field
       * boundary, it is litter, and the whole reason a fence reads as a fence is
       * that it is continuous. So the *number of runs* drops and their length
       * does not -- fewer veins, each one still joined end to end.
       */
      if (index > fenceUntil && noise(road, index, 1) < 0.05) {
        /* In steps, and a section now costs four of them, so a run of three
         * to seven sections is twelve to twenty-eight steps rather than five
         * to eleven -- which at the new spacing was one section and a gap. */
        fenceUntil = index + 12 + Math.floor(noise(road, index, 2) * 16);
        fenceSide = noise(road, index, 3) < 0.5 ? 1 : -1;
      }
      /*
       * Every fourth step while a run is going.
       *
       * A road step is half a tile -- `steps` is `span * 2` -- and a section is
       * drawn 2.1 tiles long, so every other step put each section a single
       * tile from the last and stacked it more than halfway through its
       * neighbour. Four steps is 2.0 tiles: the rails meet end to end with a
       * tenth of a tile of overlap, which is a fence rather than a pile of
       * them.
       */
      if (index <= fenceUntil && index % 4 === 0) {
        put("fence", step.x + nx * verge * fenceSide, step.y + ny * verge * fenceSide, dx, dy);
      }

      /* Bales: rarely, further off the verge, in twos and threes. */
      if (noise(road, index, 4) < 0.04) {
        const side = noise(road, index, 5) < 0.5 ? 1 : -1;
        const back = verge + 1.6 + noise(road, index, 6) * 2;
        const bx = step.x + nx * back * side;
        const by = step.y + ny * back * side;
        const many = 2 + Math.floor(noise(road, index, 7) * 2);
        for (let n = 0; n < many; n += 1) {
          put("bale", bx + n * 0.95, by + (n % 2) * 0.85, dx, dy);
        }
      }
    }
  });

  /*
   * A lamp at a holding's north and south gates, so it can be found from the
   * road. Two rather than four: in this projection the east and west gates sit
   * on the widest part of the holding, where they are furthest from anything
   * and light the least.
   */
  for (const garrison of GARRISONS) {
    const reach = garrison.radius + 0.5;
    put("lantern", garrison.x, garrison.y + reach);
    put("lantern", garrison.x, garrison.y - reach);
  }

  return out;
}

/**
 * The camps' own lamps, kept apart because a camp is lit only while it is held.
 *
 * They are there for one job. The banners stand at a camp's gate, and a banner
 * nobody can make out is a banner that does not say whose ground this is.
 * Lighting them is a better answer than making them bigger a second time.
 */
export function campLanterns(): { site: string; x: number; y: number }[] {
  return campSites().flatMap((site) => [
    { site: `${site.x},${site.y}`, x: site.x - 4.8, y: site.y + 3.4 },
    { site: `${site.x},${site.y}`, x: site.x + 4.6, y: site.y + 3.2 },
  ]);
}
