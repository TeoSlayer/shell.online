import { Container, Graphics } from "pixi.js";
import { GARRISONS, groundTiles, MAP, type Ground } from "../world/marches";
import { diamond, TILE_H, TILE_W, toScreen } from "../world/iso";

/**
 * The ground of the Marches, drawn once into a handful of objects.
 *
 * Sixteen thousand tiles is far too many to leave as sixteen thousand sprites:
 * even doing nothing, that is sixteen thousand transforms to update every
 * frame. They are baked into a few Graphics instead, which the renderer uploads
 * once and afterwards draws as a few things however far the view is moved.
 *
 * The ground is drawn rather than textured because Kenney's terrain tiles are
 * square, meant for a square grid, and the map is diamonds. Flat diamonds with
 * a lit north-west edge read as a tilted floor at any zoom and cost nothing.
 *
 * Two decisions here are about the size of the map rather than the look of it,
 * and both stopped mattering only once it was four times bigger:
 *
 * The tiles are grouped by colour before anything is drawn. A separate fill per
 * tile is sixteen thousand fill instructions to build and to hold; quantising
 * the per-tile variation into a few steps and collecting every tile that shares
 * a colour into one path brings that to a couple of dozen, and the picture is
 * the same one.
 *
 * And the layer is not cached as a texture. It used to be, which was right when
 * the map was 64 tiles across and the cache was a 4096x2048 bitmap. At 128 it
 * would be 8192x4096 -- 134 MB of video memory, and past the maximum texture
 * size on a good many machines, on which it would silently fail. Static
 * geometry is uploaded once and redrawn for almost nothing; a bitmap that large
 * is not.
 */

/** Two tones per ground: the face, and the edge that catches the light. */
const COLOURS: Record<Ground, { face: number; lit: number; dark: number }> = {
  grass: { face: 0x5c8f3a, lit: 0x74ad4a, dark: 0x3f6b28 },
  dirt: { face: 0xa97b46, lit: 0xc2934f, dark: 0x825c33 },
  stone: { face: 0x8d8478, lit: 0xa79d8f, dark: 0x6b6459 },
  sand: { face: 0xd6bd82, lit: 0xe8d29b, dark: 0xb39c68 },
  water: { face: 0x35688f, lit: 0x4581ad, dark: 0x27506e },
};

/** How many tones each ground is allowed. See the note about grouping above. */
const STEPS = 5;

/**
 * A little variation per tile, so a field of grass is not one flat colour.
 *
 * Deterministic, from the tile's own position, so the map looks the same every
 * time it is opened. A field that reshuffles itself on reload is unsettling in
 * a way nobody can quite name.
 */
function stepFor(tileX: number, tileY: number): number {
  /* The murmur3 finaliser. One round of mixing bands visibly across a field. */
  let h = Math.imul(tileX, 0x27d4eb2d) ^ Math.imul(tileY, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % STEPS;
}

/** The colour of one of those steps: a few points either side of the base. */
function toneOf(base: number, step: number): number {
  const lift = Math.round(((step - (STEPS - 1) / 2) / (STEPS - 1)) * 18);
  const r = Math.min(255, Math.max(0, ((base >> 16) & 255) + lift));
  const g = Math.min(255, Math.max(0, ((base >> 8) & 255) + lift));
  const b = Math.min(255, Math.max(0, (base & 255) + lift));
  return (r << 16) | (g << 8) | b;
}

export function buildGroundLayer(): Container {
  const layer = new Container();
  const tiles = groundTiles();

  /*
   * One path per (ground, tone), filled once at the end. Building the paths
   * first and filling afterwards is what turns sixteen thousand instructions
   * into twenty-five.
   */
  const faces = new Graphics();
  const byTone = new Map<string, { ground: Ground; step: number; tiles: number[][] }>();

  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      const ground = tiles[y * MAP.width + x];
      const step = stepFor(x, y);
      const key = `${ground}:${step}`;
      let bucket = byTone.get(key);
      if (!bucket) {
        bucket = { ground, step, tiles: [] };
        byTone.set(key, bucket);
      }
      bucket.tiles.push(diamond(x, y));
    }
  }

  for (const bucket of byTone.values()) {
    for (const points of bucket.tiles) faces.poly(points);
    faces.fill({ color: toneOf(COLOURS[bucket.ground].face, bucket.step) });
  }

  /*
   * The north-west edge of each tile, one path per ground. Outlining every
   * diamond turns the map into graph paper; catching the light on one side is
   * what makes the floor read as tilted rather than as a pattern.
   */
  const edges = new Graphics();
  const byGround = new Map<Ground, number[][]>();
  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      const ground = tiles[y * MAP.width + x];
      const { x: sx, y: sy } = toScreen(x, y);
      const lines = byGround.get(ground) ?? [];
      lines.push([sx - TILE_W / 2, sy, sx, sy - TILE_H / 2]);
      byGround.set(ground, lines);
    }
  }
  for (const [ground, lines] of byGround) {
    for (const [ax, ay, bx, by] of lines) edges.moveTo(ax, ay).lineTo(bx, by);
    edges.stroke({ color: COLOURS[ground].lit, width: 1, alpha: 0.35 });
  }

  /*
   * A darker apron under each holding, so a garrison reads as a place that has
   * been cleared and settled rather than as a patch of different grass.
   */
  const aprons = new Graphics();
  for (const garrison of GARRISONS) {
    const { x, y } = toScreen(garrison.x, garrison.y);
    aprons.ellipse(x, y, garrison.radius * TILE_W * 0.62, garrison.radius * TILE_H * 0.62);
  }
  aprons.fill({ color: 0x000000, alpha: 0.1 });

  layer.addChild(faces, aprons, edges);
  return layer;
}
