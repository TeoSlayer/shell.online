import { describe, expect, it } from "vitest";
import {
  formatGitHubStarCount,
  readGitHubApiStarCount,
  readGitHubSummaryStarCount,
} from "../shared/github";

describe("GitHub repository summary", () => {
  it("accepts only valid non-negative integer star counts", () => {
    expect(readGitHubApiStarCount({ stargazers_count: 42 })).toBe(42);
    expect(readGitHubSummaryStarCount({ stars: 0 })).toBe(0);
    expect(readGitHubApiStarCount({ stargazers_count: -1 })).toBeNull();
    expect(readGitHubSummaryStarCount({ stars: "42" })).toBeNull();
    expect(readGitHubSummaryStarCount(null)).toBeNull();
  });

  it("keeps small counts exact and compacts large counts", () => {
    expect(formatGitHubStarCount(0)).toBe("0");
    expect(formatGitHubStarCount(999)).toBe("999");
    expect(formatGitHubStarCount(1_200)).toBe("1.2k");
  });
});
