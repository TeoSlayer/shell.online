import { still, turns, type Frame } from "./compose";
import type { Sprite } from "./sprite";

/**
 * The keep and the things you put up around it, seen from above.
 *
 * Terminal-punk rather than medieval: the lights set into the stone are amber
 * cathode screens, and the keep's roof opens onto one. The vocabulary is
 * borrowed from every base-builder there has ever been — ramparts, towers, a
 * gate — and the material is ours.
 *
 * Detail at this size is shading, not more shapes. A wall with one highlight
 * and one shadow reads as a rectangle; the same wall with five steps of stone,
 * a lit outer edge, a shadowed inner one and courses picked out along the
 * walkway reads as masonry. That is why the palette gives five stone tones
 * rather than three, and why nearly every sprite here uses all of them.
 *
 * Palette slots, from palette.ts: 0-4 stone dark to lit, 5-7 pale, 8-11 the
 * terracotta and amber ramp, 12-14 timber and gold, 15 alarm.
 */

/* ---- Rampart ----------------------------------------------------------- */

/*
 * A stretch of wall running east to west, tiling seamlessly with itself.
 *
 * Read from the top: merlons along the outer edge, the parapet they stand on,
 * the walkway with its flagging, the inner parapet, and merlons again. Both
 * edges are crenellated because from above you can see both of them.
 */
const RAMPART_1: Frame = [
  "444.444.444.444.",
  "333.333.333.333.",
  "222.222.222.222.",
  "4444444444444444",
  "3333333333333333",
  "2222222222222222",
  "2111111111111111",
  "2122222222222221",
  "2122222222222221",
  "2111111111111111",
  "2222222222222222",
  "3333333333333333",
  "4444444444444444",
  "222.222.222.222.",
  "333.333.333.333.",
  "444.444.444.444.",
];

/* Tier II: the walkway is flagged and the merlons capped in dressed stone. */
const RAMPART_2: Frame = [
  "555.555.555.555.",
  "444.444.444.444.",
  "222.222.222.222.",
  "5555555555555555",
  "4444444444444444",
  "2222222222222222",
  "2133133133133131",
  "2133133133133131",
  "2111111111111111",
  "2133133133133131",
  "2222222222222222",
  "4444444444444444",
  "5555555555555555",
  "222.222.222.222.",
  "444.444.444.444.",
  "555.555.555.555.",
];

/* Tier III: braziers burning along the walk, so the wall is lit at night. */
const RAMPART_3: Frame = [
  "666.666.666.666.",
  "555.555.555.555.",
  "222.222.222.222.",
  "6666666666666666",
  "5555555555555555",
  "2222222222222222",
  "2133133133133131",
  "21b3313313b31331",
  "21a3313313a31331",
  "2111111111111111",
  "2222222222222222",
  "5555555555555555",
  "6666666666666666",
  "222.222.222.222.",
  "555.555.555.555.",
  "666.666.666.666.",
];

/*
 * Where two stretches meet. Merlons wrap the outside of the turn and the
 * inside is walkway, so a run of wall turns a corner without a seam.
 */
const CORNER_1: Frame = [
  "444.444.444.4444",
  "333.333.333.3334",
  "222.222.222.2224",
  "4444444444442224",
  "3333333333332224",
  "2222222222222224",
  "2111111111111224",
  "2122222222211224",
  "2122222222211224",
  "2122222222211224",
  "2122222222211224",
  "2122222222211224",
  "2122222222211224",
  "4432222222211224",
  "4432222222211224",
  "4442222222222224",
];

/*
 * The way in. A timber gate under a stone arch with the road running through
 * it, so the courtyard has somewhere a hero can actually walk out of.
 */
