import { animation, type Frame } from "./compose";
import type { Animation } from "./sprite";

/**
 * The Unmade: what comes out of rotted code.
 *
 * Everything else on this map is warm — sandstone, terracotta, timber, amber.
 * These are cold and faintly luminous, drawn from the one palette that does
 * not belong to the world, so that a foe on the field reads as something that
 * got *in* rather than something that lives here. That contrast does the job
 * an outline would do, and costs no pixels.
 *
 * Three kinds, and each is a rename of a real thing a session fights:
 *
 *   Glitch-mite   small, many, never the actual problem
 *   Null-crawler  went for the thing nobody checked
 *   Heisenbug     not there while you are looking at it
 *
 * Glitch palette slots: 0-4 dark to lit body, 5-7 pale, 8-11 the cold ramp,
 * 12-14 violet, 15 the hot pink that only ever means damage.
 */

/* ---- Glitch-mite -------------------------------------------------------- */

const MITE_A: Frame = [
  "............",
  "...2....2...",
  "....2..2....",
  "..22366322..",
  ".2366aa6632.",
  "236aabbaa632",
  "236abffba632",
  "236aabbaa632",
  ".2366aa6632.",
  "..22366322..",
  "...2....2...",
  "............",
];

const MITE_B: Frame = [
  "...2....2...",
  "....2..2....",
  "............",
  "..22366322..",
  ".2366aa6632.",
  "236aabbaa632",
  "236abffba632",
  "236aabbaa632",
  ".2366aa6632.",
  "..22366322..",
  "....2..2....",
  "...2....2...",
];

/* ---- Null-crawler ------------------------------------------------------- */

/*
 * Longer and segmented, so a crawler reads as a different silhouette from a
 * mite at a glance rather than as a bigger one. Its head is at the west end;
 * the renderer flips it when it is walking the other way.
 */
const CRAWLER_A: Frame = [
  "................",
  "..2..2..2..2....",
  ".223663663662...",
  "2366aabaabaa62..",
  "36abffbaabaab632",
  "2366aabaabaa6632",
  ".22366366366322.",
  "..2..2..2..2.22.",
  "................",
  "................",
  "................",
  "................",
];

const CRAWLER_B: Frame = [
  "..2..2..2..2....",
  "................",
  ".223663663662...",
  "2366aabaabaa62..",
  "36abffbaabaab632",
  "2366aabaabaa6632",
  ".22366366366322.",
  "................",
  "..2..2..2..2.22.",
  "................",
  "................",
  "................",
];

/* ---- Heisenbug ---------------------------------------------------------- */

/*
 * Half there. The second frame is nearly empty on purpose, so it blinks out of
 * existence as it walks — the joke and the warning at the same time. The
 * renderer does not fade it; the artwork does, which means reduced motion
 * leaves it solid rather than leaving it invisible.
 */
const HEISEN_A: Frame = [
  "................",
  "....22cccc22....",
  "...2c366663c2...",
  "..2c36aabaa63c..",
  "..c36abffba63c..",
  "..c36aabbaa63c..",
  "..2c366aa663c2..",
  "...2c3666663c...",
  "....22cccc22....",
  "......2..2......",
  ".....2....2.....",
  "................",
];

const HEISEN_B: Frame = [
  "................",
  "....2......2....",
  "...2........2...",
  "..2..3....3..2..",
  ".....3affa3.....",
  "..2..3....3..2..",
  "...2........2...",
  "....2......2....",
  "................",
  "......2..2......",
  "................",
  "................",
];

export interface FoeArt {
  walk: Animation;
  name: string;
  /** How much of a beating it takes. Small, many, or awkward. */
  hp: number;
  /** Tiles per second. */
  speed: number;
}

export const FOES: Record<string, FoeArt> = {
  mite: {
    walk: animation([MITE_A, MITE_B], "glitch", 6),
    name: "Glitch-mite",
    hp: 3,
    speed: 1.1,
  },
  crawler: {
    walk: animation([CRAWLER_A, CRAWLER_B], "glitch", 5),
    name: "Null-crawler",
    hp: 6,
    speed: 0.8,
  },
  heisenbug: {
    walk: animation([HEISEN_A, HEISEN_B], "glitch", 3),
    name: "Heisenbug",
    hp: 9,
    speed: 0.6,
  },
};

export type FoeKind = keyof typeof FOES;

export function foeArt(kind: string): FoeArt {
  return FOES[kind] ?? FOES.mite;
}
