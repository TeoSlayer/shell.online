import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { GARRISONS, type Garrison } from "../world/marches";
import { depthOf, TILE_H, TILE_W, toScreen } from "./iso";
import { buildGroundLayer } from "./ground";

/**
 * Everything standing on the ground: buildings, signs, trees, and the people.
 *
 * One container, sorted by depth, because in an isometric view what is in
 * front of what is decided by position rather than by the order things were
 * added. Pixi will sort it for us if we ask; `zIndex` is set from the same
 * rule for everything, so a wright walking behind a tower goes behind it and
 * nothing has to be told about anything else.
 */

/** Where the art lives. See scripts/import-kenney.mjs and the notices file. */
const ATLAS = "/game/medieval-rts.json";

export interface Loaded {
  frame(name: string): Texture;
}

export async function loadArt(): Promise<Loaded> {
  /*
   * Decode on the main thread.
   *
   * Pixi's loader would rather spin up a Web Worker from a blob URL, which is
   * faster for a big pile of textures and which this application's
   * Content-Security-Policy forbids: `worker-src` is not set, so it falls back
   * to `script-src 'self'`, and a blob is not self. The symptom is textures
   * that never arrive and a map that draws nothing.
   *
   * The alternative was adding `blob:` to the policy. That is a real widening
   * of what the page may execute, in exchange for shaving milliseconds off
   * loading a single 160 kB atlas, which is not a trade worth making.
   */
  Assets.setPreferences({ preferWorkers: false });
  const sheet = await Assets.load(ATLAS);
  return {
    frame(name: string) {
      const texture = sheet.textures?.[name];
      if (!texture) throw new Error(`no frame "${name}" in the atlas`);
      return texture;
    },
  };
}

/**
 * A soft shadow under something standing up.
 *
 * Drawn as a flattened ellipse on the ground plane rather than as a copy of the
 * sprite: in an isometric view a shadow lies on the floor, so it should be the
 * shape the floor is, not the shape the object is. This is most of what makes
 * the map read as having a third dimension at all.
 */
function shadow(width: number): Graphics {
  const mark = new Graphics();
  mark.ellipse(0, 0, width * 0.42, width * 0.2).fill({ color: 0x1a1008, alpha: 0.28 });
  return mark;
}

/**
 * Something that stands on the ground at a tile.
 *
 * Anchored bottom-centre, so the sprite grows upwards from the tile it
 * occupies rather than being centred on it — the difference between a building
 * standing on a square and a building floating over one.
 */
export function standing(
  texture: Texture,
  tileX: number,
  tileY: number,
  scale = 1,
): Container {
  const group = new Container();
  const { x, y } = toScreen(tileX, tileY);
  group.position.set(x, y);
  group.zIndex = depthOf(tileX, tileY);

  const mark = shadow(texture.width * scale);
  mark.position.set(0, 0);
  group.addChild(mark);

  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 1);
  sprite.scale.set(scale);
  /* Lifted by a few pixels so it sits inside its own shadow, not on its edge. */
  sprite.position.set(0, TILE_H * 0.2);
  group.addChild(sprite);

  return group;
}

/**
 * The sign outside a garrison.
 *
 * This is where the lore lives. It used to be in a menu nobody had to open;
 * now it is a board in the ground at the place it describes, and reading it
 * means walking the map. The name is always shown and the purpose appears when
 * the view is close enough to make a sentence worth reading — a line of eight
 * point text on a zoomed-out map is clutter, not atmosphere.
 */
export function signFor(garrison: Garrison): Container {
  const group = new Container();
  const { x, y } = toScreen(garrison.x, garrison.y - garrison.radius + 0.5);
  group.position.set(x, y);
  group.zIndex = depthOf(garrison.x, garrison.y - garrison.radius + 0.5, 500);

  const name = new Text({
    text: garrison.name,
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 20,
      fontWeight: "700",
      letterSpacing: 1.5,
      fill: 0xf5e3c0,
      stroke: { color: 0x1a1008, width: 5 },
      align: "center",
    },
  });
  name.anchor.set(0.5, 1);
  group.addChild(name);

  const purpose = new Text({
    text: garrison.purpose,
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 16,
      fill: 0xd9b88a,
      stroke: { color: 0x1a1008, width: 4 },
      align: "center",
      wordWrap: true,
      wordWrapWidth: 320,
    },
  });
  purpose.anchor.set(0.5, 0);
  purpose.position.set(0, 4);
  purpose.label = "purpose";
  group.addChild(purpose);

  return group;
}

/** The ground, the holdings and their signs. Everything that does not move. */
export function buildWorld(art: Loaded): {
  root: Container;
  ground: Container;
  things: Container;
  signs: Container;
} {
  const root = new Container();
  const ground = buildGroundLayer();
  const things = new Container();
  const signs = new Container();
  things.sortableChildren = true;

  for (const garrison of GARRISONS) {
    for (const building of garrison.buildings) {
      things.addChild(
        standing(art.frame(building.sprite), building.x, building.y, building.scale ?? 1),
      );
    }
    signs.addChild(signFor(garrison));
  }

  root.addChild(ground, things, signs);
  return { root, ground, things, signs };
}

/** Where the view should start: on the Keep, which is the middle of the map. */
export function homePosition(): { x: number; y: number } {
  const keep = GARRISONS[0];
  return toScreen(keep.x, keep.y);
}

export { TILE_W, TILE_H };
