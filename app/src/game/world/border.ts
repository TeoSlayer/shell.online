import { MAP } from "./marches";
import { TILE_H, TILE_W } from "./iso";

/**
 * The wood that closes the Marches in.
 *
 * Zoomed out, the country was a diamond of grass floating in a flat void, with
 * the four corners of the view showing the colour the renderer happens to clear
 * to. That reads as an unfinished map rather than as a place with edges -- the
 * player is not looking at the end of the world, they are looking at the end of
 * the *tiles*, and those are different things.
 *
 * So the country ends in forest. A dark canopy is laid under everything and
 * carried well past the playable bounds, and trees are scattered over whatever
 * of it is not covered by the map, thickest right against the edge so the hard
 * diamond line disappears under branches.
 *
 * This is measured in screen units rather than tiles, unlike the rest of
 * `world/`. The thing being filled is the *shape the projection makes*, which
 * is a diamond inscribed in a rectangle, and the corners to be covered are not
 * tiles at all -- there is no tile coordinate for them. Working in tiles here
 * would mean extending the grid four times over to reach ground nobody can
 * walk on.
 */

/** The playable country, projected: a diamond this wide and this tall. */
export const COUNTRY = {
  width: MAP.width * TILE_W,
  height: MAP.height * TILE_H,
};

/**
 * How far past the country the wood is carried.
 *
 * Nearly twice the country's own width, which sounds absurd and is not. At the
 * widest zoom the country is shorter than the window and pixi-viewport centres
 * a world smaller than its view, so what is beyond the country is what fills
 * the bands above and below -- and on a wide or a tall window those bands are
 * large. The first number here was chosen from the arithmetic for one window
 * size and left the corners of a different one showing the clear colour.
 *
 * It costs nothing to be generous. The whole of this is baked into one texture
 * whose size is fixed by the bake scale, not by the area it covers.
 */
export const OVERHANG = 7600;

export type Standing = "tree" | "rock" | "ruin";

export interface Tree {
  /** Screen position, in world units. */
  x: number;
  y: number;
  sprite: string;
  scale: number;
  /** 0 against the country, 1 deep in the wood. Drives how dark it is drawn. */
  depth: number;
  /** What it is, which decides how big and how dark it is drawn. */
  kind: Standing;
}

/**
 * What stands in the border wood.
 *
 * Old growth: the trees out here are drawn at roughly twice the size of the
 * ones inside the country. That is the whole difference between a hedge and a
 * forest -- a barrier you could walk through is not a barrier, and at the zoom
 * where the edge of the map matters, small trees read as scrub.
 */
const TREES = ["Environment_01", "Environment_02", "Environment_03", "Environment_21"];

/** Boulders, the big ones. The small stones belong in the country, not here. */
const ROCKS = ["Environment_07", "Environment_08", "Environment_09", "Environment_10", "Environment_11"];

/**
 * Ruins: whatever stood here before the Marches did.
 *
 * Kenney's pack has no broken wall, so these are its stone buildings drawn dark
 * and half-swallowed by the trees around them. A whole building at the edge of
 * the world would read as a place you can go; one glimpsed between trunks, in
 * shadow, reads as something older than the map.
 */
const RUINS = ["Structure_12", "Structure_05", "Structure_06"];

