/**
 * Levels, marks, and what earns them.
 *
 * The rule this whole file exists to hold: **the game rewards work that has
 * already happened.** Every point of experience below comes from something a
 * session actually did — a fault put down, a structure raised, a session run
 * to completion. Nothing here can be earned by playing the game, because
 * there is nothing in the game to play at. It is a read-out with a costume on.
 *
 * That is also why there is no way to lose. No decay while you are away, no
 * streak to break, no keep falling over because somebody took a weekend. A
 * progress bar that punishes absence is a progress bar that makes people open
 * a session they did not need, and this is a tool people use for work.
 */

/**
 * The counted work, exactly as the service derives it.
 *
 * These field names are the service's: see `server/lib/game-stats.ts`, which
 * counts them from the caller's own sessions. Nothing in this shape can be
 * produced by the game, which is the point -- an earlier version fed this the
 * *simulation's* tally of faults put down, so a tab left open overnight
 * levelled you up, which is the exact opposite of what the paragraph above
 * promises.
 */
export interface Earned {
  /** Sessions that ran and ended cleanly. */
  sessions: number;
  /** Days on which anything at all was started. */
  days: number;
  /** Machines that have answered the muster. */
  machines: number;
  /** Finished sessions that read as fixing something. */
  mended: number;
  /** Finished sessions that read as making something. */
  made: number;
}

export const NOTHING_EARNED: Earned = {
  sessions: 0,
  days: 0,
  machines: 0,
  mended: 0,
  made: 0,
};

/**
 * What each kind of work is worth.
 *
 * Mending and making are worth more than a session on its own, and a session
 * is counted for them as well: finishing a fix is finishing a session and also
 * putting a fault down. Days are worth the most of any single unit, because
 * coming back on another day is the only one of these that cannot be farmed by
 * starting five sessions in a minute.
 */
export const AWARD = {
  session: 10,
  day: 15,
  machine: 20,
  mended: 14,
  made: 25,
} as const;

export function experienceFrom(earned: Earned): number {
  return (
    earned.sessions * AWARD.session +
    earned.days * AWARD.day +
    earned.machines * AWARD.machine +
    earned.mended * AWARD.mended +
    earned.made * AWARD.made
  );
}

/**
 * Experience needed to reach a level, from the one before it.
 *
 * Gently super-linear. A flat curve makes level forty meaningless and an
 * exponential one makes level six unreachable; this doubles roughly every
 * eight levels, which keeps the next one always in sight.
 */
export function costOfLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(60 * (level - 1) ** 1.35);
}

/** Total experience to have reached a level. */
export function totalForLevel(level: number): number {
  let total = 0;
  for (let step = 2; step <= level; step += 1) total += costOfLevel(step);
  return total;
}

/** The highest level a given amount of experience has reached. */
export const MAX_LEVEL = 50;

export function levelFor(experience: number): number {
  let level = 1;
  while (level < MAX_LEVEL && experience >= totalForLevel(level + 1)) level += 1;
  return level;
}

export interface Standing {
  level: number;
  /** Experience earned since reaching this level. */
  into: number;
  /** Experience this level needs in total. 0 at the cap. */
  needed: number;
  /** 0 to 1, for the bar. 1 at the cap. */
  fraction: number;
  experience: number;
}

export function standing(experience: number): Standing {
  /*
   * Guarded against a non-number, which Math.max does not catch: floor(NaN) is
   * NaN and max(0, NaN) is NaN, so an experience total that arrived broken
   * from storage or from a half-loaded save would have been drawn as a bar of
   * NaN pixels — which the canvas silently declines to draw at all.
   */
  const safe = Number.isFinite(experience) ? Math.max(0, Math.floor(experience)) : 0;
  const level = levelFor(safe);
  if (level >= MAX_LEVEL) {
    return { level, into: 0, needed: 0, fraction: 1, experience: safe };
  }
  const base = totalForLevel(level);
  const needed = costOfLevel(level + 1);
  const into = safe - base;
  return { level, into, needed, fraction: needed === 0 ? 1 : into / needed, experience: safe };
}

/**
 * Marks awarded for reaching a level.
 *
 * Deterministic, not a roll. The shop is bought from, not gambled at: a
 * currency that arrives in random amounts turns every level-up into a
 * disappointment somebody could have avoided by waiting, which is the shape of
 * a slot machine and has no place in a tool people use for work.
 */
export function marksForLevel(level: number): number {
  if (level <= 1) return 0;
  return 40 + (level - 2) * 10;
}

/** Everything earned up to a level, for a purse that was never spent. */
export function marksEarnedTo(level: number): number {
  let total = 0;
  for (let step = 2; step <= level; step += 1) total += marksForLevel(step);
  return total;
}

/**
 * The next thing that unlocks, so the bar always has a name on the end of it.
 *
 * A bar filling towards nothing in particular is decoration. A bar filling
 * towards "Watchtower II" is a reason to look at it.
 */
export const UNLOCKS: { level: number; name: string; note: string }[] = [
  { level: 2, name: "The shop", note: "A pedlar starts calling at the gate." },
  { level: 3, name: "Rampart II", note: "Dressed stone, and the walk is flagged." },
  { level: 5, name: "Watchtower II", note: "A wider rim and a brighter lamp." },
  { level: 7, name: "Keep II", note: "Gold along the ridge, and every light burning." },
  { level: 9, name: "Rampart III", note: "Braziers along the wall walk." },
  { level: 12, name: "Watchtower III", note: "A turret mounted on the rim." },
  { level: 15, name: "Skins", note: "The garrison may be dressed to taste." },
];

export function nextUnlock(level: number): { level: number; name: string; note: string } | undefined {
  return UNLOCKS.find((unlock) => unlock.level > level);
}

/**
 * What the holding looks like at a level.
 *
 * The one place that decides how fortified the base is, so the field and the
 * shop cannot disagree about it.
 */
export function fortification(level: number): { wallTier: number; keepTier: number; towerTier: number } {
  return {
    wallTier: level >= 9 ? 3 : level >= 3 ? 2 : 1,
    keepTier: level >= 7 ? 2 : 1,
    towerTier: level >= 12 ? 3 : level >= 5 ? 2 : 1,
  };
}
