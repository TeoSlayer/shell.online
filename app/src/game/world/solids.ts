import { GARRISONS } from "./marches";

/**
 * The ground a building stands on, which nobody may walk through.
 *
 * Why this is a list of circles and not a pathfinder, and why nothing here
 * re-decides anything:
 *
 * `sim.ts` says there is no obstacle avoidance and there never will be, and it
 * is right about the thing it is refusing. The version it is describing steered
 * *before* moving -- an actor looked ahead, saw a wall, chose a way round, and
 * chose again on the next tick from a slightly different place. Thirty
 * decisions a second out of one wandering position is a figure that spins on
 * the spot, and deleting it was the correct fix.
 *
 * This is the other half of the problem and it is not the same half. Nothing
 * here plans, looks ahead, or changes where anybody decided to go. A step is
 * taken exactly as it always was, and only then is the result checked: if it
 * landed inside a wall it is pushed back out to the nearest point outside.
 * That is a function of position alone, so the same position always gives the
 * same answer and there is nothing for two ticks to disagree about. Walking
 * into a wall at an angle slides along it, because the push-out is
 * perpendicular to the wall and the rest of the step survives.
 *
 * Only the fixed holdings are solid. A camp is not: a camp is where a hero's
 * own retinue stands, and making its three tents solid would pen the soldiers
 * in against their own barracks.
 */
export interface Solid {
  x: number;
  y: number;
  r: number;
}

/**
 * How much ground a building takes, from how big it is drawn.
 *
 * Kenney's structures are about a tile and a half across at scale 1, and the
 * footprint wanted here is the part a person would walk into rather than the
 * roof overhanging it -- so it is a little under half the width.
 */
function radiusFor(scale: number): number {
  return 0.78 * scale;
}

let cache: Solid[] | undefined;

export function solids(): Solid[] {
  if (cache) return cache;

  const out: Solid[] = [];
  for (const garrison of GARRISONS) {
    for (const building of garrison.buildings) {
      out.push({ x: building.x, y: building.y, r: radiusFor(building.scale ?? 1) });
    }
  }

  /*
   * The castle, which is not in any garrison's building list because it is a
   * landmark rather than one of the holding's structures. It is the biggest
   * thing on the map and the one people would most obviously walk through.
   */
  const keep = GARRISONS.find((holding) => holding.id === "keep");
  if (keep) out.push({ x: keep.x, y: keep.y - 1, r: 3.4 });

  cache = out;
  return out;
}

/**
 * Pushes a point out of anything it has ended up inside.
 *
 * Returns the corrected point. Runs after a step rather than before it, and
 * reads nothing but the point itself, so it cannot oscillate.
 *
 * The y axis is squashed to match the way the map is drawn: a figure walks a
 * tile north in half the screen distance it walks a tile east, and a circular
 * footprint in tile space is the ellipse the eye expects on the ground.
 */
export function pushOut(x: number, y: number): { x: number; y: number } {
  let px = x;
  let py = y;

  for (const solid of solids()) {
    const dx = px - solid.x;
    /* Tile space is 2:1 on screen; compare in the shape the player sees. */
    const dy = (py - solid.y) * 2;
    const distance = Math.hypot(dx, dy);
    if (distance >= solid.r || distance === 0) continue;

    const push = solid.r / distance;
    px = solid.x + dx * push;
    py = solid.y + (dy * push) / 2;
  }

  return { x: px, y: py };
}
