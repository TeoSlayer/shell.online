import { animation, bob, still, type Frame } from "./compose";
import { reskin, STONE, type Palette } from "./palette";
import type { Animation, Sprite } from "./sprite";

/**
 * The wrights: one per live session, drawn from one figure.
 *
 * Five classes with eight frames each is forty pictures of a person, and forty
 * hand-drawn people at sixteen pixels come out as five slightly different
 * people with inconsistent proportions — the sort of thing nobody can name but
 * everybody sees. So there is one figure, and a class is three things laid
 * over it:
 *
 *   a crest    four pixels above the helm, which is the silhouette difference
 *   a palette  the tunic ramp swapped, which is the colour difference
 *   a name     from the lore, which is the difference that actually matters
 *
 * That also makes a shop skin exactly the same kind of thing as a class: a
 * different palette over the same figure. Nothing in the renderer has to know
 * which of the two it is holding.
 */

/** The body, without legs: helm, face, shoulders, tunic. */
const TORSO: string[] = [
  ".....4444.......",
  "....445544......",
  "...44566544.....",
  "...45677654.....",
  "...45677654.....",
  "...44566544.....",
  "....455554......",
  "...9aaaaaa9.....",
  "..9aaaaaaaa9....",
  "..9abbbbbba9....",
  "..9abbbbbba9....",
  "..9aaaaaaaa9....",
  "...9aaaaaa9.....",
  "....4a44a4......",
];

/**
 * The torso again, with the working arm in four positions.
 *
 * Only rows seven to twelve differ: the head, the shoulders and the belt are
 * the same pixels in every frame. That is what makes a swing read as the same
 * person swinging rather than as a second character appearing — and it is also
 * why these are written out rather than generated, because the six rows that
 * change are exactly the drawing and the eight that do not are exactly the
 * noise.
 *
 * The arm is always on the east side. The renderer flips the whole sprite when
 * a wright is facing west, so one set of frames serves both directions.
 */
const SWING: string[][] = [
  /* Wind up: weapon raised. */
  [
    "...9aaaaaa9.e...",
    "..9aaaaaaaa9e...",
    "..9abbbbbba944..",
    "..9abbbbbba9....",
    "..9aaaaaaaa9....",
    "...9aaaaaa9.....",
  ],
  /* Strike: arm out, weapon level. */
  [
    "...9aaaaaa9.....",
    "..9aaaaaaaa9....",
    "..9abbbbbba94eee",
    "..9abbbbbba9....",
    "..9aaaaaaaa9....",
    "...9aaaaaa9.....",
  ],
  /* Follow through: weapon down past the knee. */
  [
    "...9aaaaaa9.....",
    "..9aaaaaaaa9....",
    "..9abbbbbba9....",
    "..9abbbbbba944..",
    "..9aaaaaaaa9.e..",
    "...9aaaaaa9..e..",
  ],
  /* Recover. */
  [
    "...9aaaaaa9.....",
    "..9aaaaaaaa9....",
    "..9abbbbbba9....",
    "..9abbbbbba9....",
    "..9aaaaaaaa9....",
    "...9aaaaaa9.....",
  ],
];

/** The same six rows for a hammer, which goes up and down rather than across. */
const HAMMER: string[][] = [
  [
    "...9aaaaaa9.d...",
    "..9aaaaaaaa9d...",
    "..9abbbbbba944..",
    "..9abbbbbba9....",
    "..9aaaaaaaa9....",
    "...9aaaaaa9.....",
  ],
  [
    "...9aaaaaa9dd...",
    "..9aaaaaaaa9d...",
    "..9abbbbbba944..",
    "..9abbbbbba9....",
    "..9aaaaaaaa9....",
    "...9aaaaaa9.....",
  ],
  [
    "...9aaaaaa9.....",
    "..9aaaaaaaa9....",
    "..9abbbbbba944..",
    "..9abbbbbba9.d..",
    "..9aaaaaaaa9dd..",
    "...9aaaaaa9.....",
  ],
  [
    "...9aaaaaa9.....",
    "..9aaaaaaaa9....",
    "..9abbbbbba9....",
    "..9abbbbbba944..",
    "..9aaaaaaaa9dd..",
    "...9aaaaaa9.dd..",
  ],
];

/** Legs, as the four positions a walk cycles through. */
const LEGS: Record<"stand" | "left" | "pass" | "right", string[]> = {
  stand: [
    "....c4..4c......",
    "....c4..4c......",
    "....c4..4c......",
    "...cc4..4cc.....",
  ],
  left: [
    "...cc4..4c......",
    "...c44..4c......",
    "..cc4...4cc.....",
    "..cc.....4c.....",
  ],
  pass: [
    "....c4..4c......",
    "....c44.4c......",
    "....c4..4c......",
    "....cc..cc......",
  ],
  right: [
    "....c4..4cc.....",
    "....c4..44c.....",
    "....cc...4cc....",
    "....c4.....cc...",
  ],
};

