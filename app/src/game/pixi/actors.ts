import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { depthOf, TILE_H, toScreen } from "./iso";
import type { Loaded } from "./scene";
import type { Actor, Sim } from "../world/sim";

/**
 * The people on the map, and the things that got in.
 *
 * Pixi keeps a display object per actor for as long as that actor exists,
 * rather than rebuilding the scene each frame. That is the whole reason for
 * using a scene graph: moving a sprite is setting two numbers, where drawing
 * it again is uploading geometry.
 */

/**
 * Which unit sprite stands for which class.
 *
 * Kenney's pack has four colours of unit; they are used here to tell the
 * classes apart at a glance, which is what a colour is for on a map where
 * everything is the same size.
 */
const UNIT_FOR: Record<string, string> = {
  "claude-code": "Unit_05",
  codex: "Unit_01",
  hermes: "Unit_11",
  openclaw: "Unit_07",
  terminal: "Unit_17",
  soldier: "Unit_19",
  /* The Unmade get the darkest units, tinted below so they read as wrong. */
  mite: "Unit_21",
  crawler: "Unit_23",
  heisenbug: "Unit_09",
};

/** The Unmade are tinted cold; everything else on this map is warm. */
const UNMADE_TINT = 0x6fd6c0;

/** How much bigger than drawn a figure is. See `make`. */
const FIGURE = 1.25;

/** A few pixels of deterministic vertical stagger, so boards do not stack. */
function lift(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) {
    value = (Math.imul(value, 31) + id.charCodeAt(index)) | 0;
  }
  return (Math.abs(value) % 3) * 13;
}

interface Piece {
  root: Container;
  sprite: Sprite;
  shadow: Graphics;
  bar: Graphics;
  plate?: Container;
  lastHp: number;
}

export class ActorLayer {
  private readonly pieces = new Map<string, Piece>();

  /** The skin the player is wearing, washed over their own sessions' wrights. */
  private skinTint = 0xffffff;

  constructor(
    private readonly art: Loaded,
    private readonly parent: Container,
    /* Name boards go here, above the world, so nothing can stand in front. */
    private readonly labels: Container,
  ) {}

  /** The last zoom the plates were sized for; see `zoomed`. */
  private plateScale = 1;
  private platesShown = true;

  /** Called when a skin is bought or changed in the shop. */
  wear(tint: number): void {
    this.skinTint = tint;
  }

  /**
   * Keeps the name boards a readable size, and takes them away when they stop
   * being names and start being clutter.
   *
   * A board that scales with the map is illegible zoomed out and enormous
   * zoomed in; one that never scales covers the map at the far end. So it
   * scales against the zoom, within bounds, and below the point where a name
   * would be smaller than the floor this game holds itself to, there is no
   * name -- which is also the zoom at which you are looking at the country
   * rather than at anybody in it.
   */
  zoomed(scale: number): void {
    this.plateScale = Math.min(1.7, Math.max(0.6, 1 / scale));
    /*
     * Shown at every zoom the wheel allows. An earlier version hid them below
     * two thirds, which was a guess, and it turned out to be exactly the zoom
     * the opening view needs to get all six holdings on screen -- so the first
     * thing the game showed was a map with nobody named on it.
     */
    this.platesShown = scale > 0.44;
    for (const piece of this.pieces.values()) {
      if (!piece.plate) continue;
      piece.plate.scale.set(this.plateScale);
      piece.plate.visible = this.platesShown;
    }
  }

