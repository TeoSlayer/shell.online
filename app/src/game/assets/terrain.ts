import type { Sprite } from "./sprite";

/**
 * The ground, seen from above.
 *
 * The camera looks down at the holding rather than across at it, so these are
 * a floor rather than a backdrop. That change is what removed the sky: half
 * the frame was empty air, and there is no air in a view from above.
 *
 * Generated rather than drawn, but not random. The scatter comes from a hash
 * of the coordinate, so a tile is the same every time the page loads — a field
 * that reshuffled itself on reload would be unsettling in exactly the way a
 * base you are fortifying should not be.
 */

export const TILE = 16;

/** A small, fast, well-mixed integer hash. Deterministic is the requirement. */
export function hash(x: number, y: number, seed: number): number {
  let value = (x * 374_761_393 + y * 668_265_263 + seed * 2_246_822_519) | 0;
  value = (value ^ (value >>> 13)) * 1_274_126_177;
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

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

/**
 * Meadow, in four cuts.
 *
 * One grass tile repeated across a whole window is a chequerboard: the eye
 * finds the period within a second and the ground stops being ground. Four
 * variants chosen by position break the rhythm, and because the choice comes
 * from a hash of the tile's place in the world, the field is still the same
 * field every time it is drawn.
 *
 * Tufts rather than speckle. Per-pixel noise reads as static; a tuft is a
 * short vertical run, which at this size is the smallest mark the eye will
 * accept as a plant.
 */
function meadow(seed: number, density: number): Sprite {
  return generateTile("field", seed, (noise, x, y) => {
    const tuft = hash(x, Math.floor(y / 3), seed * 7 + 1);
    if (tuft > 1 - density && y % 3 !== 0) return "6";
    if (tuft > 1 - density * 2 && y % 3 === 1) return "5";
    if (noise > 0.88) return "4";
    if (noise > 0.55) return "3";
    return "2";
  });
}

export const GRASS: Sprite = meadow(11, 0.07);
export const GRASS_B: Sprite = meadow(12, 0.04);
export const GRASS_C: Sprite = meadow(13, 0.1);

/** The same meadow with a few heads of warm flower in it. */
export const GRASS_FLOWER: Sprite = generateTile("field", 14, (noise, x, y) => {
  const bloom = hash(Math.floor(x / 4), Math.floor(y / 4), 99);
  if (bloom > 0.93 && x % 4 === 1 && y % 4 === 1) return "e";
  if (bloom > 0.93 && x % 4 === 1 && y % 4 === 2) return "5";
  const tuft = hash(x, Math.floor(y / 3), 78);
  if (tuft > 0.93 && y % 3 !== 0) return "6";
  if (noise > 0.88) return "4";
  if (noise > 0.55) return "3";
  return "2";
});

/** Every cut of meadow, for a caller picking one by position. */
export const MEADOW: Sprite[] = [GRASS, GRASS_B, GRASS_C, GRASS_FLOWER];

/**
 * Trodden earth: the yard immediately around the keep, and the roads out.
 *
 * Ruts run along the road so it reads as a direction rather than as a patch,
 * with stones pressed into it where it has worn through.
 */
export const DIRT: Sprite = generateTile("field", 21, (noise, x, y) => {
  const rut = hash(Math.floor(x / 4), y, 31);
  if (rut > 0.9) return "8";
  if (noise > 0.94) return "b";
  if (noise > 0.78) return "a";
  if (noise > 0.4) return "9";
  return "8";
});

/** The same road, more worn, so a long run of it is not one sprite repeated. */
export const DIRT_B: Sprite = generateTile("field", 22, (noise, x, y) => {
  const rut = hash(Math.floor(x / 3), y, 33);
  if (rut > 0.88) return "8";
  if (noise > 0.9) return "b";
  if (noise > 0.7) return "a";
  if (noise > 0.35) return "9";
  return "8";
});

export const ROAD: Sprite[] = [DIRT, DIRT_B];

/**
 * Laid flagstone, for the courtyard inside the walls.
 *
 * The joints are offset course by course, like real paving. An earlier version
 * lined them up in both directions and the ground read as graph paper. Each
 * stone gets a lit top edge and a shadowed bottom one, which is what makes it
 * look laid rather than printed.
 */
export const FLAGSTONE: Sprite = generateTile("stone", 31, (noise, x, y) => {
  const course = Math.floor(y / 8);
  const shifted = (x + course * 4) % 8;
  if (y % 8 === 0) return "6";
  if (y % 8 === 7) return "3";
  if (shifted === 0) return "3";
  if (noise > 0.9) return "6";
  if (noise > 0.66) return "5";
  return "4";
});

/** A second cut, with a cracked stone or two in it. */
export const FLAGSTONE_B: Sprite = generateTile("stone", 32, (noise, x, y) => {
  const course = Math.floor(y / 8);
  const shifted = (x + course * 4) % 8;
  const cracked = hash(Math.floor(x / 8), course, 51) > 0.7;
  if (cracked && shifted === 4 && y % 8 > 1 && y % 8 < 7) return "3";
  if (y % 8 === 0) return "6";
  if (y % 8 === 7) return "3";
  if (shifted === 0) return "3";
  if (noise > 0.88) return "6";
  if (noise > 0.6) return "5";
  return "4";
});

export const PAVING: Sprite[] = [FLAGSTONE, FLAGSTONE_B];

/**
 * The kerb where the paving meets the grass.
 *
 * A hard edge between two ground textures is the thing that most makes a map
 * look assembled out of tiles. A course of dressed stone along the join is
 * what a real yard would have, and it hides the seam at the same time.
 */
export const KERB: Sprite = generateTile("stone", 41, (noise, _x, y) => {
  if (y < 2) return "3";
  if (y < 4) return "5";
  if (y < 5) return "6";
  if (noise > 0.9) return "6";
  if (noise > 0.66) return "5";
  return "4";
});

/**
 * Where something was knocked down and not yet rebuilt.
 *
 * Chunks rather than static: the noise is quantised into two-pixel blocks so
 * the eye can resolve them as broken stone.
 */
export const RUBBLE: Sprite = generateTile("stone", 14, (_noise, x, y) => {
  const lump = hash(Math.floor(x / 2), Math.floor(y / 2), 41);
  if (lump > 0.88) return "4";
  if (lump > 0.64) return "3";
  if (lump > 0.3) return "2";
  return "1";
});

export const TERRAIN = {
  grass: GRASS,
  dirt: DIRT,
  flagstone: FLAGSTONE,
  rubble: RUBBLE,
  kerb: KERB,
} as const;

export type TerrainName = keyof typeof TERRAIN;
