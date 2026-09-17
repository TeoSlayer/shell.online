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
 * The ten holdings.
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
      /*
       * No hall here: the castle from the medieval pack stands on this spot
       * (see the landmarks in pixi/scene.ts), and a Structure_02 at 1.6 was
       * underneath it -- two buildings claiming one tile, which is what the
       * overlap at the middle of the map was.
       */
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
    id: "barrow",
    name: "The Barrow",
    purpose: "Every session that finished. They are not gone; they are done.",
    truth: "Sessions that have closed. Their work is what your levels are made of.",
    x: 46,
    y: 22,
    radius: 6,
    ground: "stone",
    draws: "none",
    buildings: [
      { sprite: "Structure_12", x: 44, y: 20.5 },
      { sprite: "Structure_12", x: 48, y: 20.5 },
      { sprite: "Structure_12", x: 42.5, y: 23 },
      { sprite: "Structure_12", x: 46, y: 23.5, scale: 1.2 },
      { sprite: "Structure_12", x: 49.5, y: 23 },
      { sprite: "Structure_04", x: 46, y: 19, scale: 1.1 },
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

/*
 * There was a `garrisonFor(work)` here, which sent a wright to the holding that
 * matched what its session was doing. It has no callers now and is deliberately
 * not kept: soldiers gather at their own hero's camp, and a function that says
 * otherwise is a description of a model this no longer has. `draws` survives
 * because it still decides how heavy a holding's own watch is.
 */

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
  { from: "relay", to: "barrow" },
  /* Two that do not touch the Keep, so the network is a country and not a wheel. */
  { from: "forge", to: "relay" },
  { from: "muster", to: "pedlar" },
];

/**
 * Deterministic noise, from whatever is fed to it.
 *
 * The murmur3 finaliser, the same one the scatter uses. Roads have to look the
 * same every time the map is opened, for the same reason the woods do: a
 * country whose lanes are somewhere else on reload tells you, below the level
 * of noticing, that none of this is a place.
 */