const GATE_1: Frame = [
  "444.4444444.444.",
  "333.4444444.333.",
  "222.4444444.222.",
  "4444444444444444",
  "3334333333343333",
  "2224dddddddd4222",
  "2114dccccccd4111",
  "2124dcaaaacd4222",
  "2124dcaaaacd4222",
  "2124dcaaaacd4222",
  "2114dccccccd4111",
  "2224dddddddd4222",
  "3334333333343333",
  "4444444444444444",
  "222.4444444.222.",
  "444.4444444.444.",
];

/* ---- Watchtower -------------------------------------------------------- */

/*
 * A round tower from above: a ring of merlons, a walk inside it, and an amber
 * screen at the middle that is the thing actually keeping watch.
 *
 * The tiers grow outward rather than upward, because upward is the one
 * direction this camera cannot show. Tier II widens the base and adds a
 * dressed rim; tier III mounts a turret on it.
 */
const TOWER_1: Frame = [
  ".....444444.....",
  "...4433333344...",
  "..443222222344..",
  ".44322111122344.",
  ".43211122211234.",
  "4432112222112344",
  "4321122ab2211234",
  "4321122bb2211234",
  "4321122bb2211234",
  "4321122ab2211234",
  "4432112222112344",
  ".43211122211234.",
  ".44322111122344.",
  "..443222222344..",
  "...4433333344...",
  ".....444444.....",
];

/* Tier II: a dressed rim, a wider walk, and a brighter lamp. */
const TOWER_2: Frame = [
  "....55555555....",
  "..554433334455..",
  ".55443222234455.",
  "5544322111223445",
  "5443211222112344",
  "5432112222112234",
  "4321129ab9211234",
  "432112abba211234",
  "432112abba211234",
  "4321129ab9211234",
  "5432112222112234",
  "5443211222112344",
  "5544322111223445",
  ".55443222234455.",
  "..554433334455..",
  "....55555555....",
];

/* Tier III: a turret mounted on the rim, and gold on the merlons. */
const TOWER_3: Frame = [
  "...66555555 66..".replace(" ", "5"),
  ".66554444445566.",
  "6655e33333e35566",
  "6544322111223456",
  "5443211222112345",
  "5432112eee211234",
  "432112eabae211 4".replace(" ", "3"),
  "43211eabbbae1234",
  "43211eabbbae1234",
  "432112eabae211 4".replace(" ", "3"),
  "5432112eee211234",
  "5443211222112345",
  "6544322111223456",
  "6655e33333e35566",
  ".66554444445566.",
  "...665555556 66.".replace(" ", "5"),
];

/* ---- The keep itself --------------------------------------------------- */

/*
 * The hall at the middle of the holding, and the biggest thing on the map.
 *
 * A terracotta roof with a ridge running east to west, one lantern of amber
 * glass opening out of the middle of it, and a timber porch on the south side.
 * It reads as a building rather than as another tower because its roof has a
 * direction, where the towers are radially symmetrical.
 *
 * Built by rule rather than typed out. Thirty-two rows of thirty-two
 * characters is past what anyone can proofread, and the atlas test can only
 * tell you that a row is wrong, not which pixel you meant.
 */
/*
 * Three tiles square. The first version was two, and on the field it read as
 * one more tower rather than as the hall the whole holding is arranged around;
 * the thing the eye should land on first has to be the biggest thing there.
 */
const KEEP_W = 48;

/**
 * The hall, built by rule.
 *
 * Forty-eight rows of forty-eight characters is far past what anyone can
 * proofread, and the atlas test can only tell you that a row is the wrong
 * width, not that you meant the ridge to be somewhere else.
 *
 * What makes it read as a building rather than a patterned rectangle is the
 * roof having a *direction*. There is a ridge across the middle; the slope
 * above it faces the light and is a step brighter, the slope below faces away
 * and is a step darker, and both are laid in courses with the joints staggered
 * between them. The eaves overhang into shadow on all four sides, and the
 * south wall shows below the roofline with the door in it, so there is a front
 * to the building and it faces the gate.
 */
