import { Container, Graphics } from "pixi.js";
import { BANNER_RADIUS } from "../world/banners";
import { TILE_H, TILE_W, toScreen } from "../world/iso";
import type { Sim } from "../world/sim";

/**
 * How far an Unmade reaches, drawn small and red.
 *
 * Tiny on purpose. A hero's ring says "this is a company and it is mine"; this
 * one says "this thing bites, and only this close". At the same weight the map
 * would be a field of overlapping circles and neither would mean anything.
 */
const FOE_RADIUS = 1.6;

/**
 * The mark left where the ground was clicked.
 *
 * It exists because an order is otherwise invisible for the second it takes the
 * hero to turn round: you press, nothing appears to happen, and you press
 * again. A ring that opens and fades is the smallest thing that answers the
 * press immediately, and it says *where* rather than merely *yes*.
 */
export class OrderMark {
  private readonly shape = new Graphics();
  private at = { x: 0, y: 0 };
  private life = 0;

  constructor(parent: Container) {
    parent.addChild(this.shape);
  }

  /** Tile coordinates, because that is what a click is turned into. */
  show(x: number, y: number): void {
    this.at = { x, y };
    this.life = 1;
  }

  tick(deltaMs: number): void {
    if (this.life <= 0) {
      this.shape.visible = false;
      return;
    }
    /* Six tenths of a second: long enough to see, short enough not to litter. */
    this.life = Math.max(0, this.life - deltaMs / 600);

    const open = 1 - this.life;
    const { x, y } = toScreen(this.at.x, this.at.y);
    const across = TILE_W * (0.35 + open * 0.75);

    this.shape.visible = true;
    this.shape.clear();
    this.shape
      .ellipse(x, y, across, across * (TILE_H / TILE_W))
      .stroke({ color: 0xf0d9a8, width: 3, alpha: this.life * 0.9 });
    /* A second, tighter ring a beat behind, so it reads as a pulse. */
    this.shape
      .ellipse(x, y, across * 0.55, across * 0.55 * (TILE_H / TILE_W))
      .stroke({ color: 0xe8b44a, width: 2, alpha: this.life * 0.6 });
  }

  destroy(): void {
    this.shape.destroy();
  }
}

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
      const foe = actor.side === "unmade";
      if (!foe && (actor.role !== "hero" || !actor.heroUid)) continue;
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

      const { x, y } = toScreen(actor.x, actor.y);
      ring.shape.clear();

      if (foe) {
        /*
         * Small, but not faint. The first version was nearly transparent on the
         * theory that a crowd of them would be noise; what it actually did was
         * make the one thing on the map that can hurt you the hardest thing on
         * it to see.
         */
        ring.shape
          .ellipse(x, y, (FOE_RADIUS * TILE_W) / 2, (FOE_RADIUS * TILE_H) / 2)
          .fill({ color: 0xd4553f, alpha: 0.42 })
          .stroke({ color: 0xff6a4d, width: 2.5, alpha: 1 });
        continue;
      }

      const colour = sim.banners.get(actor.heroUid ?? "") ?? 0xffffff;
      const yours = actor.heroUid === sim.youUid;
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
