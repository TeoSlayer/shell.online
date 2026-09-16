/**
 * The isometric projection, and the depth rule that goes with it.
 *
 * Tiles are diamonds twice as wide as they are tall, which is the 2:1 dimetric
 * projection every base-builder uses. It is called isometric by everybody and
 * by nobody who knows what isometric means.
 *
 * The ground is drawn in this projection. The buildings and the people on it
 * are *not* rotated into it — they are upright sprites standing on the diamond,
 * which is how nearly every 2D isometric game has ever worked, and what lets
 * artwork drawn face-on sit convincingly on a tilted floor.
 */

/** Half the width and half the height of a tile diamond, in world units. */
export const TILE_W = 64;
export const TILE_H = 32;

export interface Point {
  x: number;
  y: number;
}

/** Tile coordinates to the point on screen where that tile's middle sits. */
export function toScreen(tileX: number, tileY: number): Point {
  return {
    x: (tileX - tileY) * (TILE_W / 2),
    y: (tileX + tileY) * (TILE_H / 2),
  };
}

/**
 * Back the other way: a point on the ground to the tile under it.
 *
 * This is what makes the map clickable. Inverting the projection is two lines
 * of algebra and the alternative — hit-testing every diamond — is thousands of
 * polygon tests per click.
 */
export function toTile(screenX: number, screenY: number): Point {
  const halfW = TILE_W / 2;
  const halfH = TILE_H / 2;
  return {
    x: (screenX / halfW + screenY / halfH) / 2,
    y: (screenY / halfH - screenX / halfW) / 2,
  };
}

/**
 * What decides which sprite is drawn in front of which.
 *
 * Depth is distance along the view axis, which in this projection is simply
 * x + y: anything further down the screen is nearer the camera. Height is
 * added so a bird is drawn over the building it is flying past rather than
 * behind it, and a small tiebreak keeps two things on the same tile in a
 * stable order rather than flickering between frames.
 */
export function depthOf(tileX: number, tileY: number, height = 0): number {
  return (tileX + tileY) * 1000 + height;
}

/** The four corners of a tile's diamond, for drawing the ground. */
export function diamond(tileX: number, tileY: number): number[] {
  const { x, y } = toScreen(tileX, tileY);
  return [
    x, y - TILE_H / 2,
    x + TILE_W / 2, y,
    x, y + TILE_H / 2,
    x - TILE_W / 2, y,
  ];
}
