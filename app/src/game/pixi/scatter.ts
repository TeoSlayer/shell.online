import { Container, Graphics, Sprite } from "pixi.js";
import { scatterProps, type Prop } from "../world/scatter";
import { depthOf, TILE_H, toScreen } from "../world/iso";
import type { Loaded } from "./scene";

/**
 * The woods and the boulder fields, as sprites.
 *
 * Two things are done differently here from the way a building is placed, and
 * both are because there are a couple of thousand of these rather than forty.
 *
 * Each prop is one Sprite and nothing else. `standing()` gives a building a
 * Container holding a shadow and a sprite, which is three display objects for
 * every tree; at this count that is thousands of transforms to walk every
 * frame to draw something that never moves.
 *
 * And the shadows go into one Graphics handed back to the ground layer. A
 * shadow lying on flat earth cannot move, cannot be walked in front of, and
 * never needs sorting with anything -- so it belongs with the ground, drawn
 * once, rather than with the things that are sorted by depth twice a second.
 *
 * What is *not* done here is culling. Pixi batches these into a handful of draw
 * calls and the map is not big enough for the off-screen ones to matter; adding
 * a quadtree to skip them would be work spent on a number nobody has measured.
 */

export interface Scatter {
  /** The props' shadows, flat, to go into the ground. */
  shadows: Graphics;
  count: number;
}

/**
 * `into` takes the sprites directly rather than a container holding them.
 *
 * A container of props would sort as one thing against everything else, at
 * whatever depth that container happened to have -- so every tree on the map
 * would be behind every building, including the trees standing in front of
 * one. Depth is per sprite, so the sprites have to be siblings of the
 * buildings and the people.
 */
export function buildScatter(art: Loaded, into: Container): Scatter {
  const shadows = new Graphics();
  const placed: Prop[] = scatterProps();

  for (const prop of placed) {
    const { x, y } = toScreen(prop.x, prop.y);
    const texture = art.frame(prop.sprite);

    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(prop.scale);
    sprite.position.set(x, y + TILE_H * 0.2);
    sprite.zIndex = depthOf(prop.x, prop.y);
    into.addChild(sprite);

  }

  return { shadows, count: placed.length };
}
