import { still, type Frame } from "./compose";
import type { Sprite } from "./sprite";

/**
 * The things lying about that make a place look lived in.
 *
 * Structures say what a holding *is*. Props are what say somebody is using it:
 * a cart left by the gate, barrels stacked against a wall, a well somebody has
 * to walk to. None of them do anything, and leaving them out is the difference
 * between a diagram of a fort and a place.
 *
 * All of them are drawn on transparent ground so they can sit on grass, on
 * paving or on the road without carrying a square of the wrong surface with
 * them, and all of them get a shadow from the renderer for the same reason.
 *
 * Palette slots: 0-4 dark to lit body, 5-7 pale, 8-11 the accent ramp,
 * 12-14 timber and gold, 15 alarm.
 */

/* ---- Outside the walls -------------------------------------------------- */

/*
 * A broadleaf, twenty-four across, which is half again the width of a tile.
 *
 * The first trees were drawn inside a single tile and read as cabbages: at
 * sixteen pixels a canopy has no room for both a silhouette and any structure
 * inside it, so it comes out as a green blob. Bigger, with lobes broken into
 * the outline and a trunk showing at the south side where the light does not
 * reach, it reads as a tree from across the room.
 *
 * Props are allowed to be larger than the tile they stand on; the field
 * centres them and anchors them to the bottom of it, so a tree overhangs its
 * neighbours the way a tree does.
 */
const TREE: Frame = [
  ".......2222.............",
  ".....22333322...........",
  "...223344443322.........",
  "..23344555544332........",
  ".2334455665544332.......",
  ".2334556676554433.......",
  "233455667776554332......",
  "23345566777665543322....",
  "2334556677766554332 2...".replace(" ", "3"),
  "23345566776655443322....",
  "233455666665544332......",
  ".23345555555443322......",
  ".22334444444433222......",
  "..2233333333322.........",
  "...22222222222..........",
  ".....2211222............",
  "......cddc..............",
  "......cddc..............",
  "......cddc..............",
  ".....ccddcc.............",
  ".....cdddc..............",
  "....ccddccc.............",
  "....2cccc22.............",
  ".....22222..............",
];

/** A younger, rounder tree, so a stand of them is not one shape repeated. */
const TREE_B: Frame = [
  "........222.............",
  "......2233322...........",
  ".....223444332..........",
  "....22345554332.........",
  "...2334556654332........",
  "...2345566765433........",
  "..23455667765433........",
  "..23455677766433........",
  "..23455667765433........",
  "...2345566654332........",
  "...2334555554332........",
  "....223444443322........",
  ".....2233333322.........",
  "......222222222.........",
  ".......2112222..........",
  ".......cddc.............",
  ".......cddc.............",
  "......ccddcc............",
  "......cdddc.............",
  ".....ccddcc.............",
  ".....2cccc2.............",
  "......2222..............",
  "........................",
  "........................",
];

const BUSH: Frame = [
  "................",
  "................",
  "....2233322.....",
  "..22334443322...",
  ".2334455544322..",
  ".2345556655432..",
  "2334555665554332",
  "2334555555554332",
  ".23345555544322.",
  "..223344443322..",
  "...2233333222...",
  ".....222222.....",
  "................",
  "................",
  "................",
  "................",
];

/** A weathered boulder. Stone palette, so it reads as the same rock as the walls. */
const ROCK: Frame = [
  "................",
  "................",
  "................",
  ".....334444.....",
  "...3344554433...",
  "..334455564433..",
  ".23344555544332.",
  ".23344455543322.",
  ".22334444333222.",
  "..223333333222..",
  "...2222222222...",
  "................",
  "................",
  "................",
  "................",
  "................",
];

/* ---- Inside the walls --------------------------------------------------- */

/*
 * The well: a stone ring, dark water, and a timber winch across it. The one
 * thing in the yard that says people live here rather than store things here.
 */
const WELL: Frame = [
  "....cc........cc....",
  "....cd........dc....",
  "....cddddddddddc....",
  "....cd11111111dc....",
  "....cc........cc....",
  "...33444444444433...",
  "..334555555555433 ..".replace(" ", "."),
  ".33455111111554433..",
  ".34551100001155443..",
  ".34510000000015543..",
  ".34510000000015543..",
  ".34551100001155443..",
  ".33455111111554433..",
  "..33455555555544 3..".replace(" ", "3"),
  "...334444444444 3...".replace(" ", "3"),
  "....333333333333....",
  ".....2222222222.....",
  "....................",
  "....................",
  "....................",
];

