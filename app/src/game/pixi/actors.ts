import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { atWork, heroPlate, soldierPlate, type Plate } from "./plates";
import type { Sigils } from "./sigils";
import { makeUnmade, walkUnmade, type Unmade } from "./unmade";
import { depthOf, TILE_H, toScreen } from "../world/iso";
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

import { UNIT_FOR } from "./units";

/** How much bigger than drawn a soldier is. See `make`. */
const FIGURE = 1.85;

/**
 * And how much bigger the Unmade are drawn than they are built.
 *
 * They were built at their natural size while everybody else was enlarged to
 * stand on a map 128 tiles across, so a crawler came out 33 pixels tall beside
 * a soldier of 102 and a hero of 153 -- present, fighting, counted, and to the
 * eye a smudge in the grass. "The bugs do not appear" was true of the picture
 * and false of the simulation, which is the worst kind of bug to look for.
 *
 * Enlarged by the same argument the figures were: the pack's scale is right
 * for a courtyard and useless here. The three builds keep their proportions to
 * each other, so a mite is still a mite next to a heisenbug.
 */
const UNMADE = 1.9;

/**
 * How much bigger again a hero is.
 *
 * Two thirds again on top of a soldier, and both have grown. A hero is a person
 * and everything around them is their work; drawn at the same size they were
 * indistinguishable from their own retinue, which is the one thing about this
 * map that has to be legible at a glance.
 *
 * Everybody is larger than the pack intends. Kenney's units are scaled to stand
 * beside Kenney's buildings, which is correct and useless here: the country is
 * a hundred and twenty-eight tiles across, and a figure sized for a courtyard
 * is a speck on it.
 */
const HERO = 3.1;

/** A small deterministic offset, so two bugs do not step in lockstep. */
function hashOf(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) {
    value = (Math.imul(value, 31) + id.charCodeAt(index)) | 0;
  }
  return (Math.abs(value) % 100) / 16;
}

/**
 * A deterministic vertical stagger, so boards do not stack.
 *
 * Wider than it was, because a camp gathers a whole company into a few tiles
 * and three steps of thirteen pixels is not enough separation for a dozen
 * boards. Deterministic so a name does not hop when the list is re-ordered.
 */
/**
 * How far a soldier's name is lifted above its head, so two of them standing
 * together do not write over each other.
 *
 * Six bands rather than five, and thirty-six apart rather than twenty-two. A
 * plate is about thirty pixels tall, so at twenty-two the bands overlapped each
 * other by a third before any two figures had even met -- the stagger was
 * shuffling the collision around rather than preventing it. Thirty-six clears a
 * plate outright, and six bands means a camp has to hold seven sessions before
 * two can land on the same line.
 *
 * Deterministic from the id, so a session's name does not hop to a different
 * height every time the roster is polled.
 */
function lift(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) {
    value = (Math.imul(value, 31) + id.charCodeAt(index)) | 0;
  }
  return (Math.abs(value) % 6) * 36;
}

/**
 * And a hero's name sits above every band a soldier can reach.
 *
 * A hero used to be pinned at zero, which is also the lowest band a soldier can
 * draw at -- so the one board on a camp that has to be findable was the one
 * most likely to have a session's name written across it. Their own retinue is
 * what they collide with, so the fix is to put them over the top of it.
 */
const HERO_LIFT = 6 * 36 + 24;

interface Piece {
  root: Container;
  /**
   * The figure itself: a sprite for anybody human, a drawn creature for the
   * Unmade. Kenney's pack has no insects, and six legs settles what a thing is
   * in a way no amount of tinting could.
   */
  sprite: Sprite | undefined;
  bug: Unmade | undefined;
  /** Whichever of the two is on screen, for facing and for the lunge. */
  figure: Container;
  shadow: Graphics;
  bar: Graphics;
  plate?: Plate;
  /** How far above the feet this figure's plate hangs. See `make`. */
  headroom: number;
  /**
   * The figure's drawn extent, for picking: half its width, and how far it
   * rises above the point it stands on. Kept rather than measured, because
   * `getBounds` walks the display list and this is asked per actor per click.
   */
  halfWidth: number;
  rise: number;
  lastHp: number;
}

