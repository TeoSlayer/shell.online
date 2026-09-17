import { describe, expect, it } from "vitest";
import type { Actor } from "../world/sim";
import { sessionBreakdown } from "./session-breakdown";

const wright = (work: Actor["work"]): Actor => ({ work }) as Actor;

describe("the operational session summary", () => {
  it("uses plain session states and counts every visible kind", () => {
    expect(
      sessionBreakdown([
        wright("bug"),
        wright("bug"),
        wright("feature"),
        wright("idle"),
      ]),
    ).toEqual({ fixing: 2, building: 1, waiting: 1 });
  });
});
