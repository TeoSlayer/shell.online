import { describe, expect, it } from "vitest";
import { accountStats, buildRetentionCohorts, DAY_MS, WEEK_MS, weekStart } from "./stats";

/* A Monday, so the weeks are easy to read. */
const monday = Date.UTC(2026, 8, 7);
const now = monday + 2 * WEEK_MS + 3 * DAY_MS + 9 * 60 * 60_000;

describe("accountStats", () => {
  const accounts = [
    /* signed up week 0, used it in weeks 1 and 2 */
    { joinedAt: monday + 60_000, days: [monday, monday + WEEK_MS + DAY_MS, monday + 2 * WEEK_MS] },
    /* signed up week 0, never came back */
    { joinedAt: monday + 3 * DAY_MS, days: [monday + 3 * DAY_MS] },
    /* signed up yesterday */
    { joinedAt: now - DAY_MS, days: [Math.floor((now - DAY_MS) / DAY_MS) * DAY_MS] },
    /* signed up long ago, active today */
    { joinedAt: monday - 30 * WEEK_MS, days: [Math.floor(now / DAY_MS) * DAY_MS] },
  ];

  it("counts accounts, new ones, and active ones for the range", () => {
    const week = accountStats(accounts, "7d", now);
    expect(week.total).toBe(4);
    expect(week.newInRange).toBe(1);
    expect(week.activeInRange).toBe(3);
    const all = accountStats(accounts, "all", now);
    expect(all.newInRange).toBe(4);
    expect(all.activeInRange).toBe(4);
  });

  it("sends new accounts per day, with zeros for quiet days", () => {
    const stats = accountStats(accounts, "30d", now);
    expect(stats.newByDay).toHaveLength(90);
    expect(stats.newByDay.reduce((sum, point) => sum + point.count, 0)).toBe(3);
    expect(stats.newByDay.at(-2)?.count).toBe(1);
  });

  it("builds sign-up cohorts without any identifier", () => {
    const stats = accountStats(accounts, "7d", now);
    expect(stats.cohorts).toEqual([
      { weekStart: monday, size: 2, active: [1, 1] },
      { weekStart: monday + 2 * WEEK_MS, size: 1, active: [] },
    ]);
    expect(JSON.stringify(stats)).not.toMatch(/uid|email/);
  });
});

describe("buildRetentionCohorts", () => {
  it("starts weeks on Monday and counts a person once per later week", () => {
    expect(weekStart(monday + 6 * DAY_MS + 5 * 60 * 60_000)).toBe(monday);
    const rows = [
      { visitor: "a", first_day: monday, day: monday },
      { visitor: "a", first_day: monday, day: monday + WEEK_MS },
      { visitor: "a", first_day: monday, day: monday + WEEK_MS + DAY_MS },
      { visitor: "b", first_day: monday + DAY_MS, day: monday + DAY_MS },
    ];
    expect(buildRetentionCohorts(rows, now, 8)).toEqual([{ weekStart: monday, size: 2, active: [1, 0] }]);
  });
});
