import { describe, expect, it } from "vitest";
import { emptyProfile, profileForApi, readProfile } from "./game";

/**
 * The saved game, on the way in.
 *
 * A body arriving from a browser can say anything at all. Most of what it says
 * here is harmless -- the game sells hats -- but two things are not the
 * browser's to say, and this file is mostly about those two: the token count,
 * which is the one figure in the game that stands for real money, and the
 * moment the profile was created.
 */

const NOW = Date.parse("2026-09-16T10:00:00Z");
const EARLIER = NOW - 86_400_000;

const saved = (over: Partial<ReturnType<typeof emptyProfile>> = {}) => ({
  ...emptyProfile("u1", EARLIER),
  ...over,
});

describe("an empty profile", () => {
  it("has chosen nothing and owns nothing", () => {
    const profile = emptyProfile("u1", NOW);
    expect(profile.characterClass).toBe("");
    expect(profile.owned).toEqual([]);
    expect(profile.spent).toBe(0);
    expect(profile.tokens).toBe(0);
    expect(profile.gathering).toBe(false);
  });

  it("is not gathering until somebody says so", () => {
    /* Collection is announced and opted into; off is the only safe default. */
    expect(emptyProfile("u1", NOW).gathering).toBe(false);
  });
});

describe("what a browser may not set", () => {
  it("ignores a token count sent by the client", () => {
    /*
     * The line this file exists for. Tokens are written by the agent's report
     * of what a collection run cost, and shown on the elixir vial. A client
     * that could set this could tell somebody they had spent nothing.
     */
    const profile = readProfile("u1", { tokens: 0 }, saved({ tokens: 1_200_000 }), NOW);
    expect(profile.tokens).toBe(1_200_000);
  });

  it("ignores a token count on a profile that did not exist yet", () => {
    expect(readProfile("u1", { tokens: 999 }, null, NOW).tokens).toBe(0);
  });

  it("keeps the uid it was called with, not one from the body", () => {
    const profile = readProfile("u1", { uid: "u2" }, null, NOW);
    expect(profile.uid).toBe("u1");
  });

  it("keeps the original creation time", () => {
    const profile = readProfile("u1", { created_at: NOW }, saved(), NOW);
    expect(profile.createdAt).toBe(EARLIER);
    expect(profile.updatedAt).toBe(NOW);
  });
});

describe("narrowing what it does accept", () => {
  it("takes one of the five classes and refuses anything else", () => {
    expect(readProfile("u1", { character_class: "codex" }, null, NOW).characterClass).toBe("codex");
    expect(readProfile("u1", { character_class: "dragon" }, null, NOW).characterClass).toBe("");
  });

  it("keeps the class already chosen rather than clearing it", () => {
    /* A save that omits the class is a save of something else, not a reset. */
    const profile = readProfile("u1", {}, saved({ characterClass: "hermes" }), NOW);
    expect(profile.characterClass).toBe("hermes");
  });

  it("drops anything in `owned` that is not a string", () => {
    const profile = readProfile("u1", { owned: ["ash", 7, null, "gilt"] }, null, NOW);
    expect(profile.owned).toEqual(["ash", "gilt"]);
  });

  it("bounds how much one account can be said to own", () => {
    const many = Array.from({ length: 5000 }, (_, index) => `skin-${index}`);
    expect(readProfile("u1", { owned: many }, null, NOW).owned.length).toBeLessThanOrEqual(200);
  });

  it("refuses a negative or nonsense spend", () => {
    expect(readProfile("u1", { spent: -500 }, null, NOW).spent).toBe(0);
    expect(readProfile("u1", { spent: "lots" }, null, NOW).spent).toBe(0);
    expect(readProfile("u1", { spent: Number.NaN }, null, NOW).spent).toBe(0);
    expect(readProfile("u1", { spent: Number.POSITIVE_INFINITY }, null, NOW).spent).toBe(0);
  });

  it("bounds the spend, so one bad number cannot make the purse meaningless", () => {
    expect(readProfile("u1", { spent: 1e30 }, null, NOW).spent).toBeLessThanOrEqual(1_000_000_000);
  });

  it("treats anything but true as not gathering", () => {
    /* Consent is a yes, not the absence of a no. */
    expect(readProfile("u1", { gathering: "yes" }, null, NOW).gathering).toBe(false);
    expect(readProfile("u1", { gathering: 1 }, null, NOW).gathering).toBe(false);
    expect(readProfile("u1", { gathering: true }, null, NOW).gathering).toBe(true);
  });

  it("cuts an over-long skin id rather than storing it", () => {
    const profile = readProfile("u1", { skin_id: "x".repeat(500) }, null, NOW);
    expect(profile.skinId.length).toBeLessThanOrEqual(32);
  });

  it("keeps what you wear apart from what your soldiers wear", () => {
    /*
     * Two choices, two fields. Packing both into one would be storing two facts
     * in one place and parsing them apart for ever after.
     */
    const profile = readProfile("u1", { skin_id: "gilt", livery_id: "moss" }, null, NOW);
    expect(profile.skinId).toBe("gilt");
    expect(profile.liveryId).toBe("moss");
  });

  it("survives a body that is empty", () => {
    expect(() => readProfile("u1", {}, null, NOW)).not.toThrow();
  });
});

describe("what the client reads back", () => {
  it("is snake case, like the rest of this API", () => {
    const wire = profileForApi(saved({ characterClass: "codex", tokens: 12 }));
    expect(Object.keys(wire).sort()).toEqual([
      "character_class",
      "gathering",
      "livery_id",
      "owned",
      "skin_id",
      "spent",
      "tokens",
      "updated_at",
    ]);
    expect(wire.character_class).toBe("codex");
  });

  it("does not hand back the uid", () => {
    /* The caller knows who they are; repeating it is a field to keep in step. */
    expect(profileForApi(saved())).not.toHaveProperty("uid");
  });

  it("round-trips through a save without drifting", () => {
    const first = readProfile("u1", { character_class: "codex", owned: ["ash"], spent: 30 }, null, NOW);
    const again = readProfile("u1", profileForApi(first), first, NOW);
    expect(again.characterClass).toBe(first.characterClass);
    expect(again.owned).toEqual(first.owned);
    expect(again.spent).toBe(first.spent);
  });
});
