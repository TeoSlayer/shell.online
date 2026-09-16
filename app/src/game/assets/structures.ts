import { still, type Frame } from "./compose";
import type { Sprite } from "./sprite";

/**
 * The keep and the things you put up around it.
 *
 * Terminal-punk rather than medieval: a watchtower is a cathode screen on a
 * stone plinth, the walls are cut from the same dark stone as the product's
 * terminal panel, and what glows is the prompt green. The vocabulary is
 * borrowed from every base-builder there has ever been -- towers, turrets,
 * walls -- and the material is ours.
 *
 * Palette slots, from palette.ts: 0-4 stone dark to lit, 5-7 pale, 8-11 the
 * green ramp, 12-14 timber and gold, 15 alarm.
 */

/* ---- Watchtower -------------------------------------------------------- */

/*
 * A screen on a mast. Tier I is a salvaged monitor lashed to a post; the
 * higher tiers below give it a stone housing and a second aerial, so the
 * upgrade is legible from across the field at a glance rather than by reading
 * a number.
 */
const WATCHTOWER_1: Frame = [
  ".......44.......",
  "......4444......",
  "..111111111111..",
  "..188888888881..",
  "..1b8b8b8b8b81..",
  "..188888888881..",
  "..1b8b8b8b8b81..",
  "..188888888881..",
  "..1b8b8b8b8b81..",
  "..188888888881..",
  "..111111111111..",
  "....11111111....",
  "....13333331....",
  "....13222331....",
  "....13222331....",
  "....13222331....",
  "....13222331....",
  "....13222331....",
  "....13222331....",
  "....11111111....",
  "..144444444441..",
  ".13333333333331.",
  "1222222222222221",
  "1111111111111111",
];

const WATCHTOWER_2: Frame = [
  "...4..44..4.....",
  "...44444444.....",
  ".1111111111111..",
  ".1bbbbbbbbbbb1..",
  ".1b8b8b8b8b8b1..",
  ".1bbbbbbbbbbb1..",
  ".1b8b8b8b8b8b1..",
  ".1bbbbbbbbbbb1..",
  ".1b8b8b8b8b8b1..",
  ".1bbbbbbbbbbb1..",
  ".1111111111111..",
  "...1111111111...",
  "...1333333331...",
  "...1322222331...",
  "...1322dd2331...",
  "...1322dd2331...",
  "...1322222331...",
  "...1322222331...",
  "...1333333331...",
  "...1111111111...",
  ".14444444444441.",
  "1333333333333331",
  "1222222222222221",
  "1111111111111111",
];

const WATCHTOWER_3: Frame = [
  "..4..4444..4....",
  "..44444444444...",
  "111111111111111.",
  "1bbbbbbbbbbbbb1.",
  "1b8b8b8b8b8b8b1.",
  "1bbbbbbbbbbbbb1.",
  "1b8b8b8b8b8b8b1.",
  "1bbbbbbbbbbbbb1.",
  "1b8b8b8b8b8b8b1.",
  "1bbbbbbbbbbbbb1.",
  "111111111111111.",
  "..1111111111111.",
  "..1444444444441.",
  "..1322eeee22331.",
  "..1322eeee22331.",
  "..1322eeee22331.",
  "..1322222222221.",
  "..1322222222331.",
  "..1444444444441.",
  "..1111111111111.",
  "144444444444444.",
  "1333333333333331",
  "1222222222222221",
  "1111111111111111",
];

/* ---- Wall -------------------------------------------------------------- */

/*
 * A battlement, not a box. The first version of this was three grey rectangles
 * in a row and read as scenery rather than as defence; crenellations along the
 * top and a shadowed course through the middle are what make it obviously a
 * wall at sixteen pixels wide.
 *
 * Long runs are built with repeat() rather than typed out. A row of fourteen
 * identical characters is a row nobody can proofread, and the one time it is
 * miscounted every pixel after it shifts.
 */
const row = (edge: string, fill: string, width = 16) =>
  edge + fill.repeat(width - 2) + edge;

const WALL_1: Frame = [
  "11..11..11..11..",
  "1111111111111111",
  row("1", "4"),
  row("1", "3"),
  "13222222222222 1".replace(" ", "3"),
  "1322222222222231",
  "1111111111111111",
  "1322222222222231",
  "1322222222222231",
  row("1", "3"),
  "1111111111111111",
];

const WALL_2: Frame = [
  "11..11..11..11..",
  "1141141141141141",
  row("1", "4"),
  row("1", "3"),
  "1322222222222231",
  "1322dd22dd222231",
  "1111111111111111",
  "1322222222222231",
  "1322222222222231",
  row("1", "3"),
  "1111111111111111",
];

const WALL_3: Frame = [
  "11..11..11..11..",
  "11b11b11b11b11b1",
  row("1", "4"),
  row("1", "3"),
  "1322eeee22eeee31",
  "1322dd22dd222231",
  "1111111111111111",
  "1322222222222231",
  "1322222222222231",
  row("1", "4"),
  "1111111111111111",
];

/* ---- The keep itself --------------------------------------------------- */

