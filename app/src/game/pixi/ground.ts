import { Container, Graphics } from "pixi.js";
import { buildGround, GARRISONS, MAP, type Ground } from "../world/marches";
import { diamond, TILE_H, TILE_W, toScreen } from "./iso";

/**
 * The ground of the Marches, drawn once into one object.
 *
 * Four thousand tiles is far too many to leave as four thousand sprites: even
 * doing nothing, that is four thousand transforms to update every frame. They
 * are baked into a single Graphics instead, which the renderer uploads once
 * and then draws as one thing however far the view is moved or zoomed.
 *
 * The ground is drawn rather than textured because Kenney's terrain tiles are
 * square, meant for a square grid, and the map is diamonds. Flat diamonds with
 * a lit top edge and a shadowed bottom one read as a tilted floor at any zoom
 * and cost nothing to draw.
 */

/** Two tones per ground: the face, and the edge that catches the light. */
const COLOURS: Record<Ground, { face: number; lit: number; dark: number }> = {
  grass: { face: 0x5c8f3a, lit: 0x74ad4a, dark: 0x3f6b28 },
  dirt: { face: 0xa97b46, lit: 0xc2934f, dark: 0x825c33 },
  stone: { face: 0x8d8478, lit: 0xa79d8f, dark: 0x6b6459 },
  sand: { face: 0xd6bd82, lit: 0xe8d29b, dark: 0xb39c68 },
  water: { face: 0x35688f, lit: 0x4581ad, dark: 0x27506e },
};

/**
 * A little variation per tile, so a field of grass is not one flat colour.
 *
 * Deterministic, from the tile's own position, so the map looks the same every
 * time it is opened. A field that reshuffles itself on reload is unsettling in
 * a way nobody can name.
 */
function shade(base: number, tileX: number, tileY: number): number {
  let value = Math.imul(tileX * 374_761_393 + tileY * 668_265_263, 0x85ebca6b);
  value = (value ^ (value >>> 13)) >>> 0;
  const lift = ((value % 20) - 10) / 255;

  const r = Math.min(255, Math.max(0, ((base >> 16) & 255) + Math.round(lift * 255)));
  const g = Math.min(255, Math.max(0, ((base >> 8) & 255) + Math.round(lift * 255)));
  const b = Math.min(255, Math.max(0, (base & 255) + Math.round(lift * 255)));
  return (r << 16) | (g << 8) | b;
}

export function buildGroundLayer(): Container {
  const layer = new Container();
  const tiles = buildGround();
  const faces = new Graphics();
  const edges = new Graphics();

  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      const ground = tiles[y * MAP.width + x];
      const colour = COLOURS[ground];
      faces.poly(diamond(x, y)).fill({ color: shade(colour.face, x, y) });

      /*
       * The north-west edge only. Outlining every diamond turns the map into
       * graph paper; catching the light on one side of each tile is what makes
       * the floor read as tilted rather than as a pattern.
       */
      const { x: sx, y: sy } = toScreen(x, y);
      edges
        .moveTo(sx - TILE_W / 2, sy)
        .lineTo(sx, sy - TILE_H / 2)
        .stroke({ color: colour.lit, width: 1, alpha: 0.35 });
    }
  }

  layer.addChild(faces, edges);

  /*
   * A darker apron under each holding, so a garrison reads as a place that has
   * been cleared and settled rather than as a patch of different grass.
   */
  const aprons = new Graphics();
  for (const garrison of GARRISONS) {
    const { x, y } = toScreen(garrison.x, garrison.y);
    aprons.ellipse(x, y, garrison.radius * TILE_W * 0.62, garrison.radius * TILE_H * 0.62);
    aprons.fill({ color: 0x000000, alpha: 0.1 });
  }
  layer.addChildAt(aprons, 1);

  /*
   * The whole ground is static, so it is cached as a bitmap: Pixi renders it
   * once and afterwards draws a single texture. Without this the map costs
   * thousands of geometry batches on every frame at every zoom level.
   */
  layer.cacheAsTexture(true);
  return layer;
}
