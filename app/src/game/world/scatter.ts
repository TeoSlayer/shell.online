import { GARRISONS, groundTiles, MAP, roadPaths } from "./marches";
import { campSites, CAMP_RADIUS } from "./camps";

/**
 * Everything growing on the Marches that nobody built.
 *
 * A country four times the size was, at first, four times as much empty grass.
 * Distance only reads as distance if there is something between here and there
 * to pass; a wright walking across an unbroken field looks like a sprite
 * sliding over a texture, and the same walk past a wood, a boulder field and a
 * fallen log looks like a journey.
 *
 * Everything here is deterministic, from the tile's own position. The Marches
 * look the same every time they are opened, which matters more than it sounds:
 * a wood that is somewhere else on reload tells you, at a level below noticing,
 * that none of this is a place.
 *
 * It is data rather than display objects. `pixi/scatter.ts` turns it into
 * sprites and puts their shadows into the ground, where they belong -- a
 * shadow on flat earth never moves, so there is no reason to pay for it twice
 * a frame.
 */

export interface Prop {
  /** A frame name in the Kenney atlas; see scripts/import-kenney.mjs. */
  sprite: string;
  x: number;
  y: number;
  scale: number;
}

/**
 * The woods, as centres and how far they reach.
 *
 * Named clumps rather than a noise field over the whole map, because a forest
 * is a place you can be inside or outside of and evenly-spread trees are a
 * texture. They are put in the gaps between holdings, so that a road from one
 * to another has something to run through.
 */
export const WOODS = [
  { x: 48, y: 12, r: 15 },
  { x: 26, y: 46, r: 14 },
  { x: 86, y: 58, r: 13 },
  { x: 46, y: 88, r: 15 },
  { x: 84, y: 114, r: 14 },
  { x: 114, y: 44, r: 12 },
  { x: 18, y: 108, r: 13 },
  { x: 78, y: 16, r: 11 },
  { x: 40, y: 64, r: 10 },
  { x: 108, y: 104, r: 12 },
  { x: 62, y: 44, r: 9 },
  { x: 92, y: 74, r: 10 },
];

/** Rocky ground, which is where the boulders and the ore come from. */
const SCREE = [
  { x: 108, y: 30, r: 10 },
  { x: 16, y: 78, r: 9 },
  { x: 72, y: 120, r: 10 },
];

const TREES = ["Environment_01", "Environment_02", "Environment_03", "Environment_21"];
const SCRUB = ["Environment_12", "Environment_19"];
const STONES = ["Environment_06", "Environment_07", "Environment_08", "Environment_13"];
const BOULDERS = ["Environment_14", "Environment_15", "Environment_16"];
/** Ore and the one crystal, rare enough that finding one is worth the look. */
const SEAMS = ["Environment_10", "Environment_11", "Environment_17", "Environment_18"];
const DEADFALL = ["Environment_04", "Environment_05"];

/** How big each kind is drawn, against Kenney's buildings at their own size. */
const SIZE = {
  tree: { from: 0.75, to: 1.05 },
  scrub: { from: 0.4, to: 0.6 },
  deadfall: { from: 0.5, to: 0.75 },
  stone: { from: 0.45, to: 0.8 },
} as const;

/**
 * Deterministic, and different per channel so two decisions do not correlate.
 *
 * The murmur3 finaliser rather than a single multiply-and-shift. The cheap
 * version was cheap enough and badly distributed: picking from a list of four
 * trees, it chose three of them and never the fourth, anywhere on the map, and
 * the scatter used eight of the twenty things it had. One round of mixing is
 * not enough to decorrelate the low bits, and the low bits are exactly what
 * `pick` reads.
 */