/** The murmur3 finaliser; see the note in world/scatter.ts about the cheap one. */
function noise(x: number, y: number, channel: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(channel + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/**
 * How far outside the country a point is: 0 on the edge, 1 well beyond it.
 *
 * The projection makes a diamond, so "outside" is the taxicab distance from the
 * middle in units of the half-width and half-height, which is exactly what
 * makes the four sides straight.
 */
export function beyond(x: number, y: number): number {
  const halfWidth = COUNTRY.width / 2;
  const halfHeight = COUNTRY.height / 2;
  const reach =
    Math.abs(x - halfWidth) / halfWidth + Math.abs(y - halfHeight) / halfHeight;
  return reach - 1;
}

/**
 * The rectangle the canopy covers: the country's bounds, plus the overhang.
 *
 * Returned rather than computed twice, because the layer that fills it and the
 * loop that scatters trees over it have to agree exactly. A canopy one pixel
 * smaller than the trees standing on it is a hairline of void at the edge of
 * the screen, which is the whole fault this file exists to fix.
 */
export function canopyBounds(): { x: number; y: number; width: number; height: number } {
  return {
    x: -OVERHANG,
    y: -OVERHANG,
    width: COUNTRY.width + OVERHANG * 2,
    height: COUNTRY.height + OVERHANG * 2,
  };
}

/**
 * How far out of the country real tree sprites are placed.
 *
 * Narrow, and the number came from a frame counter rather than from taste.
 * Scattering sprites over the whole canopy put four and a half thousand of them
 * on the map on top of the two thousand already in the country, and the frame
 * rate went from fifty-six to eighteen. Every one of those is a display object
 * whose transform is walked each frame, whether or not it is on screen and
 * whether or not it ever moves.
 *
 * Sprites earn their cost only where they are doing something a flat shape
 * cannot: breaking up the straight edge of the projection, which happens within
 * a few tree-widths of it. Beyond that the wood is drawn, not built -- see
 * `canopyBlobs`.
 */
const BAND = 520;

/**
 * How big each thing in the wood is drawn, against the country's own scatter.
 *
 * Everything here is larger than its counterpart inside the map. The wood is
 * meant to be impassable, and the reading of "impassable" is entirely a matter
 * of how big the trunks are next to a figure who is thirty pixels tall.
 */
const SIZE: Record<Standing, { from: number; to: number }> = {
  tree: { from: 1.5, to: 2.4 },
  rock: { from: 1.1, to: 1.9 },
  ruin: { from: 1.0, to: 1.5 },
};

const NEAR = 46;

/**
 * Where the border trees stand: in a thicket hugging the country, and nowhere
 * else.
 */
export function borderTrees(): Tree[] {
  const bounds = canopyBounds();
  const trees: Tree[] = [];

  for (let y = bounds.y; y < bounds.y + bounds.height; y += NEAR) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += NEAR) {
      /*
       * The treeline wanders rather than following the diamond exactly.
       *
       * A wood whose inner edge is a perfect straight line does not hide a
       * straight line, it draws a second one beside it. This pushes the edge in
       * and out by a couple of tiles, which is enough for the eye to stop
       * reading it as the boundary of a shape.
       */
      const wander = (noise(Math.round(x / 90), Math.round(y / 90), 7) - 0.5) * 0.05;
      const out = beyond(x, y) + wander;

      /*
       * A little inside the edge as well, so the trees straddle it. A border
       * that begins exactly where the grass stops draws attention to the line
       * it is meant to hide.
       */
      if (out < -0.02) continue;

      const distance = out * (COUNTRY.width / 2);
      if (distance > BAND) continue;

      const key = Math.round(x);
      const other = Math.round(y);
      const what = noise(key, other, 6);

      /*
       * Mostly trees, with boulders through it and the occasional ruin. The
       * ruins are rare on purpose: something you notice once and then look for
       * afterwards is worth more than something on every screen.
       */
      let kind: Standing = "tree";
      let list = TREES;
      if (what > 0.965) {
        kind = "ruin";
        list = RUINS;
      } else if (what > 0.84) {
        kind = "rock";
        list = ROCKS;
      }

      trees.push({
        x: x + (noise(key, other, 2) - 0.5) * NEAR,
        y: y + (noise(key, other, 3) - 0.5) * NEAR,
        sprite: list[Math.floor(noise(key, other, 4) * list.length) % list.length],
        scale: SIZE[kind].from + noise(key, other, 5) * (SIZE[kind].to - SIZE[kind].from),
        /* How far out it stands, so the renderer can put it further into shade. */
        depth: Math.min(1, Math.max(0, distance / BAND)),
        kind,
      });
    }
  }

  /*
   * Painter's order. Nothing walks out here, so there is no depth sorting to
   * do at runtime -- sorting once, now, is the whole of it.
   */
  trees.sort((first, second) => first.y - second.y);
  return trees;
}

export interface Blob {
  x: number;
  y: number;
  radius: number;
  /** Which of a few canopy tones it is drawn in. */
  tone: number;
}

/** How many tones the far canopy is drawn in. See `canopyBlobs`. */
export const CANOPY_TONES = 4;

/**
 * The wood beyond the thicket, as overlapping blobs rather than trees.
 *
 * At the zoom where any of this is visible, a tree is a few pixels of dark
 * green, and a few pixels of dark green is what this draws -- for a thousandth
 * of the cost, because every blob at a given tone goes into one path and the
 * whole far wood is three shapes rather than four thousand objects.
 *
 * Grouped into tones rather than shaded individually for the same reason: a
 * fill per blob would be thousands of draw instructions to build and to hold,
 * where three fills over thousands of paths is three.
 */
export function canopyBlobs(): Blob[] {
  const bounds = canopyBounds();
  const blobs: Blob[] = [];
  const STEP = 178;

  for (let y = bounds.y; y < bounds.y + bounds.height; y += STEP) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += STEP) {
      const distance = beyond(x, y) * (COUNTRY.width / 2);
      /* Starts inside the thicket, so the two overlap and there is no seam. */
      if (distance < BAND * 0.45) continue;

      const key = Math.round(x);
      const other = Math.round(y);
      blobs.push({
        x: x + (noise(key, other, 11) - 0.5) * STEP,
        y: y + (noise(key, other, 12) - 0.5) * STEP,
        radius: STEP * (0.46 + noise(key, other, 13) * 0.36),
        /*
         * The tone is mostly noise, with a nudge darker further out.
         *
         * It was purely distance at first, which meant everything past a couple
         * of thousand units fell in the darkest tone and the far wood came out
         * as one flat colour -- exactly the flat field the whole border exists
         * to replace, in a different green. Noise is what makes canopy read as
         * canopy; the distance term only leans it.
         */
        tone: Math.min(
          CANOPY_TONES - 1,
          Math.floor(
            (noise(key, other, 14) * 0.78 + Math.min(1, distance / 5200) * 0.22) *
              CANOPY_TONES * 0.999,
          ),
        ),
      });
    }
  }

  return blobs;
}
