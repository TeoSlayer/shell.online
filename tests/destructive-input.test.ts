import { describe, expect, it } from "vitest";
import { DestructiveInputGuard } from "../web/destructive-input";

describe("destructive terminal input confirmation", () => {
  it("requires a deliberate repeat inside the confirmation window", () => {
    const guard = new DestructiveInputGuard(3_000);
    expect(guard.confirm(1_000)).toBe(false);
    expect(guard.confirm(3_999)).toBe(true);
    expect(guard.confirm(4_000)).toBe(false);
  });

  it("expires and can be reset", () => {
    const guard = new DestructiveInputGuard(3_000);
    expect(guard.confirm(1_000)).toBe(false);
    expect(guard.confirm(4_001)).toBe(false);
    guard.reset();
    expect(guard.confirm(4_002)).toBe(false);
  });
});
