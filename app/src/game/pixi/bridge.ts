import { Container, Graphics } from "pixi.js";
import { crossings, type Crossing } from "../world/marches";
import { depthOf, TILE_H, TILE_W, toScreen } from "../world/iso";

/**
 * The bridges, where a road runs into the river.
 *
 * Drawn rather than imported, like the fences and the bales beside them: there
 * is no bridge in either art pack, and a deck is a handful of boards in a
 * projection this simple.
 *
 * Built from `crossings()`, which reads the road and the ground rather than a
 * written-down position -- so if the river bends somewhere else tomorrow the
 * bridge goes with it, instead of leaving a road stopping at the water and a
 * deck standing in a field.
 */

const DECK = 0x8a6236;
const DECK_LIT = 0xa97b48;
const DECK_DARK = 0x5e4123;
const RAIL = 0x6f4a29;
const RAIL_LIT = 0x9c7245;

/** A point in tile space, as the screen sees it. */
function screenAt(x: number, y: number): { x: number; y: number } {
  return toScreen(x, y);
}

function drawBridge(crossing: Crossing): Graphics {
  const deck = new Graphics();

  /* Along the road, and across it. Both in tile space, projected as we go. */
  const ax = crossing.dx;
  const ay = crossing.dy;
  const bx = -crossing.dy;
  const by = crossing.dx;

  const half = crossing.span / 2;
  /** Half the roadway, in tiles. Wide enough for the lane it carries. */
  const wide = 1.25;

  const middle = screenAt(crossing.x, crossing.y);
  const at = (along: number, across: number) => {
    const point = screenAt(
      crossing.x + ax * along + bx * across,
      crossing.y + ay * along + by * across,
    );
    return { x: point.x - middle.x, y: point.y - middle.y };
  };

  const nearLeft = at(-half, -wide);
  const nearRight = at(-half, wide);
  const farRight = at(half, wide);
  const farLeft = at(half, -wide);

  /*
   * The trestles first, so the deck sits on them. Two piers standing in the
   * water, drawn before the boards for the same reason the rails are drawn
   * after: what is behind goes down first.
   */
  for (const along of [-half * 0.42, half * 0.42]) {
    for (const across of [-wide * 0.72, wide * 0.72]) {
      const post = at(along, across);
      deck.rect(post.x - 3, post.y, 6, TILE_H * 0.85).fill({ color: DECK_DARK });
    }
  }

  /* The deck: one board-coloured slab with a lit near edge. */
  deck
    .poly([
      nearLeft.x, nearLeft.y,
      nearRight.x, nearRight.y,
      farRight.x, farRight.y,
      farLeft.x, farLeft.y,
    ])
    .fill({ color: DECK });

  /*
   * The planks, across the run rather than along it.
   *
   * A flat slab is a ramp; the boards are what say this is something somebody
   * built out of timber. Spaced by the tile so they stay the same size as the
   * ground they cross.
   */
  const planks = Math.max(4, Math.round(crossing.span * 2.2));
  for (let plank = 1; plank < planks; plank += 1) {
    const along = -half + (crossing.span * plank) / planks;
    const left = at(along, -wide);
    const right = at(along, wide);
    deck
      .moveTo(left.x, left.y)
      .lineTo(right.x, right.y)
      .stroke({ color: DECK_DARK, width: 1.4, alpha: 0.55 });
  }

  /* The near edge catches the light, which is what gives the deck a thickness. */
  deck
    .moveTo(nearLeft.x, nearLeft.y)
    .lineTo(nearRight.x, nearRight.y)
    .stroke({ color: DECK_LIT, width: 2.4 });

  /*
   * Rails down both sides, with posts.
   *
   * Drawn the same way as the roadside fences, because they are the same thing
   * doing the same job, and a bridge whose rail is a different timber from the
   * fence twenty tiles away reads as two different countries.
   */
  for (const side of [-1, 1]) {
    const POSTS = Math.max(3, Math.round(crossing.span));
    const RAIL_H = 15;
    for (let post = 0; post <= POSTS; post += 1) {
      const along = -half + (crossing.span * post) / POSTS;
      const foot = at(along, wide * side);
      deck.rect(foot.x - 2, foot.y - RAIL_H, 4, RAIL_H).fill({ color: RAIL });
      deck.rect(foot.x - 2, foot.y - RAIL_H, 1.6, RAIL_H).fill({ color: RAIL_LIT });
    }
    const start = at(-half, wide * side);
    const end = at(half, wide * side);
    deck
      .moveTo(start.x, start.y - RAIL_H)
      .lineTo(end.x, end.y - RAIL_H)
      .stroke({ color: RAIL, width: 3.4, cap: "round" });
    deck
      .moveTo(start.x, start.y - RAIL_H - 1.2)
      .lineTo(end.x, end.y - RAIL_H - 1.2)
      .stroke({ color: RAIL_LIT, width: 1.2, cap: "round" });
  }

  return deck;
}

/**
 * Every bridge on the map, into the layer everything standing on the ground
 * shares, each at the depth of the water it crosses.
 */
export function buildBridges(into: Container): number {
  const found = crossings();
  for (const crossing of found) {
    const deck = drawBridge(crossing);
    const at = toScreen(crossing.x, crossing.y);
    deck.position.set(at.x, at.y);
    /*
     * Just under the depth of its own middle. A bridge is walked over, so
     * anybody on it has to draw in front of it, and they are at the depth of
     * wherever on it they are standing.
     */
    deck.zIndex = depthOf(crossing.x, crossing.y, -TILE_W);
    into.addChild(deck);
  }
  return found.length;
}
