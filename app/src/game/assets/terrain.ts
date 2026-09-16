import type { Sprite } from "./sprite";

/**
 * Ground tiles, generated rather than drawn.
 *
 * The structures and the characters below are authored by hand, because their
 * silhouettes are the whole point of them. Ground is not: a turf tile is a
 * base colour with speckles, and sixteen rows of hand-counted speckles is a
 * miscount waiting to happen for no gain in how it looks.
 *
 * Generated, but not random. The scatter comes from a hash of the coordinate,
 * so a tile is the same every time the page loads -- a field that reshuffled
 * itself on reload would be unsettling in exactly the way a base you are
 * fortifying should not be.
 */

export const TILE = 16;

/** A small, fast, well-mixed integer hash. Deterministic is the requirement. */
function hash(x: number, y: number, seed: number): number {
  let value = (x * 374_761_393 + y * 668_265_263 + seed * 2_246_822_519) | 0;
  value = (value ^ (value >>> 13)) * 1_274_126_177;
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

/**
 * Builds a tile from a function of position.
 *
 * Exported because the same shape serves turf, flagstone and rubble; only the
 * speckle rule differs.
 */
export function generateTile(
  palette: Sprite["palette"],
  seed: number,
  pick: (noise: number, x: number, y: number) => string,
): Sprite {
  const rows: string[] = [];
  for (let y = 0; y < TILE; y += 1) {
    let row = "";
    for (let x = 0; x < TILE; x += 1) row += pick(hash(x, y, seed), x, y);
    rows.push(row);
  }
  return { w: TILE, h: TILE, palette, rows };
}

/** Moss over old stone: what the keep stands on. */
export const TURF: Sprite = generateTile("keep", 1, (noise) => {
  if (noise > 0.94) return "a";
  if (noise > 0.86) return "8";
  return "9";
});

/**
 * The courtyard, worn flat.
 *
 * The first version put a one-pixel mortar line every eight pixels in both
 * directions, which at sixteen pixels square meant a hard cross through the
 * middle of every tile -- laid out, it read as graph paper rather than as
 * paving. The joints are now offset course by course, like real paving is, and
 * only a shade darker than the stone rather than the darkest colour available.
 */
export const FLAGSTONE: Sprite = generateTile("keep", 2, (noise, x, y) => {
  const course = Math.floor(y / 8);
  /* Every other course is shifted half a stone, so the joints do not line up. */
  const joint = (x + course * 4) % 8 === 0 || y % 8 === 0;
  if (joint) return "2";
  if (noise > 0.92) return "4";
  if (noise > 0.72) return "3";
  return "3";
});

/**
 * Where something was knocked down and not yet rebuilt.
 *
 * Chunks rather than static. Per-pixel noise at this density read as a dead
 * television; quantising the noise into two-pixel blocks gives it lumps the
 * eye can resolve as broken stone.
 */
export const RUBBLE: Sprite = generateTile("keep", 3, (_noise, x, y) => {
  const lump = hash(Math.floor(x / 2), Math.floor(y / 2), 3);
  if (lump > 0.86) return "4";
  if (lump > 0.62) return "3";
  if (lump > 0.3) return "2";
  return "1";
});

export const TERRAIN = { turf: TURF, flagstone: FLAGSTONE, rubble: RUBBLE } as const;
export type TerrainName = keyof typeof TERRAIN;