export class ActorLayer {
  private readonly pieces = new Map<string, Piece>();

  /**
    * Two colours, because the shop sells two things.
    *
    * `skinTint` is what the player's own hero is drawn in; `liveryTint` washes
    * over the soldiers that stand for their sessions, so a map with several
    * companies on it reads as several companies. Neither ever touches anybody
    * else's figures.
    */
  private skinTint = 0xffffff;
  private liveryTint = 0xffffff;

  constructor(
    private readonly art: Loaded,
    private readonly parent: Container,
    /* Name boards go here, above the world, so nothing can stand in front. */
    private readonly labels: Container,
    /** Each harness's own mark, for the badge on a soldier's plate. */
    private readonly sigils: Sigils,
  ) {}

  /** The last zoom the plates were sized for; see `zoomed`. */
  private plateScale = 1;

  /** Called when a skin or a livery is bought or changed in the shop. */
  wear(skin: number, livery: number): void {
    this.skinTint = skin;
    this.liveryTint = livery;
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
  zoomed(scale: number, ceiling: number): void {
    /*
     * Against the zoom, and allowed to grow further than it shrinks.
     *
     * Zoomed out is exactly when a plate matters most -- it is how you find
     * your own company among several at the far end of a large map -- and it is
     * also when the figure under it is smallest. So the far end of the range is
     * generous. Close up it settles to about its drawn size, because at that
     * zoom the figure is doing the identifying.
     *
     * How generous depends on the canvas, which is the caller's to know. The
     * same rule that is right on a monitor put a board at twice its drawn size
     * across a phone, and a map behind its own labels is not a map.
     */
    this.plateScale = Math.min(ceiling, Math.max(0.75, 1 / scale));
    /*
     * Every board is shown at every zoom the wheel allows, heroes and soldiers
     * alike. A dozen of them over one camp do interleave; the answer to that is
     * the stagger in `lift` and the scaling above, not taking the names away at
     * exactly the distance you need them.
     */
    for (const piece of this.pieces.values()) {
      if (!piece.plate) continue;
      piece.plate.root.scale.set(this.plateScale);
    }
  }

  private make(actor: Actor, yourUid: string | undefined): Piece {
    const root = new Container();
    const size = actor.role === "hero" ? HERO : FIGURE;

    const shadow = new Graphics();
    shadow
      .ellipse(0, 0, (16 * size) / FIGURE, (7 * size) / FIGURE)
      .fill({ color: 0x1a1008, alpha: 0.32 });
    root.addChild(shadow);

    if (actor.side === "unmade") {
      const bug = makeUnmade(actor.kind);
      bug.root.scale.set(UNMADE);
      bug.root.position.set(0, TILE_H * 0.25);
      root.addChild(bug.root);
      /* The shadow grows with what casts it, or the creature floats. */
      shadow.scale.set(UNMADE);

      /* Health over the creature, shown only once something is off it. */
      const hurt = new Graphics();
      hurt.position.set(0, -24 * UNMADE);
      hurt.visible = false;
      root.addChild(hurt);

      this.parent.addChild(root);
      return {
        root,
        sprite: undefined,
        bug,
        figure: bug.root,
        shadow,
        bar: hurt,
        plate: undefined,
        headroom: 0,
        halfWidth: 18 * UNMADE,
        rise: 24 * UNMADE,
        lastHp: actor.hp,
      };
    }

    const texture = this.art.frame(UNIT_FOR[actor.kind] ?? UNIT_FOR.terminal);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    /*
     * Drawn larger than the pack intends. Kenney's units are scaled to sit
     * beside Kenney's buildings, and at that ratio a wright on this map was a
     * speck next to a church -- correct, and useless, because the wrights are
     * the thing the game is about and the buildings are where they stand.
     */
    sprite.scale.set(size);
    sprite.position.set(0, TILE_H * 0.25);
    root.addChild(sprite);

    /*
     * Health over the sprite, shown only once something has been taken off it,
     * and only for figures whose plate does not already carry one.
     *
     * A hero's plate has its own health bar, so drawing this as well gave them
     * two -- at different widths, in slightly different places, showing the
     * same number.
     */
    const bar = new Graphics();
    bar.position.set(0, -sprite.height - 4);
    bar.visible = false;
    if (actor.role !== "hero") root.addChild(bar);

    /*
     * Heroes and soldiers carry a name; the watch and the Unmade do not.
     * Scenery with a label on it is a label that stands for nothing, and a map
     * covered in those is a map nobody reads.
     */
    /*
     * The board above the head, which is a different thing for each of them.
     *
     * A hero gets a shield with their initials, their name, a health bar and a
     * bar for how much of their company is at work. A soldier gets its class
     * and the session it is. The watch and the Unmade get nothing: a name over
     * scenery is a name that stands for nothing, and a map of those is a map
     * nobody reads.
     */
    let plate: Plate | undefined;
    if (actor.role === "hero" || actor.role === "soldier") {
      plate =
        actor.role === "hero"
          ? heroPlate(actor, actor.heroUid !== undefined && actor.heroUid === yourUid)
          : soldierPlate(actor, this.sigils);
      /*
       * Hung by its bottom edge, so the board grows upwards out of the head
       * rather than downwards into it. A container positioned by its top would
       * push the board further down the taller it got, which would make a
       * hero -- whose board is the tallest -- the one whose name covered them.
       */
      plate.root.pivot.set(0, plate.height);
      plate.root.scale.set(this.plateScale);
      /*
       * Staggered by the id, so two figures standing together do not lay their
       * boards on top of one another. Deterministic, so a name does not hop to
       * a different height when the list is re-ordered.
       */
      plate.root.y = lift(actor.id);
      this.labels.addChild(plate.root);
    }

    this.parent.addChild(root);
    /*
     * Measured from the sprite rather than fixed, so a hero at twice the size
     * gets twice the clearance and nobody's name sits on their own head.
     */
    const headroom = texture.height * size + 12;
    return {
      root,
      sprite,
      bug: undefined,
      figure: sprite,
      shadow,
      bar,
      plate,
      headroom,
      /* A little wider than drawn, because a click aims at a body, not a pixel. */
      halfWidth: (texture.width * size) / 2 + 4,
      rise: texture.height * size,
      lastHp: actor.hp,
    };
  }

  /**
   * Whose figure is under a point on the map, if anybody's.
   *
   * Tested against the *drawn* body rather than against the tile the figure
   * stands on. Picking used to measure tile distance from the feet, which meant
   * only the lower body answered a click: a figure rises a hundred-odd pixels
   * out of the tile it occupies, and in tile space its own head is several
   * tiles away from it.
   *
   * The topmost match wins, which for an isometric map means the one drawn
   * last -- the figure actually on top where they overlap.
   */
  hit(x: number, y: number, pickable: (id: string) => boolean): string | undefined {
    let found: string | undefined;
    let bestDepth = -Infinity;

    for (const [id, piece] of this.pieces) {
      if (!pickable(id)) continue;
      const foot = piece.root.y + TILE_H * 0.25;
      if (x < piece.root.x - piece.halfWidth || x > piece.root.x + piece.halfWidth) continue;
      if (y > foot + 6 || y < foot - piece.rise) continue;
      if (piece.root.zIndex <= bestDepth) continue;
      bestDepth = piece.root.zIndex;
      found = id;
    }

    return found;
  }

  /** Brings the display in line with the simulation. */
  sync(sim: Sim, selectedId?: string): void {
    const seen = new Set<string>();

    for (const actor of sim.actors) {
      seen.add(actor.id);
      let piece = this.pieces.get(actor.id);
      if (!piece) {
        piece = this.make(actor, sim.youUid);
        this.pieces.set(actor.id, piece);
      }

      const { x, y } = toScreen(actor.x, actor.y);
      piece.root.position.set(x, y);
      piece.root.zIndex = depthOf(actor.x, actor.y, 10);
      if (piece.plate) {
        /*
         * Heroes are not staggered. There is one per camp, so there is nothing
         * for them to collide with, and lifting them adds up to another eighty
         * pixels of empty sky between a person and their own name.
         */
        const stagger = actor.role === "hero" ? HERO_LIFT : lift(actor.id);
        piece.plate.root.position.set(x, y - piece.headroom - stagger);
        /*
         * The same depth as the figure it belongs to, so a name in front
         * covers a name behind. A hero's plate is lifted above their own
         * retinue's: it is the one board on a camp that has to be findable.
         */
        piece.plate.root.zIndex = depthOf(actor.x, actor.y, actor.role === "hero" ? 60 : 10);
      }

      /* Facing, as a mirror rather than a second drawing. */
      if (piece.sprite) {
        const size = actor.role === "hero" ? HERO : FIGURE;
        piece.sprite.scale.x = actor.facing === 1 ? size : -size;
      } else {
        /*
         * Mirrored about its own enlarged scale, not about 1. Setting it to
         * ±1 here silently shrank every creature back to its built size the
         * first time it turned round.
         */
        piece.figure.scale.x = actor.facing === 1 ? UNMADE : -UNMADE;
      }

      /*
       * A blow is a lunge rather than a different drawing. Kenney's units have
       * no attack frame, and a small forward shove reads as a strike far
       * better than a static figure with a number popping off it.
       */
      const lunging = actor.action === "attack";
      piece.figure.position.x = lunging ? actor.facing * 5 : 0;
      piece.figure.position.y = TILE_H * 0.25 + (actor.moving ? Math.sin(sim.clock / 3) * 1.5 : 0);

      /* Six legs, walking in alternating tripods, which is how insects walk. */
      if (piece.bug) walkUnmade(piece.bug, sim.clock / 2.6 + hashOf(actor.id), actor.moving);

      /*
       * White when struck. Never colour alone: a number flies off as well.
       * Otherwise the Unmade are cold, a real session wears whatever skin has
       * been bought, and the garrison's own soldiers are as drawn.
       */
      /*
       * White when struck. Never colour alone: a number flies off as well. The
       * Unmade carry their own colours in how they are drawn, so all they take
       * from this is the flinch.
       */
      if (piece.sprite) {
        piece.sprite.tint = actor.hurt > 0
          ? 0xffffff
          : actor.heroUid && actor.heroUid === sim.youUid
            ? actor.role === "hero"
              ? this.skinTint
              : this.liveryTint
            : 0xffffff;
      }
      piece.figure.alpha = actor.hurt > 0 ? 0.6 : 1;

      if (actor.hp !== piece.lastHp) {
        piece.lastHp = actor.hp;
        const hurt = actor.hp < actor.maxHp && actor.role !== "hero";
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
        piece.plate.root.tint = chosen ? 0xffd27a : 0xffffff;
        piece.shadow.tint = chosen ? 0xf0a03c : 0xffffff;
        piece.shadow.alpha = chosen ? 0.9 : 1;
        /* A hero's two bars, which only redraw when a number actually moves. */
        piece.plate.bars?.set(actor.hp / actor.maxHp, atWork(actor, sim.actors));
      }
    }

    /* Anybody who has left the simulation leaves the scene with them. */
    for (const [id, piece] of this.pieces) {
      if (seen.has(id)) continue;
      piece.root.destroy({ children: true });
      piece.plate?.bars?.destroy();
      piece.plate?.root.destroy({ children: true });
      this.pieces.delete(id);
    }
  }

  destroy(): void {
    for (const piece of this.pieces.values()) {
      piece.root.destroy({ children: true });
      piece.plate?.bars?.destroy();
      piece.plate?.root.destroy({ children: true });
    }
    this.pieces.clear();
  }
}

export { UNIT_FOR };
export type { Texture };