function roofCourse(
  y: number,
  slope: "north" | "south",
  width: number,
): string {
  /* Three-pixel courses: two of tile, one of the shadow under its lip. */
  const step = y % 3;
  const lit = slope === "north" ? "a" : "9";
  const mid = slope === "north" ? "9" : "9";
  const lip = slope === "north" ? "9" : "8";
  const shift = (Math.floor(y / 3) % 2) * 2;

  let row = "";
  for (let x = 0; x < width; x += 1) {
    if (step === 2) row += lip;
    else if ((x + shift) % 4 === 0) row += mid;
    else row += step === 0 ? lit : lit;
  }
  return row;
}

function buildKeep(gold: boolean, lit: boolean): Frame {
  const rows: string[] = [];
  const W = KEEP_W;
  /* The roof overhangs the walls by two pixels on each side. */
  const roofW = W - 4;
  const roof = (body: string) => "12" + body + "21";

  /* Eaves: the dark lip of the roof, and the shadow it throws. */
  rows.push("." + "1".repeat(W - 2) + ".");
  rows.push(roof("8".repeat(roofW)));
  rows.push(roof("8".repeat(roofW)));

  /* The north slope, facing the light. */
  const northRows = 17;
  for (let y = 0; y < northRows; y += 1) {
    let body = roofCourse(y, "north", roofW);
    /*
     * A chimney standing off the north slope, and a dormer with a light in it.
     * Both are here rather than in a separate sprite because they have to sit
     * inside the courses rather than on top of them.
     */
    if (y >= 3 && y <= 9) {
      const chimney = y === 3 ? "3443" : y === 9 ? "1221" : "3223";
      body = body.slice(0, 6) + chimney + body.slice(10);
    }
    if (y >= 8 && y <= 14) {
      const glass = lit ? "e" : "b";
      const dormer =
        y === 8 ? "1111111111"
        : y === 14 ? "1222222221"
        : `12${glass.repeat(6)}21`;
      const at = Math.floor((roofW - 10) / 2);
      body = body.slice(0, at) + dormer + body.slice(at + 10);
    }
    rows.push(roof(body));
  }

  /* The ridge: capped tiles along the top of the roof. */
  const cap = gold ? "e" : "4";
  rows.push(roof("8".repeat(roofW)));
  rows.push(roof(cap.repeat(roofW)));
  rows.push(roof((gold ? "d" : "3").repeat(roofW)));
  rows.push(roof("8".repeat(roofW)));

  /* The south slope, facing away. */
  const southRows = 14;
  for (let y = 0; y < southRows; y += 1) {
    rows.push(roof(roofCourse(y, "south", roofW)));
  }

  /* The eaves again, then the wall below them. */
  rows.push(roof("8".repeat(roofW)));
  rows.push("1" + "1".repeat(W - 2) + "1");

  /*
   * The south face: dressed stone, two lit windows, and the door, so the hall
   * has a front and the front faces the gate.
   */
  const glass = lit ? "e" : "b";
  const wall = (body: string) => "1" + body + "1";
  const face = (middle: string) => {
    const side = "4433".repeat(3);
    return wall(side + middle + side.split("").reverse().join(""));
  };
  rows.push(wall("4".repeat(W - 2)));
  const window = glass + glass;
  const door = "cddc";
  rows.push(face("3333" + window + "333" + door + "333" + window + "3333"));
  rows.push(face("3333" + window + "333" + door + "333" + window + "3333"));
  rows.push(face("3".repeat(9) + door + "3".repeat(9)));
  rows.push(wall("3".repeat(W - 2)));
  rows.push("1" + "2".repeat(W - 2) + "1");
  rows.push("." + "1".repeat(W - 2) + ".");
  return rows;
}

const KEEP_1: Frame = buildKeep(false, false);
/* Tier II: a gilded ridge and every light in the place burning. */
const KEEP_2: Frame = buildKeep(true, true);

