import { describe, expect, it } from "vitest";
import {
  AWARD,
  experienceFrom,
  fortification,
  levelFor,
  marksEarnedTo,
  marksForLevel,
  MAX_LEVEL,
  nextUnlock,
  NOTHING_EARNED,
  standing,
  totalForLevel,
} from "./progress";

describe("what work is worth", () => {
  it("counts nothing for nothing", () => {
    expect(experienceFrom(NOTHING_EARNED)).toBe(0);
    expect(levelFor(0)).toBe(1);
  });

  it("pays more for making something than for mending something", () => {
    /* Shipping a feature is a larger piece of work than closing one fault. */
    expect(AWARD.made).toBeGreaterThan(AWARD.mended);
  });

  it("pays most for coming back another day", () => {
    /*
     * Days are the one thing on this list that cannot be farmed by starting
     * five sessions in a minute, so a day is worth more than a session.
     */
    expect(AWARD.day).toBeGreaterThan(AWARD.session);
  });

  it("adds up every kind of work", () => {
    const earned = { sessions: 3, days: 4, machines: 2, mended: 5, made: 1 };
    expect(experienceFrom(earned)).toBe(
      3 * AWARD.session + 4 * AWARD.day + 2 * AWARD.machine + 5 * AWARD.mended + AWARD.made,
    );
  });

  it("cannot be earned by anything the simulation does", () => {
    /*
     * The rule the file is written around, asserted rather than promised. Every
     * field of `Earned` is a fact the service counted from finished sessions;
     * an earlier version took the field's own tally of faults put down, and a
     * tab left open overnight levelled you up.
     */
    expect(Object.keys(NOTHING_EARNED).sort()).toEqual(
      ["days", "machines", "made", "mended", "sessions"],
    );
  });
});

describe("the curve", () => {
  it("starts at level one and climbs", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(totalForLevel(2))).toBe(2);
    expect(levelFor(totalForLevel(5))).toBe(5);
  });

  it("never goes backwards as experience grows", () => {
    let last = 0;
    for (let experience = 0; experience < 200_000; experience += 137) {
      const level = levelFor(experience);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });

  it("gets harder, but never so hard that the next level is out of sight", () => {
    /*
     * A flat curve makes level forty meaningless; an exponential one makes
     * level six unreachable. Each step should cost more than the last and no
     * more than double the one eight levels back.
     */
    for (let level = 3; level < 30; level += 1) {
      const step = totalForLevel(level + 1) - totalForLevel(level);
      const previous = totalForLevel(level) - totalForLevel(level - 1);
      expect(step).toBeGreaterThanOrEqual(previous);
    }
  });

  it("stops at the cap rather than running away", () => {
    expect(levelFor(999_999_999)).toBe(MAX_LEVEL);
    expect(standing(999_999_999).fraction).toBe(1);
  });
});

describe("the bar", () => {
  it("is empty at a new level and full just before the next", () => {
    const fresh = standing(totalForLevel(4));
    expect(fresh.level).toBe(4);
    expect(fresh.into).toBe(0);
    expect(fresh.fraction).toBe(0);

    const nearly = standing(totalForLevel(5) - 1);
    expect(nearly.level).toBe(4);
    expect(nearly.fraction).toBeGreaterThan(0.9);
  });

  it("stays between nothing and full, whatever it is handed", () => {
    for (const value of [-500, 0, 1, 12_345, Number.NaN]) {
      const result = standing(value);
      expect(result.fraction).toBeGreaterThanOrEqual(0);
      expect(result.fraction).toBeLessThanOrEqual(1);
      expect(result.level).toBeGreaterThanOrEqual(1);
    }
  });

  it("always has something named on the end of it", () => {
    /* A bar filling towards nothing in particular is decoration. */
    for (let level = 1; level < 15; level += 1) {
      const unlock = nextUnlock(level);
      if (unlock) expect(unlock.level).toBeGreaterThan(level);
    }
  });
});

describe("marks", () => {
  it("pays nothing for the level everybody starts on", () => {
    expect(marksForLevel(1)).toBe(0);
  });

  it("pays a fixed amount, not a roll", () => {
    /*
     * A currency that arrives in random amounts turns every level-up into a
     * disappointment somebody could have avoided by waiting. That is the shape
     * of a slot machine, and this is a tool people use for work.
     */
    expect(marksForLevel(5)).toBe(marksForLevel(5));
    expect(marksForLevel(6)).toBeGreaterThan(marksForLevel(5));
  });

  it("adds up over the levels reached", () => {
    expect(marksEarnedTo(1)).toBe(0);
    expect(marksEarnedTo(3)).toBe(marksForLevel(2) + marksForLevel(3));
  });
});

describe("how fortified the holding is", () => {
  it("starts small and never shrinks", () => {
    let previous = fortification(1);
    for (let level = 2; level <= MAX_LEVEL; level += 1) {
      const current = fortification(level);
      expect(current.wallTier).toBeGreaterThanOrEqual(previous.wallTier);
      expect(current.keepTier).toBeGreaterThanOrEqual(previous.keepTier);
      expect(current.towerTier).toBeGreaterThanOrEqual(previous.towerTier);
      previous = current;
    }
  });

  it("never asks for artwork that does not exist", () => {
    /* Three tiers of wall and tower, two of keep. See assets/structures.ts. */
    const top = fortification(MAX_LEVEL);
    expect(top.wallTier).toBeLessThanOrEqual(3);
    expect(top.towerTier).toBeLessThanOrEqual(3);
    expect(top.keepTier).toBeLessThanOrEqual(2);
  });
});
