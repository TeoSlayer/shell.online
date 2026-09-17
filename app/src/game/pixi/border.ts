import { Container, Graphics, Sprite } from "pixi.js";
import { depthAtScreenY } from "../world/iso";
import type { Application } from "pixi.js";
import { borderTrees, canopyBlobs, canopyBounds, CANOPY_TONES } from "../world/border";
import type { Kingdom, Loaded } from "./scene";

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

export interface Border {
  /** The far wood, which goes under the map. */
  canopy: Container;
}

export function buildBorder(
  app: Application,
  art: Loaded,
  kingdom: Kingdom,
  /*
   * The sorted layer the edge trees join, rather than a container of their own.
   *
   * They used to be one sibling drawn before every building, which meant a tree
   * at the near corner of the diamond -- the corner the camera looks at, so the
   * nearest thing on the map -- was painted behind a building at the far one.
   * Depth on this map is `x + y`, and it can only decide anything between
   * siblings, so everything standing on the ground has to be one.
   */
  into: Container,
): Border {
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
  /*
   * Four greens, spread wide enough to see.
   *
   * The first set were within a few points of each other and of the fill behind
   * them, which made the far wood one flat colour at every zoom -- exactly the
   * flat field the border exists to replace, in a different green. Canopy is
   * read by its mottling, so the mottling has to be visible.
   */
  /*
   * Four greens, spread wide enough to see.
   *
   * The first set were within a few points of each other and of the fill behind
   * them, which made the far wood one flat colour -- exactly the flat field the
   * border exists to replace, in a different green. Canopy is read by its
   * mottling, so the mottling has to be visible.
   */
  const TONES = [0x395d2a, 0x2c4921, 0x203819, 0x182b12];
  for (let tone = 0; tone < CANOPY_TONES; tone += 1) {
    let drew = false;
    for (const blob of blobs) {
      if (blob.tone !== tone) continue;
      drawn.ellipse(blob.x, blob.y, blob.radius, blob.radius * 0.62);
      drew = true;
    }
    if (drew) drawn.fill({ color: TONES[tone] });
  }

  /*
   * There is deliberately no darker ring cut around the country here.
   *
   * There was one, drawn as this rectangle with the country's diamond `cut()`
   * out of it, and it quietly destroyed everything above: the whole far wood
   * rendered as one flat colour, the last one filled. Every tone was being
   * built correctly -- a count of the blobs showed all four evenly spread --
   * and none of them survived into the picture.
   *
   * Whatever the exact mechanism inside the path builder, the lesson is the
   * cheap one: a boolean path operation in a context that already holds
   * thousands of filled subpaths is not a local edit, and this context holds
   * about fourteen thousand. The recession it was drawing is done by the tone
   * gradient instead, which costs nothing and cannot reach backwards.
   */

  const baked = app.renderer.generateTexture({ target: drawn, resolution: BAKE });
  const canopy = new Sprite(baked);
  canopy.position.set(bounds.x, bounds.y);
  canopy.width = bounds.width;
  canopy.height = bounds.height;
  layer.addChild(canopy);
  /* The shape has been photographed; keeping it would be keeping it twice. */
  drawn.destroy();

  /*
   * The thicket, as real sprites: this is the part doing work a flat shape
   * cannot, which is breaking up the straight edge the projection makes.
   *
   * Two sets of conifers rather than one, because a wood of a single silhouette
   * repeated a thousand times reads as wallpaper however well it is drawn.
   */
  const conifers = [
    "pine-dark",
    "pine-tall",
    "pine-broad",
    /*
     * And two more from the same nature pack, in sage rather than near-black.
     *
     * The wood was three dark silhouettes repeated, which at dusk turned the
     * whole edge of the map into one black band -- a wall rather than a wood.
     * These are drawn in sage rather than near-black, so the treeline has some
     * depth in it and the eye can still tell one trunk from the next.
     */
    "pine-light-a",
    "pine-light-b",
  ]
    .map((name) => kingdom.get(name))
    .filter((texture): texture is NonNullable<typeof texture> => texture !== undefined);

  borderTrees().forEach((tree, index) => {
    const outsider = conifers.length > 0 && tree.kind === "tree" && index % 3 === 0;
    const sprite = new Sprite(
      outsider ? conifers[index % conifers.length] : art.frame(tree.sprite),
    );
    sprite.anchor.set(0.5, 1);
    /*
     * The two sets are drawn at very different sizes -- Kenney's are sprites
     * cut to a tile, these are vector art at whatever the artboard was -- so
     * the imported ones are scaled against their own height rather than sharing
     * a number that happens to suit the others.
     */
    /*
     * Three times over for the imported conifers. They were drawn to the same
     * height as Kenney's, which wasted what they are for: these are the tall
     * dark shapes that give the wood its depth, and at the same height as
     * everything else they were just more trees.
     */
    sprite.scale.set(outsider ? (tree.scale * 330) / sprite.texture.height : tree.scale);
    sprite.position.set(tree.x, tree.y);
    /*
     * Darkened with distance. A wood lit exactly like the field it surrounds
     * reads as more field; the eye needs the edge of the map to be the edge of
     * the light. It also breaks up the grid the trees were placed on.
     */
    const shade = 1 - tree.depth * 0.34;
    /*
     * Stone takes the light differently from leaves, and a ruin is darker again
     * -- it is meant to be half-seen between trunks rather than presented.
     */
    const base = tree.kind === "tree" ? 0x9fbf8a : tree.kind === "rock" ? 0xa8a79c : 0x6f6f68;
    const channel = (shift: number) => Math.round(((base >> shift) & 0xff) * shade);
    sprite.tint = (channel(16) << 16) | (channel(8) << 8) | channel(0);
    /*
     * Placed in screen space, so the depth comes from where it landed. The
     * trees straddle the edge of the country on purpose; one at the bottom of
     * that edge is nearer the camera than anything inland and now draws like
     * it.
     */
    sprite.zIndex = depthAtScreenY(tree.y);
    into.addChild(sprite);
  });

  return { canopy: layer };
}
