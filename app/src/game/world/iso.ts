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
import { MAP } from "./marches";

/** Half the width and half the height of a tile diamond, in world units. */
export const TILE_W = 64;
export const TILE_H = 32;

/**
 * How far right the projection is pushed so that no part of the map is at a
 * negative coordinate.
 *
 * A diamond grid laid out from the origin runs half its width into negative x,
 * because tile (0, n) is as far left as tile (n, 0) is right. That is fine for
 * drawing and useless for a camera: pixi-viewport describes its world as a box
 * from (0, 0) to (worldWidth, worldHeight), so a map that starts at -2048
 * cannot be clamped, and zooming out sent the whole country sliding into a
 * corner of an empty screen. Shifting here rather than moving a container
 * means every coordinate in the game agrees, including the one a click is
 * turned back into.
 */
export const ORIGIN_X = MAP.width * (TILE_W / 2);

export interface Point {
  x: number;
  y: number;
}

/** Tile coordinates to the point on screen where that tile's middle sits. */
export function toScreen(tileX: number, tileY: number): Point {
  return {
    x: (tileX - tileY) * (TILE_W / 2) + ORIGIN_X,
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
  const x = screenX - ORIGIN_X;
  return {
    x: (x / halfW + screenY / halfH) / 2,
    y: (screenY / halfH - x / halfW) / 2,
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

/**
 * The same depth, for something whose screen position is known and whose tile
 * is not.
 *
 * `toScreen` puts a tile at `y = (x + y) * TILE_H / 2`, so screen y *is* depth
 * up to that constant -- which is the whole of the perspective on this map:
 * the camera looks at the bottom corner of the diamond, so the further down the
 * screen a thing stands, the nearer it is and the later it must be drawn.
 */
export function depthAtScreenY(screenY: number, height = 0): number {
  return (screenY / (TILE_H / 2)) * 1000 + height;
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
