import { describe, expect, it } from "vitest";
import { reconcile } from "./remote";
import { NEW_SAVE, type Save } from "./save";

const save = (overrides: Partial<Save> = {}): Save => ({ ...NEW_SAVE, ...overrides });

describe("reconciling two saves", () => {
  it("keeps a class that has been chosen anywhere", () => {
    expect(reconcile(save(), save({ characterClass: "codex" })).characterClass).toBe("codex");
    expect(reconcile(save({ characterClass: "hermes" }), save()).characterClass).toBe("hermes");
  });

  it("keeps every skin bought on either machine", () => {
    const merged = reconcile(save({ owned: ["ash"] }), save({ owned: ["gilt"] }));
    expect(merged.owned.sort()).toEqual(["ash", "gilt"]);
  });

  it("keeps the larger spend, because hats cannot become unbought", () => {
    expect(reconcile(save({ spent: 100 }), save({ spent: 300 })).spent).toBe(300);
    expect(reconcile(save({ spent: 300 }), save({ spent: 100 })).spent).toBe(300);
  });

  it("never lets a fresh browser wipe a keep", () => {
    /*
     * The failure this exists for. Taking "most recently written" would mean a
     * tab somebody opened on a borrowed laptop, played for nothing and left,
     * could overwrite months of progress. Nothing here goes backwards.
     */
    const played = save({ characterClass: "openclaw", owned: ["ash", "gilt"], spent: 300 });
    const fresh = save();
    const merged = reconcile(fresh, played);
    expect(merged.characterClass).toBe("openclaw");
    expect(merged.owned.sort()).toEqual(["ash", "gilt"]);
    expect(merged.spent).toBe(300);
  });

  it("wears what this browser was wearing, if it is owned", () => {
    const merged = reconcile(
      save({ skinId: "ash", owned: ["ash"] }),
      save({ skinId: "gilt", owned: ["gilt"] }),
    );
    expect(merged.skinId).toBe("ash");
  });

  it("falls back when this browser is wearing something it does not own", () => {
    /* A hand-edited local save should not dress you in something unbought. */
    const merged = reconcile(save({ skinId: "smuggled" }), save({ skinId: "gilt", owned: ["gilt"] }));
    expect(merged.skinId).toBe("gilt");
  });

  it("keeps consent once it has been given", () => {
    expect(reconcile(save(), save({ gathering: true })).gathering).toBe(true);
  });
});
