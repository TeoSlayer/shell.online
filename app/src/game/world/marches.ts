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
 * The six holdings.
 *
 * Laid out around the Keep rather than in a line, so the map has a middle and
 * the roads between them have a reason to cross. Positions are in tiles on a
 * grid roughly 64 across, which at the default zoom is a good deal more than
 * one screen — the point of a map you can move around.
 */
export const GARRISONS: Garrison[] = [
  {
    id: "keep",
    name: "Prompt Keep",
    purpose: "The hall. While the Prompt burns, the machine is up.",
    truth: "Your account, and the shell process behind it.",
    x: 32,
    y: 30,
    radius: 7,
    ground: "stone",
    draws: "none",
    buildings: [
      { sprite: "Structure_02", x: 32, y: 29, scale: 1.5 },
      { sprite: "Structure_12", x: 28.5, y: 31 },
      { sprite: "Structure_12", x: 35.5, y: 31 },
      { sprite: "Structure_04", x: 30, y: 33 },
      { sprite: "Structure_11", x: 34.5, y: 33 },
    ],
  },
  {
    id: "forge",
    name: "The Forge",
    purpose: "Where a thing that did not exist is made to.",
    truth: "Sessions building a feature. Their work raises the walls.",
    x: 19,
    y: 20,
    radius: 5,
    ground: "dirt",
    draws: "feature",
    buildings: [
      { sprite: "Structure_07", x: 19, y: 19, scale: 1.2 },
      { sprite: "Structure_21", x: 16.5, y: 21 },
      { sprite: "Structure_23", x: 21.5, y: 21.5 },
      { sprite: "Structure_13", x: 18, y: 23 },
    ],
  },
  {
    id: "watch",
    name: "Watchmen's Rise",
    purpose: "The Unmade are seen from here first, and met here.",
    truth: "Sessions fixing a fault. The waves come to them.",
    x: 46,
    y: 20,
    radius: 5,
    ground: "grass",
    draws: "bug",
    buildings: [
      { sprite: "Structure_12", x: 46, y: 18.5, scale: 1.3 },
      { sprite: "Structure_05", x: 43.5, y: 21 },
      { sprite: "Structure_10", x: 48.5, y: 21.5 },
      { sprite: "Structure_03", x: 45, y: 23 },
    ],
  },
  {
    id: "chronicle",
    name: "The Chronicle",
    purpose: "Everything that was done here, written down and sealed.",
    truth: "The audit log. Sealed to a key this service does not hold.",
    x: 20,
    y: 42,
    radius: 4,
    ground: "stone",
    draws: "none",
    buildings: [
      { sprite: "Structure_04", x: 20, y: 41, scale: 1.2 },
      { sprite: "Structure_09", x: 17.5, y: 43 },
      { sprite: "Structure_22", x: 22.5, y: 43 },
    ],
  },
  {
    id: "muster",
    name: "The Muster Yard",
    purpose: "Every outpost that has answered sends its wrights through here.",
    truth: "Your linked machines. A wright arrives when one starts a session.",
    x: 46,
    y: 42,
    radius: 5,
    ground: "dirt",
    draws: "idle",
    buildings: [
      { sprite: "Structure_08", x: 46, y: 41 },
      { sprite: "Structure_16", x: 43.5, y: 43 },
      { sprite: "Structure_17", x: 48.5, y: 43 },
      { sprite: "Structure_14", x: 45, y: 45 },
    ],
  },
  {
    id: "pedlar",
    name: "Pedlar's Gate",
    purpose: "Cloth, dye, and nothing that will help you fight.",
    truth: "The shop. Everything in it is cosmetic, by construction.",
    x: 32,
    y: 47,
    radius: 4,
    ground: "sand",
    draws: "none",
    buildings: [
      { sprite: "Structure_06", x: 32, y: 46 },
      { sprite: "Structure_19", x: 29.5, y: 48 },
      { sprite: "Structure_20", x: 34.5, y: 48 },
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
export const MAP = { width: 64, height: 64 } as const;

/**
 * The roads, as runs of tiles between holdings.
 *
 * Drawn as ground rather than as sprites, so they read as worn earth rather
 * than as a decal laid over grass. Every garrison is joined to the Keep, which
 * is what makes it the middle of the map rather than merely the biggest thing
 * on it.
 */
export const ROADS: { from: string; to: string }[] = [
  { from: "keep", to: "forge" },
  { from: "keep", to: "watch" },
  { from: "keep", to: "chronicle" },
  { from: "keep", to: "muster" },
  { from: "keep", to: "pedlar" },
];

/**
 * The ground of the whole map, worked out once.
 *
 * A flat array rather than a function called per tile per frame: the map is
 * four thousand tiles and the renderer walks all of them when the view moves.
 */
export function buildGround(): Ground[] {
  const tiles: Ground[] = new Array(MAP.width * MAP.height).fill("grass");
  const at = (x: number, y: number) => y * MAP.width + x;

  /* A river along the west, so the map has an edge that is not just an edge. */
  for (let y = 0; y < MAP.height; y += 1) {
    const bend = 6 + Math.round(Math.sin(y / 9) * 2.5);
    for (let x = bend; x < bend + 2; x += 1) {
      if (x >= 0 && x < MAP.width) tiles[at(x, y)] = "water";
    }
    if (bend - 1 >= 0) tiles[at(bend - 1, y)] = "sand";
    if (bend + 2 < MAP.width) tiles[at(bend + 2, y)] = "sand";
  }

  /* Each holding's own ground. */
  for (const garrison of GARRISONS) {
    for (let y = -garrison.radius; y <= garrison.radius; y += 1) {
      for (let x = -garrison.radius; x <= garrison.radius; x += 1) {
        if (Math.hypot(x, y) > garrison.radius) continue;
        const tx = Math.round(garrison.x) + x;
        const ty = Math.round(garrison.y) + y;
        if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) continue;
        if (tiles[at(tx, ty)] === "water") continue;
        tiles[at(tx, ty)] = garrison.ground;
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
      for (const [dx, dy] of [[0, 0], [1, 0]] as const) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) continue;
        if (tiles[at(tx, ty)] === "water") continue;
        tiles[at(tx, ty)] = "dirt";
      }
    }
  }

  return tiles;
}