  private make(actor: Actor): Piece {
    const root = new Container();

    const shadow = new Graphics();
    shadow.ellipse(0, 0, 16, 7).fill({ color: 0x1a1008, alpha: 0.32 });
    root.addChild(shadow);

    const texture = this.art.frame(UNIT_FOR[actor.kind] ?? UNIT_FOR.terminal);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    /*
     * Drawn larger than the pack intends. Kenney's units are scaled to sit
     * beside Kenney's buildings, and at that ratio a wright on this map was a
     * speck next to a church -- correct, and useless, because the wrights are
     * the thing the game is about and the buildings are where they stand.
     */
    sprite.scale.set(FIGURE);
    sprite.position.set(0, TILE_H * 0.25);
    if (actor.side === "unmade") sprite.tint = UNMADE_TINT;
    root.addChild(sprite);

    /* Health, shown only once something has been taken off it. */
    const bar = new Graphics();
    bar.position.set(0, -sprite.height - 4);
    bar.visible = false;
    root.addChild(bar);

    /*
     * Only real sessions carry a name and only real sessions can be clicked.
     * The garrison's own soldiers are scenery; giving them plates would fill
     * the map with labels that stand for nothing.
     */
    let plate: Container | undefined;
    if (actor.session) {
      /*
       * A little board, for the same reason the garrison signs are boards: a
       * name in outlined text over grass, roofs and road was unreadable at the
       * worst of it, and the outline thick enough to fix that turned sixteen
       * point type to mud. It also stops two wrights standing near each other
       * from interleaving their names into one unreadable line.
       */
      const text = new Text({
        text: actor.name.length > 24 ? `${actor.name.slice(0, 23)}…` : actor.name,
        style: {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 16,
          fill: 0xf0d9a8,
        },
      });
      text.anchor.set(0.5, 0);
      text.position.set(0, 3);

      const board = new Graphics();
      board
        .rect(-text.width / 2 - 6, 0, text.width + 12, text.height + 6)
        .fill({ color: 0x241d15, alpha: 0.85 })
        .stroke({ color: 0xc9a06a, width: 1, alignment: 1 });

      plate = new Container();
      plate.addChild(board, text);
      plate.scale.set(this.plateScale);
      plate.visible = this.platesShown;
      /*
       * Staggered by the id, so two wrights standing together do not lay their
       * boards on top of one another. Deterministic, so a name does not hop to
       * a different height when the list is re-ordered.
       */
      plate.y = lift(actor.id);
      this.labels.addChild(plate);
    }

    this.parent.addChild(root);
    return { root, sprite, shadow, bar, plate, lastHp: actor.hp };
  }

  /** Brings the display in line with the simulation. */
  sync(sim: Sim, selectedId?: string): void {
    const seen = new Set<string>();

    for (const actor of sim.actors) {
      seen.add(actor.id);
      let piece = this.pieces.get(actor.id);
      if (!piece) {
        piece = this.make(actor);
        this.pieces.set(actor.id, piece);
      }

      const { x, y } = toScreen(actor.x, actor.y);
      piece.root.position.set(x, y);
      piece.root.zIndex = depthOf(actor.x, actor.y, 10);
      if (piece.plate) piece.plate.position.set(x, y + TILE_H * 0.4 + lift(actor.id));

      /* Facing, as a mirror rather than a second sprite. */
      piece.sprite.scale.x = actor.facing === 1 ? FIGURE : -FIGURE;

      /*
       * A blow is a lunge rather than a different drawing. Kenney's units have
       * no attack frame, and a small forward shove reads as a strike far
       * better than a static figure with a number popping off it.
       */
      const lunging = actor.action === "attack";
      piece.sprite.position.x = lunging ? actor.facing * 5 : 0;
      piece.sprite.position.y = TILE_H * 0.25 + (actor.moving ? Math.sin(sim.clock / 3) * 1.5 : 0);

      /*
       * White when struck. Never colour alone: a number flies off as well.
       * Otherwise the Unmade are cold, a real session wears whatever skin has
       * been bought, and the garrison's own soldiers are as drawn.
       */
      piece.sprite.tint = actor.hurt > 0
        ? 0xffffff
        : actor.side === "unmade"
          ? UNMADE_TINT
          : actor.session
            ? this.skinTint
            : 0xffffff;
      piece.sprite.alpha = actor.hurt > 0 ? 0.75 : 1;

      if (actor.hp !== piece.lastHp) {
        piece.lastHp = actor.hp;
        const hurt = actor.hp < actor.maxHp;
        piece.bar.visible = hurt;
        if (hurt) {
          piece.bar.clear();
          piece.bar.rect(-13, 0, 26, 4).fill({ color: 0x1a1008, alpha: 0.85 });
          piece.bar
            .rect(-12, 1, 24 * Math.max(0, actor.hp / actor.maxHp), 2)
            .fill({ color: actor.side === "unmade" ? 0x48d6c0 : 0x8fd05a });
        }
      }

      if (piece.plate) {
        const chosen = actor.id === selectedId;
        piece.plate.tint = chosen ? 0xffd27a : 0xffffff;
        piece.shadow.tint = chosen ? 0xf0a03c : 0xffffff;
        piece.shadow.alpha = chosen ? 0.9 : 1;
      }
    }

    /* Anybody who has left the simulation leaves the scene with them. */
    for (const [id, piece] of this.pieces) {
      if (seen.has(id)) continue;
      piece.root.destroy({ children: true });
      piece.plate?.destroy({ children: true });
      this.pieces.delete(id);
    }
  }

  destroy(): void {
    for (const piece of this.pieces.values()) {
      piece.root.destroy({ children: true });
      piece.plate?.destroy({ children: true });
    }
    this.pieces.clear();
  }
}

export { UNIT_FOR };
export type { Texture };
