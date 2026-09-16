import { Container, Graphics } from "pixi.js";
import { BANNER_RADIUS } from "../world/banners";
import { TILE_H, TILE_W, toScreen } from "../world/iso";
import type { Sim } from "../world/sim";

/**
 * The ground each hero commands, washed in their own colour.
 *
 * One ellipse per hero, following them. It exists so that a company reads as an
 * area rather than as a crowd, and so that your own is the one you can find
 * without reading anything -- which was the actual complaint behind "I cannot
 * control my hero". The controls worked; the map was unreadable, and from the
 * other side of the screen those are the same bug.
 *
 * Drawn on the ground plane, so it is an ellipse at the tile ratio rather than
 * a circle. A circle would read as a bubble floating over the field; a squashed
 * one reads as light on the grass.
 *
 * Redrawn only when somebody has moved far enough to matter. A hero walks at
 * under three tiles a second and this is nine tiles across, so redrawing it
 * every frame is redrawing the same shape sixty times to move it a pixel.
 */
export class Banners {
  private readonly layer = new Container();
  private readonly rings = new Map<string, { shape: Graphics; x: number; y: number }>();

  constructor(parent: Container) {
    parent.addChild(this.layer);
  }

  sync(sim: Sim): void {
    const seen = new Set<string>();

    for (const actor of sim.actors) {
      if (actor.role !== "hero" || !actor.heroUid) continue;
      seen.add(actor.id);

      let ring = this.rings.get(actor.id);
      if (!ring) {
        ring = { shape: new Graphics(), x: Number.NaN, y: Number.NaN };
        this.layer.addChild(ring.shape);
        this.rings.set(actor.id, ring);
      }

      /* A tenth of a tile: below what anybody can see it move by. */
      if (Math.abs(ring.x - actor.x) < 0.1 && Math.abs(ring.y - actor.y) < 0.1) continue;
      ring.x = actor.x;
      ring.y = actor.y;

      const colour = sim.banners.get(actor.heroUid) ?? 0xffffff;
      const yours = actor.heroUid === sim.youUid;
      const { x, y } = toScreen(actor.x, actor.y);

      ring.shape.clear();
      ring.shape
        .ellipse(x, y, (BANNER_RADIUS * TILE_W) / 2, (BANNER_RADIUS * TILE_H) / 2)
        /*
         * Your own company is washed a little stronger and rimmed a little
         * brighter. Never colour alone: yours is also the one the view opens
         * on, the one the HUD names, and the only one that answers a click.
         */
        .fill({ color: colour, alpha: yours ? 0.22 : 0.13 })
        .stroke({ color: colour, width: yours ? 3 : 2, alpha: yours ? 0.85 : 0.5 });
    }

    for (const [id, ring] of this.rings) {
      if (seen.has(id)) continue;
      ring.shape.destroy();
      this.rings.delete(id);
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}