const BARRELS: Frame = [
  "....................",
  "...4444......4444...",
  "..455554....455554..",
  "..4c11c4....4c11c4..",
  "..4d55d4....4d55d4..",
  "..4c11c4....4c11c4..",
  "..4d55d4....4d55d4..",
  "..4c11c4....4c11c4..",
  "..455554....455554..",
  "...4444......4444...",
  "......4444..........",
  ".....455554.........",
  ".....4c11c4.........",
  ".....4d55d4.........",
  ".....4c11c4.........",
  ".....455554.........",
  "......4444..........",
  "....................",
  "....................",
  "....................",
];

const CRATES: Frame = [
  "....................",
  "...cccccccccc.......",
  "...cdddddddddc......",
  "...cd11dd11ddc......",
  "...cdddddddddc......",
  "...cd11dd11ddc......",
  "...cdddddddddc......",
  "...cccccccccc.......",
  "......cccccccccc....",
  "......cdddddddddc...",
  "......cd11dd11ddc...",
  "......cdddddddddc...",
  "......cd11dd11ddc...",
  "......cdddddddddc...",
  "......cccccccccc....",
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
];

/*
 * A banner on a pole. The one place the accent colour is allowed to be large:
 * it is cloth, it is meant to be seen from the other side of the field, and it
 * is what tells you the holding belongs to somebody.
 */
const BANNER: Frame = [
  "......55........",
  "......54........",
  "....9999994.....",
  "...999aaa994....",
  "...99aaaaa994...",
  "...9aabbbaa94...",
  "...9aabbbaa94...",
  "...99aaaaa994...",
  "...999aaa9994...",
  "....99999994....",
  ".....999994.....",
  "......5494......",
  "......54........",
  "......54........",
  "......54........",
  ".....c54c.......",
];

/** A torch on a post, for the wall walk and the gate. */
const TORCH: Frame = [
  "................",
  "................",
  "................",
  "......bb........",
  ".....babb.......",
  ".....abba.......",
  "......aa........",
  "......cc........",
  "......cd........",
  "......cd........",
  "......cd........",
  "......cd........",
  ".....ccdc.......",
  "................",
  "................",
  "................",
];

/** A handcart left by the gate. */
const CART: Frame = [
  "................",
  "................",
  "................",
  "..cccccccccc....",
  "..cdddddddddc...",
  "..cd11111111c...",
  "..cdddddddddc...",
  "..cccccccccc....",
  "...c......c.....",
  "..ccc....ccc....",
  ".cd1dc..cd1dc...",
  ".c111c..c111c...",
  ".cd1dc..cd1dc...",
  "..ccc....ccc....",
  "................",
  "................",
];

export interface Prop {
  sprite: Sprite;
  /** Named, because colour and silhouette alone do not describe a scene. */
  name: string;
}

const field = (frame: Frame, name: string): Prop => ({ sprite: still(frame, "field"), name });
const stone = (frame: Frame, name: string): Prop => ({ sprite: still(frame, "stone"), name });

/** What grows outside the walls. */
export const WILD: Prop[] = [
  field(TREE, "a broadleaf tree"),
  field(TREE_B, "a young tree"),
  field(BUSH, "a bush"),
  stone(ROCK, "a boulder"),
];

/** What is kept inside them. */
export const YARD: Prop[] = [
  stone(WELL, "the well"),
  stone(BARRELS, "stacked barrels"),
  stone(CRATES, "stacked crates"),
  stone(CART, "a handcart"),
];

export const PROPS = {
  tree: field(TREE, "a broadleaf tree"),
  treeSmall: field(TREE_B, "a young tree"),
  bush: field(BUSH, "a bush"),
  rock: stone(ROCK, "a boulder"),
  well: stone(WELL, "the well"),
  barrels: stone(BARRELS, "stacked barrels"),
  crates: stone(CRATES, "stacked crates"),
  cart: stone(CART, "a handcart"),
  banner: stone(BANNER, "the holding's banner"),
  torch: stone(TORCH, "a lit torch"),
} as const;

export type PropName = keyof typeof PROPS;
