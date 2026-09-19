/**
 * How much the kingdom is being asked to hold, and whether it can.
 *
 * One arithmetic, in one file with no imports, because three things have to
 * agree about it or the game lies to somebody: the simulation, which decides
 * how many of the Unmade stand on the field; the HUD, which says in words
 * whether the kingdom is holding; and the veil over the camera, which says the
 * same thing without words. Two copies of this would drift, and the way that
 * shows is a screen washed in blood over a map with nothing on it.
 *
 * The rule it encodes: **a hero holds their ground with two sessions.** That is
 * not a number picked to be hard. It is what an ordinary working day already
 * looks like -- one thing being fixed and one thing being built -- so a team
 * doing its ordinary work has a quiet border, and a team that has stopped has a
 * loud one. Nothing is lost when the kingdom is short; there is no failure
 * state here and never will be. What there is, is a picture of a place that
 * needs people in it.
 */

/** Sessions one hero must field for their ground to be held. */
export const SOLDIERS_PER_HERO = 2;

/** How many of the Unmade come for each hero's ground, held at once. */
export const UNMADE_PER_HERO = 3;

/** Never fewer than this, so an empty kingdom is still besieged. */
const LEAST_WAVE = 3;

/** And never more, whatever the size of the team. See MAX_UNMADE in sim.ts. */
const MOST_WAVE = 40;

export interface Muster {
  /** People on the team. */
  heroes: number;
  /** Live sessions standing for them. */
  soldiers: number;
}

export interface Strength {
  /** Sessions the kingdom wants standing, from the size of the team. */
  wanted: number;
  /** What it has against what it wants. 1 or more is holding. */
  ratio: number;
  /**
   * How hard it is being pressed, from 0 (holding) to 1 (nobody at all).
   *
   * This is what the veil reads. It is a fraction rather than a flag because a
   * kingdom one session short and a kingdom with nothing standing are not the
   * same picture, and a threshold would draw them identically.
   */
  strain: number;
  /** Whether it is worth saying so in words as well. */
  struggling: boolean;
  /** How many more sessions would settle it. */
  short: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function kingdomStrength({ heroes, soldiers }: Muster): Strength {
  /*
   * A kingdom with nobody in it wants nothing and is holding. That is the
   * state before the first roster arrives, and washing the screen red while
   * the game is still loading would be the game shouting at somebody for
   * something that has not happened yet.
   */
  const people = Math.max(0, Math.floor(heroes));
  const standing = Math.max(0, Math.floor(soldiers));
  const wanted = people * SOLDIERS_PER_HERO;
  if (wanted === 0) {
    return { wanted: 0, ratio: 1, strain: 0, struggling: false, short: 0 };
  }

  const ratio = standing / wanted;
  return {
    wanted,
    ratio,
    strain: clamp(1 - ratio, 0, 1),
    struggling: standing < wanted,
    short: Math.max(0, wanted - standing),
  };
}

/**
 * How many of the Unmade stand against the kingdom at once.
 *
 * From the size of the team rather than from the number of sessions, which is
 * the whole shape of the incentive: the border gets longer as people join and
 * only sessions hold it. Bounded at both ends -- a kingdom of one is still
 * worth the walk, and a kingdom of fifty must not cost somebody their browser.
 */
export function waveSize(heroes: number): number {
  const people = Math.max(0, Math.floor(heroes));
  return clamp(people * UNMADE_PER_HERO, LEAST_WAVE, MOST_WAVE);
}

/**
 * How heavily the veil is drawn over the camera, from the strain.
 *
 * Not the strain itself. A kingdom one session short of holding is not the
 * same picture as a kingdom with nobody in it, but neither is it worth half a
 * screen of red -- so the first part of the range is deliberately faint and
 * the curve steepens towards the end. The ceiling is well short of opaque,
 * because this is a signal laid over the game and not a replacement for it:
 * the map has to stay readable through it or the only thing it teaches
 * anybody is where the pause button is.
 *
 * Never the only signal. The HUD says the same thing in words, because a wash
 * of colour tells somebody who cannot separate red from green nothing at all,
 * and tells somebody looking at a screenshot nothing either.
 */
export const VEIL_HEAVIEST = 0.55;

export function veilOpacity(strain: number): number {
  const pressed = clamp(strain, 0, 1);
  if (pressed <= 0) return 0;
  return VEIL_HEAVIEST * pressed ** 1.6;
}
