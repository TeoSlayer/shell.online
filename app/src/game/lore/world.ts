/**
 * What the keep is, who is in it, and what is trying to get in.
 *
 * The rule for all of this: every piece of lore has to be a *rename of
 * something real*, never an invention on top of it. A session is a wright
 * because a session really is a thing your machine sent to do work. The Prompt
 * must not go out because a shell really does die when its process does. Token
 * spend is elixir because it really is the thing being consumed.
 *
 * Lore that describes the product is flavour. Lore that describes a fiction
 * nobody can check is noise, and noise is what makes a small game feel
 * complicated. So there is not much here, and all of it points at something.
 */

export const WORLD = {
  /** The age. Nobody alive remembers the last reboot. */
  era: "the Long Uptime",
  /** Where the holdings stand: border country, at the edge of what still runs. */
  region: "the Marches",
  /** The player. One per person on the team. */
  role: "Castellan",
  /** The team. */
  garrison: "the Garrison",
  /** The amber light in the hall. While it burns, the machine is up. */
  flame: "the Prompt",
  /** What comes out of rotted code. */
  foe: "the Unmade",
  /** A session: something a machine sent to do work. */
  unit: "wright",
  /** A linked machine. */
  outpost: "outpost",
  /** Currency. */
  coin: "marks",
  /** The resource the stat-gathering spends. */
  essence: "elixir",
} as const;

/**
 * The one paragraph anyone is ever made to read, shown once on first launch.
 *
 * Deliberately short. A wall of fiction in front of a game somebody opened out
 * of curiosity is a wall they close.
 */
export const OPENING = [
  `It is ${WORLD.era}, and nothing has been rebooted in living memory.`,
  `Your keep stands on ${WORLD.region}, built around ${WORLD.flame} — an amber light in the hall that must not go out.`,
  /* One sentence, so the foe's name is never asked to start one in lower case. */
  `Each outpost you have linked sends a wright when there is work; ${WORLD.foe} come when there is rot.`,
] as const;

/** Flavour for each class of wright, keyed by the session kind it comes from. */
export const CLASS_LORE: Record<string, { title: string; motto: string; note: string }> = {
  "claude-code": {
    title: "Artificer",
    motto: "Measure once. Build the thing that lasts.",
    note: "Raises walls faster than anyone and argues about where they should go.",
  },
  codex: {
    title: "Arcanist",
    motto: "Every fault has a name, and a name is a hold.",
    note: "Strikes hardest at a wave already in front of it.",
  },
  hermes: {
    title: "Herald",
    motto: "News first. Everything follows news.",
    note: "Fast on the ground; steadies whoever is standing nearby.",
  },
  openclaw: {
    title: "Beastmaster",
    motto: "Hold on and do not let go.",
    note: "Slow to start, and still swinging long after the others have stopped.",
  },
  terminal: {
    title: "Footman",
    motto: "Someone has to.",
    note: "No talents worth the name. Turns up, every time, for anything.",
  },
};

/** The three kinds of Unmade, and what each is a rename of. */
export const FOE_LORE = [
  {
    id: "mite",
    name: "Glitch-mite",
    note: "Small, many, and never the real problem. Something let them in.",
  },
  {
    id: "crawler",
    name: "Null-crawler",
    note: "Goes for whatever was left unchecked. Found the gap before you did.",
  },
  {
    id: "heisenbug",
    name: "Heisenbug",
    note: "Not there while you are looking at it. Ask anyone who has lost a night to one.",
  },
] as const;

/**
 * A line of flavour for a moment, chosen without repeating the last one.
 *
 * Takes the previous line rather than keeping state, so the caller owns when
 * the line changes and the same moment can be replayed in a test.
 */
export function flavour(lines: readonly string[], previous?: string): string {
  const choices = lines.filter((line) => line !== previous);
  const pool = choices.length > 0 ? choices : lines;
  return pool[Math.floor(Math.random() * pool.length)] ?? "";
}

/** Shown while the keep is loading. Short, and about the product underneath. */
export const BOOT_LINES = [
  "Lighting the Prompt…",
  "Counting the garrison…",
  "Reading the Marches…",
  "Waking the outposts…",
  "Checking the walls…",
] as const;