function wobble(a: number, b: number, channel: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(channel + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** A point on a road, and how wide the road is there. */
export interface RoadStep {
  x: number;
  y: number;
  /** In tiles, from the middle out. Varies along the run. */
  width: number;
}

/**
 * The line a road actually takes between two holdings.
 *
 * Not a straight one. Every road used to be a ruled line from one gate to the
 * next, and nine of them out of one Keep made a wheel with spokes -- which is
 * a diagram of how the holdings are connected rather than a picture of a
 * country somebody walks through. Roads in a country bend around what was in
 * the way a long time ago, and the bend is most of what makes them read as
 * having been worn rather than drawn.
 *
 * So: a quadratic bow, with the control point pushed sideways off the midpoint
 * by an amount and a direction taken from the two endpoints, plus a small
 * wander laid over the top of it and a width that swells and narrows. None of
 * it is random -- all three come out of `wobble`, keyed on where the road
 * starts and ends, so the same road is the same road forever.
 *
 * Both the ground and the scatter's clearance read this. They used to each
 * walk their own straight line, which agreed only because two identical
 * expressions cannot disagree; with a curve they could, and a tree standing in
 * the middle of a lane is the kind of thing that sends somebody looking for a
 * collision bug that is not there.
 */
export function roadPath(from: Garrison, to: Garrison): RoadStep[] {
  /*
   * Worked out in one fixed direction and reversed if it was asked for in the
   * other, rather than merely seeded in a fixed order.
   *
   * Seeding alone is not enough and a test caught it: the bow is measured
   * perpendicular to `to - from`, and the width and the wander are functions
   * of how far along from `from` a step is, so all three flip when the ends
   * are swapped. The same two gates came out joined by two different lanes
   * depending on which one was named first. Nothing asks for it backwards
   * today, which is exactly the condition under which something will.
   */
  if (from.id > to.id) return roadPath(to, from).reverse();

  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(8, Math.ceil(span * 2));

  const seed = Math.round(from.x * 131 + from.y);
  const seedTwo = Math.round(to.x * 131 + to.y);

  /*
   * How far the middle is pushed off the straight line, as a share of the run.
   * Never past a fifth of it: past that a road stops looking like it goes
   * round something and starts looking like it is lost.
   */
  const bow = (wobble(seed, seedTwo, 1) - 0.5) * 0.38 * span;
  /* Perpendicular to the run, which is where a bow has to go to be a bow. */
  const nx = -(to.y - from.y) / (span || 1);
  const ny = (to.x - from.x) / (span || 1);
  const midX = (from.x + to.x) / 2 + nx * bow;
  const midY = (from.y + to.y) / 2 + ny * bow;

  /* Two wanders at different rates, so the edge is rough rather than wavy. */
  const phase = wobble(seed, seedTwo, 2) * Math.PI * 2;
  const phaseTwo = wobble(seed, seedTwo, 3) * Math.PI * 2;

  const path: RoadStep[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    /* The quadratic through from, the pushed midpoint, and to. */
    let x = u * u * from.x + 2 * u * t * midX + t * t * to.x;
    let y = u * u * from.y + 2 * u * t * midY + t * t * to.y;

    /*
     * The wander is damped to nothing at both ends. A road that wobbles as it
     * arrives misses the gate it was going to, and a lane that stops three
     * tiles short of a holding is worse than a straight one.
     */
    const damp = Math.sin(t * Math.PI);
    const drift =
      Math.sin(t * 9 + phase) * 1.5 + Math.sin(t * 23 + phaseTwo) * 0.6;
    x += nx * drift * damp;
    y += ny * drift * damp;

    /*
     * Width swells and narrows along the run, between about one and a half
     * tiles and three. A road of constant width is a ribbon; a road that is
     * broad where it is used and thin where it is not is a road.
     */
    const width = 0.95 + (Math.sin(t * 7 + phase) * 0.5 + 0.5) * 0.85;
    path.push({ x, y, width });
  }

  return path;
}

/**
 * Every road's line, worked out once.
 *
 * Cached for the same reason the ground is: two consumers need it, it is a few
 * thousand points of trigonometry, and computing it twice would make it
 * possible for the two to disagree.
 */
let roadCache: RoadStep[][] | undefined;

/**
 * The west road: out of Ravens' Roost, over the river, and into the wood.
 *
 * The only road on the map that does not run between two holdings, and the only
 * one that crosses water. Both of those are the point of it.
 *
 * Every other lane here joins one part of the product to another, so the
 * network is a closed country -- which is right, except that it left the river
 * as scenery nobody ever reached and nothing to say that anything arrives from
 * outside. The Roost is the inbox. What lands there came from somewhere that is
 * not on this map, so the road out of it runs west, crosses the water and stops
 * at the treeline.
 *
 * Laid the same way as the others, as steps half a tile apart with a breathing
 * width, so the scatter's clearance and the roadside props treat it as a road
 * without being told about it separately.
 */
function westRoad(): RoadStep[] {
  const roost = garrisonById("roost");
  if (!roost) return [];

  const fromX = roost.x - roost.radius + 0.5;
  const toX = 3.5;
  const span = fromX - toX;
  const steps = Math.ceil(span * 2);

  const path: RoadStep[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = fromX - span * t;
    /* A slack curve rather than a ruled line, like every other lane here. */
    const y = roost.y + Math.sin(t * Math.PI) * 2.6 + (wobble(Math.round(x), 0, 11) - 0.5) * 0.8;
    const width = 0.85 + (Math.sin(t * 6) * 0.5 + 0.5) * 0.6;
    path.push({ x, y, width });
  }
  return path;
}

export function roadPaths(): RoadStep[][] {
  return (roadCache ??= [
    ...ROADS.map((road) => {
      const from = garrisonById(road.from);
      const to = garrisonById(road.to);
      return from && to ? roadPath(from, to) : [];
    }),
    westRoad(),
  ]);
}

export interface Crossing {
  /** The middle of the water the road has to get over, in tiles. */
  x: number;
  y: number;
  /** The way the road is heading there, as a unit vector in tile space. */
  dx: number;
  dy: number;
  /** How wide the water is at that point, in tiles. */
  span: number;
}

/**
 * Where a road runs into water, which is where a bridge goes.
 *
 * Found from the road and the ground rather than written down, so a river that
 * moves takes its bridge with it. `buildGround` refuses to lay road over water,
 * so every crossing is already a gap in a lane; this is the list of them, and
 * the bridge is what fills each one in.
 */
export function crossings(): Crossing[] {
  const tiles = groundTiles();
  const wet = (x: number, y: number) => {
    const tx = Math.round(x);
    const ty = Math.round(y);
    if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) return false;
    return tiles[ty * MAP.width + tx] === "water";
  };

  const out: Crossing[] = [];
  for (const path of roadPaths()) {
    let run: RoadStep[] = [];
    const close = (endedAt: number) => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      const before = path[Math.max(0, endedAt - run.length - 1)];
      const after = path[Math.min(path.length - 1, endedAt)];
      const dx = after.x - before.x;
      const dy = after.y - before.y;

      /*
       * Snapped to a tile axis, rather than laid along the road's own tangent.
       *
       * The road bows, so where it meets the water it is heading a few degrees
       * off west -- and a deck built on that heading sits at an angle that
       * matches neither the river nor the grid under it, which is exactly what
       * a crooked bridge looks like. Everything else standing on this map lines
       * up with the diamond; a bridge is a built thing and lines up hardest of
       * all. So the crossing takes the nearer of the two tile axes and the deck
       * runs straight along it.
       */
      const along =
        Math.abs(dx) >= Math.abs(dy)
          ? { dx: Math.sign(dx) || 1, dy: 0 }
          : { dx: 0, dy: Math.sign(dy) || 1 };

      /*
       * And measured along that axis rather than along the road, so the deck is
       * as long as the water is wide in the direction it actually crosses.
       * Three tiles of dry bank at each end, so it lands on the road rather
       * than stopping at the waterline.
       */
      const wet = along.dx !== 0
        ? Math.abs(last.x - first.x)
        : Math.abs(last.y - first.y);

      out.push({
        x: (first.x + last.x) / 2,
        y: (first.y + last.y) / 2,
        dx: along.dx,
        dy: along.dy,
        span: wet + 6,
      });
      run = [];
    };

    path.forEach((step, index) => {
      if (wet(step.x, step.y)) run.push(step);
      else close(index);
    });
    close(path.length);
  }
  return out;
}

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

  /*
   * Roads, laid after the holdings so they run up to the gates.
   *
   * Stamped as a disc at every step rather than a fixed three-tile block. The
   * block was what made the lanes read as drawn: a constant width with two
   * straight edges, which is a ribbon laid over a field rather than ground
   * that has been walked flat. A disc whose radius breathes along the run
   * gives an edge that is ragged at the tile scale, which is the scale the
   * ground is drawn at.
   */
  for (const path of roadPaths()) {
    for (const step of path) {
      const reach = Math.ceil(step.width);
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (let dx = -reach; dx <= reach; dx += 1) {
          const tx = Math.round(step.x) + dx;
          const ty = Math.round(step.y) + dy;
          /*
           * The threshold is nudged per tile, so the boundary itself is rough
           * rather than a clean circle drawn in pixels.
           */
          const edge = step.width + (wobble(tx, ty, 4) - 0.5) * 0.7;
          if (Math.hypot(dx, dy) > edge) continue;
          if (isWater(tx, ty)) continue;
          put(tx, ty, "dirt");
        }
      }
    }
  }

  return tiles;
}
