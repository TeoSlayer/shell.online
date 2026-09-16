import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { Application } from "pixi.js";
import { GARRISONS, MAP, type Garrison } from "../world/marches";
import { campSites } from "../world/camps";
import { depthOf, TILE_H, TILE_W, toScreen } from "./iso";
import { buildGroundLayer } from "./ground";
import { buildBorder } from "./border";
import { buildScatter } from "./scatter";

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
 * now it is a board standing at the place it describes, and reading the world
 * means walking it.
 *
 * It is a plaque and not floating text, for a reason worth recording: over a
 * map of grass, fired clay and red roofs there is no text colour that reads
 * everywhere, and the outline thick enough to survive the worst case turned
 * every letter to mud. A board carries its own background with it. It also
 * sits wholly above the holding rather than hanging off the top of it, so a
 * sentence can never run down across the buildings it is describing.
 */
export function signFor(garrison: Garrison): Container {
  const group = new Container();
  const { x, y } = toScreen(garrison.x, garrison.y - garrison.radius - 0.5);
  group.position.set(x, y);
  /* Signs are drawn over everything; they are labels, not scenery. */
  group.zIndex = depthOf(garrison.x, garrison.y - garrison.radius, 500);

  const PAD = 10;
  const WIDTH = 300;

  const name = new Text({
    text: garrison.name,
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 20,
      fontWeight: "700",
      letterSpacing: 1.5,
      fill: 0xf0d9a8,
      align: "center",
      wordWrap: true,
      wordWrapWidth: WIDTH - PAD * 2,
    },
  });
  name.anchor.set(0.5, 0);

  const purpose = new Text({
    text: garrison.purpose,
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 16,
      fill: 0xc9a06a,
      align: "center",
      wordWrap: true,
      wordWrapWidth: WIDTH - PAD * 2,
    },
  });
  purpose.anchor.set(0.5, 0);
  purpose.label = "purpose";

  /*
   * The board is sized to the text rather than the text fitted to the board,
   * because the names and the sentences are lore and will be rewritten, and a
   * fixed box is a promise to re-measure every time somebody edits a word.
   */
  const width = Math.max(name.width, purpose.width) + PAD * 2;
  const tall = name.height + 4 + purpose.height + PAD * 2;
  const short = name.height + PAD * 2;

  name.position.set(0, -tall + PAD);
  purpose.position.set(0, -tall + PAD + name.height + 4);

  const board = new Graphics();
  const post = new Graphics();

  /*
   * Two boards, swapped rather than resized: close up the sentence is shown
   * and the board is tall enough for it, far out only the name is, and the
   * board shrinks to match. Redrawing on every zoom step would be the same
   * picture at a cost per frame.
   */
  const draw = (height: number) => {
    board.clear();
    board
      .rect(-width / 2, -height, width, height)
      .fill({ color: 0x241d15, alpha: 0.88 })
      .stroke({ color: 0xe8b44a, width: 2, alignment: 1 });
    post.clear();
    post.rect(-3, -height, 6, height + 14).fill({ color: 0x3a2a1a, alpha: 0.9 });
  };
  draw(tall);

  group.addChild(post, board, name, purpose);

  /* Read by the scene when the zoom changes; see keepScene's rescaleSigns. */
  Object.assign(group, {
    setDetailed(detailed: boolean) {
      purpose.visible = detailed;
      name.position.y = detailed ? -tall + PAD : -short + PAD;
      draw(detailed ? tall : short);
    },
  });

  return group;
}

/** The ground, the holdings and their signs. Everything that does not move. */
export function buildWorld(app: Application, art: Loaded): {
  root: Container;
  ground: Container;
  things: Container;
  labels: Container;
  signs: Container;
} {
  const root = new Container();
  /*
   * The far wood goes down before the ground, so the country is a clearing in
   * it. The thicket goes down after, so the trees that straddle the edge are
   * not sliced along it.
   */
  const border = buildBorder(app, art);
  const ground = buildGroundLayer();
  const things = new Container();
  /*
   * Names live above the world rather than in it.
   *
   * A name board parented to its own figure sorts at that figure's depth, so
   * anything standing in front of it covers the name -- and a label you cannot
   * read when somebody walks past is not a label. These are drawn over
   * everything, like the garrison signs, because that is what a label is.
   */
  const labels = new Container();
  const signs = new Container();
  things.sortableChildren = true;

  /*
   * The woods first, and their shadows straight into the ground.
   *
   * Props are added before the buildings only so that the two are not
   * interleaved in the child list; what actually decides which is drawn in
   * front is `zIndex`, which both set from the same rule.
   */
  const scatter = buildScatter(art, things);
  ground.addChild(scatter.shadows);

  /*
   * A barracks and a muster tent on every camp site, occupied or not.
   *
   * On every site rather than on every hero, because the sites are fixed and
   * the roster is not: building these when a hero arrives would mean adding and
   * removing buildings from the scene graph on a four-second poll, for
   * structures that never move. An empty camp reads as ground somebody could
   * hold, which is what it is.
   */
  for (const site of campSites()) {
    things.addChild(standing(art.frame("Structure_16"), site.x, site.y - 1.5, 1.1));
    things.addChild(standing(art.frame("Structure_01"), site.x - 3.5, site.y + 1.5, 0.9));
    things.addChild(standing(art.frame("Structure_08"), site.x + 3.5, site.y + 1.5, 0.85));
  }

  for (const garrison of GARRISONS) {
    for (const building of garrison.buildings) {
      things.addChild(
        standing(art.frame(building.sprite), building.x, building.y, building.scale ?? 1),
      );
    }
    signs.addChild(signFor(garrison));
  }

  root.addChild(border.canopy, ground, border.thicket, things, labels, signs);
  return { root, ground, things, labels, signs };
}

/** Where the view should start: on the Keep, which is the middle of the map. */
export function homeView(): { x: number; y: number; zoom: number } {
  /*
   * On the Keep, at a zoom you can read.
   *
   * This used to fit every holding on screen at once, which was right when
   * there were six of them on a grid 64 tiles across. There are nine now on a
   * grid of 128, and fitting them all means a zoom at which a wright is three
   * pixels tall -- a picture of a country rather than a place you are standing
   * in. A big map is one you arrive somewhere on and travel across, so the
   * game opens where the roads meet, and the road book in the pause menu is
   * how you get anywhere else without walking.
   */
  const keep = GARRISONS[0];
  const middle = toScreen(keep.x, keep.y);

  /*
   * The HUD lies across the top of the view, so the camera looks a little
   * above the Keep to put it under the strip rather than behind it. The camera
   * moves the opposite way to the picture: to push the Keep down the screen,
   * the camera looks higher up the country.
   */
  const zoom = 0.75;
  const HUD = 250;

  return {
    x: middle.x,
    y: middle.y - HUD / 2 / zoom,
    zoom,
  };
}

/**
 * How far out the view may go: far enough to see the whole country.
 *
 * Worked out from the map rather than chosen, so that making the Marches
 * bigger again cannot quietly leave a corner of them unreachable.
 */
export function widestZoom(screenWidth: number, screenHeight: number): number {
  const across = MAP.width * TILE_W;
  const down = MAP.height * TILE_H;
  return Math.min(screenWidth / across, screenHeight / down);
}

export { TILE_W, TILE_H };
