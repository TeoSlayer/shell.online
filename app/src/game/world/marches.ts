/**
 * The Marches: the region the game is played on.
 *
 * This replaces the single walled yard. The yard was the whole map, it was
 * smaller than the window it sat in, and everything in it happened in one
 * place — which is why it read as a diagram rather than a world.
 *
 * The map is now several garrisons spread over open country, and each one is a
 * *rename of a part of the product*. That is the rule the lore is held to, and
 * it is what makes a garrison worth walking to: the Forge is where features get
 * built because feature work really does happen somewhere, the Watch is where
 * faults are fought, the Chronicle is the audit log. A wright walks to the
 * garrison that matches what its session is doing.
 *
 * The lore lives here, on the ground, rather than in a document. Every garrison
 * carries a sign with its name and a line saying what it is for, readable by
 * walking up to it, and that is the only place most of it is written down.
 */

/** Ground under a tile. Purely how it is drawn. */
export type Ground = "grass" | "dirt" | "stone" | "water" | "sand";

export interface Building {
  /** A frame name in the Kenney atlas; see scripts/import-kenney.mjs. */
  sprite: string;
  /** Tile position. Fractional, because buildings are not on the grid. */
  x: number;
  y: number;
  /** Drawn larger or smaller than its natural size. */
  scale?: number;
}

export interface Garrison {
  id: string;
  /** The name on the sign. */
  name: string;
  /** What it is for, in the world's voice. One line; it goes on the sign. */
  purpose: string;
  /** What it is a rename of. Shown when a garrison is inspected. */
  truth: string;
  /** The middle of the holding, in tiles. */
  x: number;
  y: number;
  /** How far its ground extends, in tiles. */
  radius: number;
  ground: Ground;
  buildings: Building[];
  /**
   * Which work sends a wright here. A garrison with no work is somewhere
   * people pass through rather than somewhere they are posted.
   */
  draws: "bug" | "feature" | "idle" | "none";
}

/**
 * The nine holdings.
 *
 * The Keep in the middle and eight around it, roughly on the compass points, so
 * that the map has a centre and every road out of it leads somewhere. Laid out
 * on a grid 128 tiles across: several screens in any direction at a zoom you
 * can read, which is the point of a map you move around rather than a board you
 * look at.
 *
 * Each holding is a *rename of a part of the product*, and that is the rule the
 * lore is held to. A garrison nobody can point at a feature for would drift
 * into fantasy filler the first time anybody edited it.
 */
