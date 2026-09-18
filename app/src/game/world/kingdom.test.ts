import { describe, expect, it } from "vitest";
import {
  kingdomStrength,
  SOLDIERS_PER_HERO,
  UNMADE_PER_HERO,
  VEIL_HEAVIEST,
  veilOpacity,
  waveSize,
} from "./kingdom";

describe("what the kingdom is asked to hold", () => {
  it("wants two sessions a hero", () => {
    expect(kingdomStrength({ heroes: 3, soldiers: 0 }).wanted).toBe(3 * SOLDIERS_PER_HERO);
  });

  it("is holding at two sessions a hero, and says nothing", () => {
    const strength = kingdomStrength({ heroes: 4, soldiers: 8 });
    expect(strength.struggling).toBe(false);
    expect(strength.strain).toBe(0);
    expect(strength.short).toBe(0);
  });

  it("stays holding above that, rather than going negative", () => {
    const strength = kingdomStrength({ heroes: 2, soldiers: 40 });
    expect(strength.strain).toBe(0);
    expect(strength.struggling).toBe(false);
  });

  it("presses hardest when nothing is standing", () => {
    expect(kingdomStrength({ heroes: 2, soldiers: 0 }).strain).toBe(1);
  });

  it("reads a half-manned kingdom as half pressed", () => {
    /* Two people want four sessions; two sessions is halfway. */
    const strength = kingdomStrength({ heroes: 2, soldiers: 2 });
    expect(strength.strain).toBeCloseTo(0.5);
    expect(strength.short).toBe(2);
  });

  it("is quiet before anybody has arrived", () => {
    /*
     * The state between opening the game and the first roster. A screen washed
     * in blood while the map is still loading is the game shouting about
     * something that has not happened.
     */
    const strength = kingdomStrength({ heroes: 0, soldiers: 0 });
    expect(strength.struggling).toBe(false);
    expect(strength.strain).toBe(0);
  });
});

describe("the size of a wave", () => {
  it("grows with the team, because the border does", () => {
    expect(waveSize(4)).toBe(4 * UNMADE_PER_HERO);
  });

  it("never empties, so the map always has something on it", () => {
    expect(waveSize(0)).toBeGreaterThan(0);
  });

  it("is bounded, so a large organisation cannot exhaust a browser", () => {
    expect(waveSize(500)).toBeLessThanOrEqual(40);
  });
});

describe("the veil over the camera", () => {
  it("is not drawn at all while the kingdom is holding", () => {
    expect(veilOpacity(0)).toBe(0);
  });

  it("is faint when the kingdom is only a little short", () => {
    /* One session short of holding is not half a screen of red. */
    expect(veilOpacity(0.25)).toBeLessThan(0.1);
  });

  it("is heaviest, but never opaque, when nothing is standing", () => {
    expect(veilOpacity(1)).toBe(VEIL_HEAVIEST);
    expect(veilOpacity(1)).toBeLessThan(0.7);
  });

  it("only ever gets heavier as the strain rises", () => {
    const steps = [0, 0.2, 0.4, 0.6, 0.8, 1].map(veilOpacity);
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]).toBeGreaterThan(steps[index - 1]);
    }
  });

  it("survives a number from outside the range", () => {
    expect(veilOpacity(-4)).toBe(0);
    expect(veilOpacity(9)).toBe(VEIL_HEAVIEST);
  });
});
