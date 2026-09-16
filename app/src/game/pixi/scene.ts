import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { Application } from "pixi.js";
import { GARRISONS, MAP, type Garrison } from "../world/marches";
import { campSites } from "../world/camps";
import { depthOf, TILE_H, TILE_W, toScreen } from "../world/iso";
import { buildGroundLayer } from "./ground";
import { buildBorder } from "./border";
import { buildScatter } from "./scatter";
import { buildRoadside, type Lanterns } from "./roadside";

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

/**
 * Dusk, as three tints rather than one dark sheet over the top.
 *
 * A single wash across the whole picture dims the thing you are looking at by
 * exactly as much as the thing you are not, which is the opposite of what
 * evening does. Tinting the layers separately puts the dark where distance is:
 * the far wood goes deepest and coldest, the ground behind it less so, and the
 * buildings and the people least of all -- so figures stay readable while the
 * country around them drops away.
 *
 * The tints are cold rather than merely dark. Reducing every channel equally
 * gives a picture somebody has turned the brightness down on; pulling red
 * hardest and leaving blue is what the eye reads as evening light.
 *
 * What lifts it back is the lanterns, which is what makes them worth having
 * rather than ornaments: they are the only warm thing left on the map.
 */
const DUSK = {
  wood: 0x707f9e,
  ground: 0x8e97ba,
  things: 0xa9afc9,
} as const;

/**
 * The banners that stand at a camp, and the conifers in the border wood.
 *
 * From the medieval pack; see scripts/import-kingdom.mjs for what was taken and
 * what was done to it. Loaded separately from the atlas because they are a
 * handful of loose files rather than a spritesheet, and because one of them
 * failing to load should cost that one thing rather than the whole map.
 */
const KINGDOM = [
  "banner-a",
  "banner-b",
  "banner-c",
  "banner-d",
  "pine-dark",
  "pine-tall",
  "pine-broad",
  "castle-keep",
  "siege",
  "hero-banner",
];

export type Kingdom = Map<string, Texture>;

