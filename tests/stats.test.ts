import { describe, expect, it } from "vitest";
import { isStatsRange, STATS_RANGES } from "../shared/stats";

describe("statistics dashboard contract", () => {
  it("accepts only the supported bounded ranges", () => {
    expect(STATS_RANGES).toEqual(["24h", "7d", "30d", "all"]);
    expect(isStatsRange("24h")).toBe(true);
    expect(isStatsRange("all")).toBe(true);
    expect(isStatsRange("90d")).toBe(false);
    expect(isStatsRange(null)).toBe(false);
  });
});