function noise(x: number, y: number, channel: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(channel + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

function pick<T>(list: T[], roll: number): T {
  return list[Math.min(list.length - 1, Math.floor(roll * list.length))];
}

/** How deep inside a clump a tile is: 1 at the middle, 0 at the edge and out. */
function within(clumps: { x: number; y: number; r: number }[], x: number, y: number): number {
  let best = 0;
  for (const clump of clumps) {
    const distance = Math.hypot(x - clump.x, y - clump.y);
    if (distance >= clump.r) continue;
    best = Math.max(best, 1 - distance / clump.r);
  }
  return best;
}

/**
 * Where nothing may grow.
 *
 * Holdings and the ground they have cleared, plus a margin either side of every
 * road. A tree in the middle of a road is not a charming detail; it is the
 * thing that makes somebody look for the collision bug that is not there.
 */
function cleared(): Set<number> {
  const out = new Set<number>();
  const mark = (x: number, y: number) => {
    const tx = Math.round(x);
    const ty = Math.round(y);
    if (tx < 0 || ty < 0 || tx >= MAP.width || ty >= MAP.height) return;
    out.add(ty * MAP.width + tx);
  };

  for (const garrison of GARRISONS) {
    const reach = garrison.radius + 2;
    for (let y = -reach; y <= reach; y += 1) {
      for (let x = -reach; x <= reach; x += 1) {
        if (Math.hypot(x, y) > reach) continue;
        mark(garrison.x + x, garrison.y + y);
      }
    }
  }

  /*
   * The camps too. They are fixed ground whether or not anybody is holding
   * them, so the wood is cleared off them once here rather than when a hero
   * turns up -- the scatter is static and the roster is not.
   */
  for (const site of campSites()) {
    const reach = CAMP_RADIUS + 2;
    for (let y = -reach; y <= reach; y += 1) {
      for (let x = -reach; x <= reach; x += 1) {
        if (Math.hypot(x, y) > reach) continue;
        mark(site.x + x, site.y + y);
      }
    }
  }

  /*
   * The roads, along the line they actually take. This reads `roadPaths` for
   * the same reason the ground does -- the two used to each walk their own
   * copy of a straight line, which agreed because identical expressions
   * cannot disagree. A curve can, and the failure is a tree standing in the
   * middle of a lane.
   */
  for (const path of roadPaths()) {
    for (const step of path) {
      const reach = Math.ceil(step.width) + 1;
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (let dx = -reach; dx <= reach; dx += 1) mark(step.x + dx, step.y + dy);
      }
    }
  }

  return out;
}

export function scatterProps(): Prop[] {
  const tiles = groundTiles();
  const off = cleared();
  const props: Prop[] = [];

  for (let y = 0; y < MAP.height; y += 1) {
    for (let x = 0; x < MAP.width; x += 1) {
      const index = y * MAP.width + x;
      if (off.has(index)) continue;

      const ground = tiles[index];
      if (ground === "water" || ground === "stone" || ground === "dirt") continue;

      const wood = within(WOODS, x, y);
      const scree = within(SCREE, x, y);
      const roll = noise(x, y, 1);

      /*
       * One decision per tile, in order of how much each thing wants to be
       * here. A tile in deep woods is very likely a tree; the same tile out on
       * open grass is very unlikely to be anything at all, which is what makes
       * the open ground read as open rather than as thinly wooded.
       */
      let sprite: string | undefined;

      if (wood > 0 && roll < 0.1 + wood * 0.62) {
        const kind = noise(x, y, 2);
        sprite = kind < 0.78 ? pick(TREES, noise(x, y, 3))
          : kind < 0.92 ? pick(SCRUB, noise(x, y, 4))
            : pick(DEADFALL, noise(x, y, 5));
      } else if (scree > 0 && roll < 0.06 + scree * 0.45) {
        const kind = noise(x, y, 6);
        sprite = kind < 0.6 ? pick(BOULDERS, noise(x, y, 7))
          : kind < 0.9 ? pick(STONES, noise(x, y, 8))
            /* The seams: about one tile in thirty of rocky ground. */
            : kind < 0.99 ? pick(SEAMS, noise(x, y, 9))
              : "Environment_20";
      } else if (ground === "sand" && roll < 0.09) {
        sprite = pick(STONES, noise(x, y, 10));
      } else if (roll < 0.045) {
        /* Open country: the occasional lone tree, bush or stone. */
        const kind = noise(x, y, 11);
        sprite = kind < 0.4 ? pick(TREES, noise(x, y, 12))
          : kind < 0.75 ? pick(SCRUB, noise(x, y, 13))
            : pick(STONES, noise(x, y, 14));
      }

      if (!sprite) continue;

      /*
       * Nudged off the centre of the tile and sized a little differently each
       * time. Props sitting dead on the grid read as a grid, which is the one
       * thing the scatter exists to break up.
       *
       * Size is by what the thing is rather than one range for everything. At
       * a single scale that suited the boulders, a full-grown pine came out
       * half the height of a cottage, and a wood of those reads as a herb
       * garden. A tree stands over a roof; a shrub comes up to a knee.
       */
      const range = TREES.includes(sprite) ? SIZE.tree
        : SCRUB.includes(sprite) ? SIZE.scrub
          : DEADFALL.includes(sprite) ? SIZE.deadfall
            : SIZE.stone;

      props.push({
        sprite,
        x: x + (noise(x, y, 15) - 0.5) * 0.7,
        y: y + (noise(x, y, 16) - 0.5) * 0.7,
        scale: range.from + noise(x, y, 17) * (range.to - range.from),
      });
    }
  }

  return props;
}