export const GARRISONS: Garrison[] = [
  {
    id: "keep",
    name: "Prompt Keep",
    purpose: "The hall. While the Prompt burns, the machine is up.",
    truth: "Your account, and the shell process behind it.",
    x: 64,
    y: 62,
    radius: 10,
    ground: "stone",
    draws: "none",
    buildings: [
      { sprite: "Structure_02", x: 64, y: 60, scale: 1.6 },
      { sprite: "Structure_06", x: 64, y: 67.5, scale: 1.1 },
      { sprite: "Structure_12", x: 58.5, y: 63 },
      { sprite: "Structure_12", x: 69.5, y: 63 },
      { sprite: "Structure_04", x: 59.5, y: 66.5 },
      { sprite: "Structure_11", x: 68.5, y: 66.5 },
      { sprite: "Structure_20", x: 60.5, y: 57.5 },
      { sprite: "Structure_10", x: 67.5, y: 57.5 },
    ],
  },
  {
    id: "relay",
    name: "The Relay",
    purpose: "Every word you type crosses here, and not one of them stops.",
    truth: "The relay. It carries your session and can read no part of it.",
    x: 64,
    y: 22,
    radius: 7,
    ground: "stone",
    draws: "none",
    buildings: [
      { sprite: "Structure_05", x: 64, y: 20, scale: 1.4 },
      { sprite: "Structure_12", x: 59.5, y: 23 },
      { sprite: "Structure_12", x: 68.5, y: 23 },
      { sprite: "Structure_08", x: 64, y: 26 },
    ],
  },
  {
    id: "forge",
    name: "The Forge",
    purpose: "Where a thing that did not exist is made to.",
    truth: "Sessions building a feature. Their work raises the walls.",
    x: 32,
    y: 32,
    radius: 8,
    ground: "dirt",
    draws: "feature",
    buildings: [
      { sprite: "Structure_07", x: 32, y: 30, scale: 1.3 },
      { sprite: "Structure_21", x: 26.5, y: 33 },
      { sprite: "Structure_23", x: 37.5, y: 33.5 },
      { sprite: "Structure_13", x: 29.5, y: 36.5 },
      { sprite: "Structure_16", x: 35.5, y: 36.5 },
    ],
  },
  {
    id: "watch",
    name: "Watchmen's Rise",
    purpose: "The Unmade are seen from here first, and met here.",
    truth: "Sessions fixing a fault. The waves come to them.",
    x: 98,
    y: 32,
    radius: 8,
    ground: "grass",
    draws: "bug",
    buildings: [
      { sprite: "Structure_12", x: 98, y: 29, scale: 1.4 },
      { sprite: "Structure_05", x: 92.5, y: 32 },
      { sprite: "Structure_10", x: 103.5, y: 32.5 },
      { sprite: "Structure_03", x: 95, y: 36.5 },
      { sprite: "Structure_08", x: 101.5, y: 36.5 },
    ],
  },
  {
    id: "vault",
    name: "The Vault",
    purpose: "Nine locks, and the keeper holds not one of the keys.",
    truth: "Session passwords, sealed once per member. The service holds none.",
    x: 108,
    y: 62,
    radius: 6,
    ground: "stone",
    draws: "none",
    buildings: [
      { sprite: "Structure_06", x: 108, y: 60, scale: 1.2 },
      { sprite: "Structure_12", x: 104, y: 63.5 },
      { sprite: "Structure_12", x: 112, y: 63.5 },
    ],
  },
  {
    id: "muster",
    name: "The Muster Yard",
    purpose: "Every outpost that has answered sends its wrights through here.",
    truth: "Your linked machines. A wright arrives when one starts a session.",
    x: 98,
    y: 92,
    radius: 8,
    ground: "dirt",
    draws: "idle",
    buildings: [
      { sprite: "Structure_08", x: 98, y: 89 },
      { sprite: "Structure_16", x: 92.5, y: 92 },
      { sprite: "Structure_17", x: 103.5, y: 92.5 },
      { sprite: "Structure_14", x: 94.5, y: 96.5 },
      { sprite: "Structure_01", x: 102, y: 96 },
    ],
  },
  {
    id: "pedlar",
    name: "Pedlar's Gate",
    purpose: "Cloth, dye, and nothing that will help you fight.",
    truth: "The shop. Everything in it is cosmetic, by construction.",
    x: 64,
    y: 104,
    radius: 7,
    ground: "sand",
    draws: "none",
    buildings: [
      { sprite: "Structure_23", x: 64, y: 102 },
      { sprite: "Structure_19", x: 58.5, y: 105 },
      { sprite: "Structure_22", x: 69.5, y: 105 },
      { sprite: "Structure_07", x: 64, y: 108 },
    ],
  },
  {
    id: "chronicle",
    name: "The Chronicle",
    purpose: "Everything that was done here, written down and sealed.",
    truth: "The audit log. Sealed to a key this service does not hold.",
    x: 30,
    y: 92,
    radius: 7,
    ground: "stone",
    draws: "none",
    buildings: [
      { sprite: "Structure_04", x: 30, y: 90, scale: 1.3 },
      { sprite: "Structure_09", x: 25, y: 93.5 },
      { sprite: "Structure_22", x: 35, y: 93.5 },
      { sprite: "Structure_12", x: 30, y: 96.5 },
    ],
  },
  {
    id: "roost",
    name: "Ravens' Roost",
    purpose: "Every raven ever sent for you is waiting in the rafters.",
    truth: "Your inbox: mentions, handoffs, and sessions that ended badly.",
    x: 24,
    y: 62,
    radius: 6,
    ground: "grass",
    draws: "none",
    buildings: [
      { sprite: "Structure_09", x: 24, y: 60, scale: 1.2 },
      { sprite: "Structure_16", x: 19.5, y: 63.5 },
      { sprite: "Structure_10", x: 28.5, y: 63.5 },
    ],
  },
];

export function garrisonById(id: string): Garrison | undefined {
  return GARRISONS.find((garrison) => garrison.id === id);
}

/** The garrison a piece of work is posted to. */
export function garrisonFor(work: "bug" | "feature" | "idle"): Garrison {
  return GARRISONS.find((garrison) => garrison.draws === work) ?? GARRISONS[0];
}

