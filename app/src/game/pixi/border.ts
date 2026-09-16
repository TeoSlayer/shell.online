import { Container, Graphics, Sprite } from "pixi.js";
import type { Application } from "pixi.js";
import { borderTrees, canopyBlobs, canopyBounds, CANOPY_TONES, COUNTRY } from "../world/border";
import type { Loaded } from "./scene";

/**
 * The wood that closes the Marches in, as one layer under everything.
 *
 * It is not depth sorted and never will be. Nothing can walk out here -- the
 * camera clamp keeps the view on the country and the simulation keeps everybody
 * inside it -- so there is nothing for these trees to be in front of or behind.
 *
 * The far wood is baked into a single low-resolution texture at start-up and
 * drawn as one sprite for the rest of the session.
 *
 * That is not premature. The first version scattered tree sprites over the
 * whole canopy: four and a half thousand of them, and the frame rate went from
 * fifty-six to eighteen. Cutting it back to a thicket at the edge and drawing
 * the rest as blobs recovered thirty-nine, and measuring the pieces separately
 * showed the remaining cost was not object count at all -- it was overdraw. Two
 * shapes the size of the whole canopy, plus thousands of overlapping ellipses,
 * all of it behind a map that then painted over the middle of it.
 *
 * Baking removes every bit of that. The texture is deliberately coarse: it is
 * distant canopy, seen at the only zoom where any of it is visible, and blur is
 * what it should look like anyway.
 */

/**
 * How much smaller the baked canopy is than the ground it covers.
 *
 * A twelfth. The canopy is over thirteen thousand units across, so a full-size
 * bake would be a texture no machine should be asked for; at this scale it is
 * about eleven hundred pixels wide, and it looks like a wood.
 */
const BAKE = 1 / 12;

export function buildBorder(app: Application, art: Loaded): Container {
  const layer = new Container();
  const bounds = canopyBounds();

  /*
   * Everything that never changes, drawn once into one shape.
   *
   * The rectangle is deliberately larger than the world: at the widest zoom the
   * country is shorter than the window and the viewport centres it, so what is
   * beyond the country is what fills the bands above and below. Stopping at the
   * world bounds would put the void back one step further out, which is no
   * better for being further away.
   */
  const drawn = new Graphics();
  drawn.rect(bounds.x, bounds.y, bounds.width, bounds.height).fill({ color: 0x1f3318 });

  const blobs = canopyBlobs();
  const TONES = [0x24401c, 0x1d3417, 0x172a12];
  for (let tone = 0; tone < CANOPY_TONES; tone += 1) {
    let drew = false;
    for (const blob of blobs) {
      if (blob.tone !== tone) continue;
      drawn.ellipse(blob.x, blob.y, blob.radius, blob.radius * 0.62);
      drew = true;
    }
    if (drew) drawn.fill({ color: TONES[tone] });
  }

  /* A darker ring hugging the country, so the grass reads as a clearing. */
  drawn
    .rect(bounds.x, bounds.y, bounds.width, bounds.height)
    .poly([
      COUNTRY.width / 2, 0,
      COUNTRY.width, COUNTRY.height / 2,
      COUNTRY.width / 2, COUNTRY.height,
      0, COUNTRY.height / 2,
    ])
    .cut()
    .fill({ color: 0x14230f, alpha: 0.5 });

  const baked = app.renderer.generateTexture({ target: drawn, resolution: BAKE });
  const canopy = new Sprite(baked);
  canopy.position.set(bounds.x, bounds.y);
  canopy.width = bounds.width;
  canopy.height = bounds.height;
  layer.addChild(canopy);
  /* The shape has been photographed; keeping it would be keeping it twice. */
  drawn.destroy();

  /*
   * The thicket, as real sprites, because this is the part doing work a flat
   * shape cannot: breaking up the straight edge the projection makes.
   */
  for (const tree of borderTrees()) {
    const sprite = new Sprite(art.frame(tree.sprite));
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(tree.scale);
    sprite.position.set(tree.x, tree.y);
    /*
     * Darkened with distance. A wood lit exactly like the field it surrounds
     * reads as more field; the eye needs the edge of the map to be the edge of
     * the light. It also breaks up the grid the trees were placed on.
     */
    const shade = 1 - tree.depth * 0.55;
    const channel = (value: number) => Math.round(value * shade);
    sprite.tint = (channel(0x9f) << 16) | (channel(0xbf) << 8) | channel(0x8a);
    layer.addChild(sprite);
  }

  return layer;
}