/** A crest, four pixels wide, sitting above the helm. */
const CRESTS: Record<string, string> = {
  /* An anvil: the Artificer builds. */
  "claude-code": "..ee..",
  /* A reading eye: the Arcanist names the fault. */
  codex: ".e77e.",
  /* Wings: the Herald is fast. */
  hermes: "e.ee.e",
  /* A claw: the Beastmaster holds on. */
  openclaw: ".e..e.",
  /* Nothing at all. Someone has to. */
  terminal: "......",
};

function figure(kind: string, legs: string[], arms?: string[]): Frame {
  const crest = CRESTS[kind] ?? CRESTS.terminal;
  /* Rows seven to twelve are the working arm; everything else never moves. */
  const torso = arms ? [...TORSO.slice(0, 7), ...arms, TORSO[13]] : TORSO;
  return [
    /* The crest is centred over the helm: five in, six wide, five out. */
    `.....${crest}.....`.slice(0, 16).padEnd(16, "."),
    ...torso,
    ...legs,
  ];
}

/**
 * Class colours, as swaps of the tunic ramp on the stone palette.
 *
 * Only the accent slots move. The helm, the face and the boots stay the same
 * across every class, which is what keeps five wrights standing together
 * looking like one garrison rather than five different games.
 */
const TUNICS: Record<string, Partial<Record<number, string>>> = {
  /* Artificer: forge iron and hot metal. */
  "claude-code": { 8: "#6b3a1c", 9: "#a35c22", 10: "#d98b34", 11: "#f0b74c" },
  /* Arcanist: the one cold class, and the only blue on the field. */
  codex: { 8: "#20305e", 9: "#33498f", 10: "#4c6fc4", 11: "#7f9ae8" },
  /* Herald: road dust and a bright sash. */
  hermes: { 8: "#4a4a2a", 9: "#7a7539", 10: "#a8a04c", 11: "#ded36a" },
  /* Beastmaster: hide and dried blood. */
  openclaw: { 8: "#4a2320", 9: "#7d3a2e", 10: "#a85643", 11: "#c97e63" },
  /* Footman: undyed wool. */
  terminal: { 8: "#3b352c", 9: "#5f584a", 10: "#867d6b", 11: "#b0a692" },
};

export function tunicFor(kind: string): Palette {
  return reskin(STONE, TUNICS[kind] ?? TUNICS.terminal);
}

export interface HeroArt {
  idle: Animation;
  walk: Animation;
  /** Swinging at a fault. */
  attack: Animation;
  /** Raising a structure. */
  build: Animation;
  /** A single frame, for a portrait or a roster row. */
  portrait: Sprite;
  palette: Palette;
  /**
   * Whether this class fights at a distance.
   *
   * Only the Arcanist does. It is the one class whose flavour is naming a
   * fault from across the yard rather than hitting it, and one ranged class
   * among five is enough to make the field read as having variety without
   * anybody having to learn a system.
   */
  ranged: boolean;
}

function build(kind: string): HeroArt {
  const stand = figure(kind, LEGS.stand);
  return {
    /*
     * Idle is the same figure a pixel lower on alternate frames. A person
     * standing still is not motionless, and one pixel of breath is the
     * difference between a character and a game piece.
     */
    idle: animation([stand, bob(stand, 1)], "stone", 2),
    walk: animation(
      [figure(kind, LEGS.left), figure(kind, LEGS.pass), figure(kind, LEGS.right), figure(kind, LEGS.pass)],
      "stone",
      8,
    ),
    /*
     * Faster than the walk. A swing that plays at walking speed reads as
     * someone waving; the snap is most of what makes it land.
     */
    attack: animation(
      SWING.map((arms) => figure(kind, LEGS.stand, arms)),
      "stone",
      12,
    ),
    build: animation(
      HAMMER.map((arms) => figure(kind, LEGS.stand, arms)),
      "stone",
      8,
    ),
    portrait: still(stand, "stone"),
    palette: tunicFor(kind),
    ranged: kind === "codex",
  };
}

/** Every class, keyed by the session kind it is drawn from. */
export const HEROES: Record<string, HeroArt> = {
  "claude-code": build("claude-code"),
  codex: build("codex"),
  hermes: build("hermes"),
  openclaw: build("openclaw"),
  terminal: build("terminal"),
};

export function heroArt(kind: string): HeroArt {
  return HEROES[kind] ?? HEROES.terminal;
}