export interface StructureArt {
  /** One sprite per tier, lowest first. */
  tiers: Sprite[];
  /** What it is called in the shop and on the field. */
  name: string;
  /** Read aloud, and shown when colour alone would not say which this is. */
  blurb: string;
}

const stone = (frames: Frame[]): Sprite[] => frames.map((frame) => still(frame, "stone"));

export const RAMPART: StructureArt = {
  name: "Rampart",
  blurb: "Slows what comes over the wall.",
  tiers: stone([RAMPART_1, RAMPART_2, RAMPART_3]),
};

export const CORNER: StructureArt = {
  name: "Corner",
  blurb: "Where two stretches of wall meet.",
  tiers: stone([CORNER_1]),
};

export const GATE: StructureArt = {
  name: "Gate",
  blurb: "The only way in, and the first thing they try.",
  tiers: stone([GATE_1]),
};

export const WATCHTOWER: StructureArt = {
  name: "Watchtower",
  blurb: "Sees a wave coming before it arrives.",
  tiers: stone([TOWER_1, TOWER_2, TOWER_3]),
};

export const KEEP_CORE: StructureArt = {
  name: "The Keep",
  blurb: "Where the garrison musters.",
  tiers: stone([KEEP_1, KEEP_2]),
};

/**
 * The corner at all four orientations, clockwise from the one authored above.
 *
 * Derived rather than drawn four times, so every corner of a holding is the
 * same masonry.
 */
export const CORNER_TURNS: Sprite[] = turns(CORNER_1).map((frame) => still(frame, "stone"));

/** The rampart running north to south, from the east-to-west one. */
export const RAMPART_VERTICAL: Sprite[] = [RAMPART_1, RAMPART_2, RAMPART_3].map((frame) =>
  still(turns(frame)[1], "stone"),
);

export const GATE_VERTICAL: Sprite = still(turns(GATE_1)[1], "stone");

export const STRUCTURES = {
  rampart: RAMPART,
  corner: CORNER,
  gate: GATE,
  watchtower: WATCHTOWER,
  keep: KEEP_CORE,
} as const;

export type StructureName = keyof typeof STRUCTURES;

/* ---- Under construction ------------------------------------------------- */

/*
 * What a feature looks like while a wright is raising it.
 *
 * Three stages: pegged out, framed, and roofed. The stages matter more than
 * the artwork does — a structure that appears finished in one step gives the
 * player nothing to watch, and watching something you already did turn into
 * something standing is the whole of what this game offers.
 */
const SITE_1: Frame = [
  "................",
  "................",
  "................",
  "..c..........c..",
  "..cc........cc..",
  "................",
  "................",
  "................",
  "................",
  "................",
  "..cc........cc..",
  "..c..........c..",
  "................",
  "..2222222222222.",
  ".22222222222222.",
  "................",
];

const SITE_2: Frame = [
  "................",
  "..cccccccccccc..",
  "..c1dddddddd1c..",
  "..c1........1c..",
  "..cc........cc..",
  "..c1........1c..",
  "..c1........1c..",
  "..cc........cc..",
  "..c1........1c..",
  "..c1........1c..",
  "..cc........cc..",
  "..c1dddddddd1c..",
  "..cccccccccccc..",
  "..2222222222222.",
  ".22222222222222.",
  "................",
];

const SITE_3: Frame = [
  "................",
  "..999999999999..",
  "..9aaaaaaaaaa9..",
  "..9a88888888a9..",
  "..9aaaaaaaaaa9..",
  "..9a88888888a9..",
  "..999999999999..",
  "..cccccccccccc..",
  "..c4444444444c..",
  "..c433bb3334cc..",
  "..c433bb333 cc..".replace(" ", "4"),
  "..c4444444444c..",
  "..cccccccccccc..",
  "..2222222222222.",
  ".22222222222222.",
  "................",
];

/** The three stages of a build, in order. */
export const BUILD_SITE: Sprite[] = [SITE_1, SITE_2, SITE_3].map((frame) => still(frame, "stone"));
