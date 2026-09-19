import { Assets, Container, Graphics, Sprite, Texture } from "pixi.js";
import { SESSION_KINDS } from "../../lib/session-kinds";

/**
 * The class sigils: each harness's own mark, mounted as a device.
 *
 * These are the real logos, taken from `public/icons/`, which is where the
 * session list already gets them. That matters more than drawing something
 * prettier: a soldier is a session, and the mark over its head is the same mark
 * beside that session in the console. Two sets of icons for one thing would
 * drift the first time one of them was updated, and the game would start
 * disagreeing with the product about what a tool looks like.
 *
 * What makes them belong to this game is the mounting rather than the artwork.
 * Each one is set on a brass-rimmed disc in the class's colour, which is the
 * same treatment the panels get, so a row of them reads as heraldry rather than
 * as a toolbar that wandered onto a map.
 *
 * Loading may fail -- a missing icon, a policy that refuses an SVG -- and that
 * is not fatal. A sigil that would not load falls back to a lettered disc,
 * which is what the shield above a hero does anyway.
 */

/** One colour per class, matching the unit sprites they are drawn with. */
export const CLASS_COLOUR: Record<string, number> = {
  "claude-code": 0xe8a355,
  codex: 0x7fd0e8,
  hermes: 0xc9a6e8,
  openclaw: 0xe88a8a,
  terminal: 0xc9c2b4,
};

export type Sigils = Map<string, Texture>;

/**
 * Loads each harness's icon.
 *
 * Every one is loaded on its own and a failure is swallowed, because these are
 * five separate files of three different formats and one of them being missing
 * should cost that one sigil rather than every sigil.
 */
export async function loadSigils(): Promise<Sigils> {
  const loaded: Sigils = new Map();
  await Promise.all(
    SESSION_KINDS.map(async (kind) => {
      if (!kind.icon) return;
      try {
        loaded.set(kind.id, await Assets.load(kind.icon));
      } catch {
        /* One missing icon costs one sigil, not all of them. */
      }
    }),
  );
  return loaded;
}

/**
 * A class's mark on a disc, sized to `size` across.
 *
 * Returns a Container rather than a Sprite because it is three things: the
 * disc, its rim, and the mark. Built once per figure and never rebuilt.
 */
export function sigilFor(kind: string, sigils: Sigils, size: number): Container {
  const badge = new Container();
  const radius = size / 2;
  const colour = CLASS_COLOUR[kind] ?? CLASS_COLOUR.terminal;

  const disc = new Graphics();
  disc
    .circle(0, 0, radius)
    .fill({ color: colour })
    .stroke({ color: 0x241d15, width: 2, alignment: 0.5 });
  badge.addChild(disc);

  const texture = sigils.get(kind);
  if (texture) {
    const mark = new Sprite(texture);
    mark.anchor.set(0.5);
    /*
     * Fitted to the disc by its longest side, so a wide mark and a tall one end
     * up the same visual weight. The icons are not a matched set -- they are
     * five companies' logos -- so anything else makes one of them dominate.
     */
    const fit = (size * 0.66) / Math.max(texture.width, texture.height);
    mark.scale.set(fit);
    badge.addChild(mark);
  } else {
    /* No icon: the first letter, which is what a shield does anyway. */
    badge.addChild(letterFor(kind, radius));
  }

  return badge;
}

function letterFor(kind: string, radius: number): Graphics {
  /*
   * Drawn rather than set as text, because a Text object here would mean a
   * texture upload per figure for a single character, and this is the fallback
   * path -- it should cost less than the thing it is standing in for, not more.
   */
  const mark = new Graphics();
  const bar = radius * 0.7;
  mark
    .rect(-bar / 2, -bar / 2, bar, bar * 0.28)
    .rect(-bar / 2, bar / 2 - bar * 0.28, bar, bar * 0.28)
    .fill({ color: 0x241d15, alpha: 0.75 });
  void kind;
  return mark;
}
