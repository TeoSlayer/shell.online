import { describe, expect, it } from "vitest";
import { SESSION_KINDS } from "../../lib/session-kinds";
import { CLASS_LORE } from "../lore/world";
import { UNIT_FOR, unitFor } from "./units";

describe("Shell Keep sprite coverage", () => {
  it("gives every supported session class its own intentional sprite", () => {
    const classes = SESSION_KINDS.map((kind) => kind.id);
    expect(Object.keys(CLASS_LORE).sort()).toEqual(classes.sort());
    for (const kind of classes) expect(UNIT_FOR[kind]).toBeTruthy();
    expect(new Set(classes.map(unitFor)).size).toBe(classes.length);
  });

  it("covers every non-session actor drawn from the atlas", () => {
    for (const kind of ["soldier", "mite", "crawler", "heisenbug"]) {
      expect(UNIT_FOR[kind]).toBeTruthy();
    }
  });
});