/*
 * A fortified terminal, and the biggest thing on the field.
 *
 * The first attempt was twenty-eight pixels of monitor and read as another
 * tower rather than as the place the whole game is about. This one is
 * thirty-two square, crenellated, and has a lit gate at the foot of it, so the
 * eye lands here first and the towers read as things arranged around it.
 *
 * The face is a prompt. That is the joke and the brand at the same time.
 */
const KEEP_WIDE = 32;
/* Transparent margin, outer wall, then the interior the screen sits in. */
const keepRow = (interior: string) => "...." + "13" + interior + "31" + "....";
const screenRow = (glass: string) => keepRow("22" + glass + "22");

const KEEP_1: Frame = [
  "...." + "111..111..111..111..111." + "....",
  "...." + "1".repeat(24) + "....",
  "...." + "1" + "4".repeat(22) + "1" + "....",
  "...." + "1" + "3".repeat(22) + "1" + "....",
  keepRow("2".repeat(20)),
  screenRow("1".repeat(16)),
  screenRow("1" + "8".repeat(14) + "1"),
  screenRow("1" + "b8".repeat(7) + "1"),
  screenRow("1" + "8".repeat(14) + "1"),
  screenRow("1" + "b8".repeat(7) + "1"),
  screenRow("1" + "8".repeat(14) + "1"),
  screenRow("1" + "b8".repeat(7) + "1"),
  screenRow("1" + "8".repeat(14) + "1"),
  screenRow("1".repeat(16)),
  keepRow("2".repeat(20)),
  keepRow("2".repeat(20)),
  "...." + "1" + "3".repeat(22) + "1" + "....",
  ".." + "1" + "4".repeat(26) + "1" + "..",
  ".." + "1" + "3".repeat(26) + "1" + "..",
  ".." + "1" + "2".repeat(10) + "0".repeat(6) + "2".repeat(10) + "1" + "..",
  ".." + "1" + "2".repeat(10) + "0bbbb0" + "2".repeat(10) + "1" + "..",
  ".." + "1" + "2".repeat(10) + "0bbbb0" + "2".repeat(10) + "1" + "..",
  ".." + "1" + "2".repeat(26) + "1" + "..",
  "1" + "4".repeat(30) + "1",
  "1" + "3".repeat(30) + "1",
  "1" + "2".repeat(30) + "1",
  "1".repeat(KEEP_WIDE),
];

/* Tier II: banners, a gold course, and lit windows along the base. */
const KEEP_2: Frame = [
  "..4." + "111..111..111..111..111." + ".4..",
  "..4." + "1".repeat(24) + ".4..",
  "..4." + "1" + "e".repeat(22) + "1" + ".4..",
  "...." + "1" + "4".repeat(22) + "1" + "....",
  keepRow("2".repeat(20)),
  screenRow("1".repeat(16)),
  screenRow("1" + "b".repeat(14) + "1"),
  screenRow("1" + "b8".repeat(7) + "1"),
  screenRow("1" + "b".repeat(14) + "1"),
  screenRow("1" + "b8".repeat(7) + "1"),
  screenRow("1" + "b".repeat(14) + "1"),
  screenRow("1" + "b8".repeat(7) + "1"),
  screenRow("1" + "b".repeat(14) + "1"),
  screenRow("1".repeat(16)),
  keepRow("2".repeat(20)),
  keepRow("2" + "e".repeat(18) + "2"),
  "...." + "1" + "3".repeat(22) + "1" + "....",
  ".." + "1" + "e".repeat(26) + "1" + "..",
  ".." + "1" + "3".repeat(26) + "1" + "..",
  ".." + "1" + "2e2e2e2e22" + "0".repeat(6) + "22e2e2e2e2" + "1" + "..",
  ".." + "1" + "2".repeat(10) + "0bbbb0" + "2".repeat(10) + "1" + "..",
  ".." + "1" + "2".repeat(10) + "0bbbb0" + "2".repeat(10) + "1" + "..",
  ".." + "1" + "2".repeat(26) + "1" + "..",
  "1" + "e".repeat(30) + "1",
  "1" + "3".repeat(30) + "1",
  "1" + "2".repeat(30) + "1",
  "1".repeat(KEEP_WIDE),
];

export interface StructureArt {
  /** One sprite per tier, lowest first. */
  tiers: Sprite[];
  /** What it is called in the shop and on the field. */
  name: string;
  /** Read aloud, and shown when colour alone would not say which this is. */
  blurb: string;
}

export const WATCHTOWER: StructureArt = {
  name: "Watchtower",
  blurb: "Sees a wave coming before it arrives.",
  tiers: [WATCHTOWER_1, WATCHTOWER_2, WATCHTOWER_3].map((frame) => still(frame, "keep")),
};

export const WALL: StructureArt = {
  name: "Wall",
  blurb: "Slows what gets through the gate.",
  tiers: [WALL_1, WALL_2, WALL_3].map((frame) => still(frame, "keep")),
};

export const KEEP_CORE: StructureArt = {
  name: "The Keep",
  blurb: "Where the garrison musters.",
  tiers: [KEEP_1, KEEP_2].map((frame) => still(frame, "keep")),
};

export const STRUCTURES = {
  watchtower: WATCHTOWER,
  wall: WALL,
  keep: KEEP_CORE,
} as const;

export type StructureName = keyof typeof STRUCTURES;