/** The whole map, in tiles. Bigger than any window, which is the point. */
export const MAP = { width: 128, height: 128 } as const;

/**
 * The roads, as runs of tiles between holdings.
 *
 * Drawn as ground rather than as sprites, so they read as worn earth rather
 * than as a decal laid over grass. Every garrison is joined to the Keep, which
 * is what makes it the middle of the map rather than merely the biggest thing
 * on it.
 */
export const ROADS: { from: string; to: string }[] = [
  { from: "keep", to: "relay" },
  { from: "keep", to: "forge" },
  { from: "keep", to: "watch" },
  { from: "keep", to: "vault" },
  { from: "keep", to: "muster" },
  { from: "keep", to: "pedlar" },
  { from: "keep", to: "chronicle" },
  { from: "keep", to: "roost" },
  /* Two that do not touch the Keep, so the network is a country and not a wheel. */
  { from: "forge", to: "relay" },
  { from: "muster", to: "pedlar" },
];

/**
 * The ground of the whole map, worked out once.
 *
 * A flat array rather than a function called per tile per frame: the map is
 * sixteen thousand tiles and the renderer walks all of them when it is built.
 */
/**
 * The ground, worked out once and kept.
 *
 * Two things need it -- the layer that draws it and the scatter that decides
 * where a tree may stand -- and it is sixteen thousand tiles of work. Computing
 * it twice would be invisible and wasteful, and worse, it would make it
 * possible for the two to disagree.
 */
let groundCache: Ground[] | undefined;

export function groundTiles(): Ground[] {
  return (groundCache ??= buildGround());
}

export function buildGround(): Ground[] {
  const tiles: Ground[] = new Array(MAP.width * MAP.height).fill("grass");
  const at = (x: number, y: number) => y * MAP.width + x;
  const put = (x: number, y: number, ground: Ground) => {
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return;
    tiles[at(x, y)] = ground;
  };
  const isWater = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < MAP.width && y < MAP.height && tiles[at(x, y)] === "water";

  /*
   * A river down the west and a lake in the north-east, so the country has
   * edges that are features rather than merely where the tiles stop.
   */
  for (let y = 0; y < MAP.height; y += 1) {
    const bend = 13 + Math.round(Math.sin(y / 15) * 5);
    for (let x = bend; x < bend + 3; x += 1) put(x, y, "water");
  }

  /* Clear of Watchmen's Rise, so a fight there never spills onto the shore. */
  const LAKE = { x: 116, y: 11, rx: 10, ry: 7 };
  for (let y = LAKE.y - LAKE.ry; y <= LAKE.y + LAKE.ry; y += 1) {
    for (let x = LAKE.x - LAKE.rx; x <= LAKE.x + LAKE.rx; x += 1) {
      const dx = (x - LAKE.x) / LAKE.rx;
      const dy = (y - LAKE.y) / LAKE.ry;
      if (dx * dx + dy * dy <= 1) put(x, y, "water");
    }
  }

  /* Shores, found from the water rather than drawn alongside it, so the two
   * cannot drift apart when either is moved. */
  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      if (tiles[at(x, y)] !== "grass") continue;
      const touching =
        isWater(x - 1, y) || isWater(x + 1, y) || isWater(x, y - 1) || isWater(x, y + 1);
      if (touching) tiles[at(x, y)] = "sand";
    }
  }

  /* Each holding's own ground. */
  for (const garrison of GARRISONS) {
    for (let y = -garrison.radius; y <= garrison.radius; y += 1) {
      for (let x = -garrison.radius; x <= garrison.radius; x += 1) {
        if (Math.hypot(x, y) > garrison.radius) continue;
        const tx = Math.round(garrison.x) + x;
        const ty = Math.round(garrison.y) + y;
        if (isWater(tx, ty)) continue;
        put(tx, ty, garrison.ground);
      }
    }
  }

  /* Roads, laid after the holdings so they run up to the gates. */
  for (const road of ROADS) {
    const from = garrisonById(road.from);
    const to = garrisonById(road.to);
    if (!from || !to) continue;
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) * 2);
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]] as const) {
        if (isWater(x + dx, y + dy)) continue;
        put(x + dx, y + dy, "dirt");
      }
    }
  }

  return tiles;
}