export async function loadKingdom(): Promise<Kingdom> {
  const loaded: Kingdom = new Map();
  await Promise.all(
    KINGDOM.map(async (name) => {
      const file = name.startsWith("pine") ? `${name}.svg` : `${name}.png`;
      try {
        loaded.set(name, await Assets.load(`/game/kingdom/${file}`));
      } catch {
        /* One missing banner is one missing banner, not a blank map. */
      }
    }),
  );
  return loaded;
}

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
      /*
       * The one place in the game set in blackletter: the name of a place.
       *
       * Everything else is monospace, because everything else is read in a
       * hurry and this is not -- you stop walking to read a signpost. The
       * sentence underneath stays monospace for that reason, so the two are
       * doing different jobs and look like it.
       */
      fontFamily: '"Pirata One", Georgia, serif',
      fontSize: 26,
      letterSpacing: 1,
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
export function buildWorld(app: Application, art: Loaded, kingdom: Kingdom): {
  root: Container;
  ground: Container;
  /** The camps, by "x,y", so the scene can show the ones somebody holds. */
  camps: Map<string, Container>;
  /** Each camp's dyeable standard, by the same key. */
  campBanners: Map<string, Sprite>;
  /** Between the ground and the figures: the colour each hero commands. */
  banners: Container;
  things: Container;
  /** Every camp's lamps and their light, by the same key the camps use. */
  campLights: Map<string, { lamps: Sprite[]; glow: Container }>;
  /** The lamps, for the scene to flicker and for reduced motion to hold still. */
  lanterns: Lanterns;
  labels: Container;
  signs: Container;
} {
  const root = new Container();
  /*
   * The far wood goes down before the ground, so the country is a clearing in
   * it. The thicket goes down after, so the trees that straddle the edge are
   * not sliced along it.
   */
  const border = buildBorder(app, art, kingdom);
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
  const banners = new Container();
  const lights = new Container();
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
   * And what people left beside the roads: fences, bales, and the lamps.
   *
   * After the scatter because it reads the same road lines, and its shadows go
   * into the ground for the same reason the scatter's do -- a shadow on flat
   * earth cannot move and never needs sorting against anything.
   */
  const roadside = buildRoadside(app, things, lights);
  ground.addChild(roadside.shadows);

  /*
   * A barracks, a muster tent and a gate on every camp site -- built once for
   * every site, and shown only where a hero is actually holding.
   *
   * Built for all of them because the sites are fixed and the roster is not:
   * adding and removing buildings on a four-second poll, for structures that
   * never move, is churn for nothing. Hidden where nobody holds because
   * fourteen sets of barracks on a map with three people on it reads as a
   * country full of abandoned camps, which is a different and wrong story.
   */
  /*
   * The landmarks: a castle over the Keep and a siege engine at the Watch.
   *
   * Placed on the holdings they belong to rather than scattered, because a
   * landmark that is everywhere is scenery. The Keep is the account itself and
   * the middle of the map, so it gets the castle; the Watch is where faults are
   * met, so it gets the engine.
   */
  const keep = GARRISONS.find((holding) => holding.id === "keep");
  const castle = kingdom.get("castle-keep");
  if (keep && castle) {
    things.addChild(standing(castle, keep.x, keep.y - 1, 0.34));
  }

  const watch = GARRISONS.find((holding) => holding.id === "watch");
  const siege = kingdom.get("siege");
  if (watch && siege) {
    things.addChild(standing(siege, watch.x - 4, watch.y + 3, 0.3));
    things.addChild(standing(siege, watch.x + 4.5, watch.y + 3.5, 0.26));
  }

  const camps = new Map<string, Container>();
  /** A camp's own banner, kept so the scene can dye it its hero's colour. */
  const campBanners = new Map<string, Sprite>();
  const flags = ["banner-a", "banner-b", "banner-c", "banner-d"];
  campSites().forEach((site, index) => {
    const camp = new Container();
    camp.addChild(standing(art.frame("Structure_16"), site.x, site.y - 1.5, 1.1));
    camp.addChild(standing(art.frame("Structure_01"), site.x - 3.5, site.y + 1.5, 0.9));
    camp.addChild(standing(art.frame("Structure_08"), site.x + 3.5, site.y + 1.5, 0.85));

    /*
     * Banners at the gate. A camp is a barracks, a tent and a gate, which from
     * above is three roofs -- indistinguishable from any other cluster of
     * buildings on the map. Flags are what say somebody holds this ground.
     *
     * A different set per site, so two camps side by side are not the same
     * picture twice, and chosen by position rather than at random so the same
     * camp always flies the same colours.
     */
    const flag = kingdom.get(flags[index % flags.length]);
    if (flag) {
      /*
       * Three times the size it was first drawn at. A banner the height of a
       * soldier is a banner nobody sees from across a camp, and the whole job
       * of it is to be seen from across a camp.
       */
      camp.addChild(standing(flag, site.x - 3.5, site.y + 3.6, 0.78));
    }

    /*
     * And one banner in the holder's own colour.
     *
     * This is the grey render rather than the red flags beside it, and that is
     * the whole reason it is here: grey takes a tint, red does not. The flags
     * say "a camp"; this one says whose.
     */
    const dyed = kingdom.get("hero-banner");
    if (dyed) {
      const standard = new Sprite(dyed);
      standard.anchor.set(0.5, 1);
      standard.scale.set(0.42);
      const at = toScreen(site.x + 3.2, site.y + 3.2);
      standard.position.set(at.x, at.y + TILE_H * 0.2);
      camp.addChild(standard);
      campBanners.set(`${site.x},${site.y}`, standard);
    }
    camp.visible = false;
    /*
     * Sorted as its own group rather than by each building's depth. A camp is
     * a handful of structures standing together on cleared ground, and nobody
     * walks between them closely enough for the difference to show.
     */
    camp.zIndex = depthOf(site.x, site.y);
    things.addChild(camp);
    camps.set(`${site.x},${site.y}`, camp);
  });

  for (const garrison of GARRISONS) {
    for (const building of garrison.buildings) {
      things.addChild(
        standing(art.frame(building.sprite), building.x, building.y, building.scale ?? 1),
      );
    }
    signs.addChild(signFor(garrison));
  }

  /*
   * Dusk. Applied to the containers rather than painted over them, so that a
   * sprite added later cannot miss it -- a wash is a thing you can forget to
   * put something under, and a tint on the parent is not.
   */
  border.canopy.tint = DUSK.wood;
  border.thicket.tint = DUSK.wood;
  ground.tint = DUSK.ground;
  things.tint = DUSK.things;

  /*
   * The lamps' pools go straight on top of the terrain and under everything
   * that stands on it. Lamplight falls on the ground; drawn over the top of
   * the map it washes out the very figures it is supposed to be lighting.
   *
   * They are the one layer with no dusk on them, which is what makes them
   * read as the only warm thing left out there.
   */
  root.addChild(
    border.canopy,
    ground,
    lights,
    banners,
    border.thicket,
    things,
    labels,
    signs,
  );
  return {
    root,
    ground,
    camps,
    campBanners,
    campLights: roadside.campLights,
    lanterns: roadside.lanterns,
    banners,
    things,
    labels,
    signs,
  };
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
