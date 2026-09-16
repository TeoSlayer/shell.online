import { describe, expect, it } from "vitest";
import type { AccountActivity } from "../lib/store";
import { accountStats, buildRetentionCohorts, DAY_MS, WEEK_MS, weekStart } from "./stats";

/* A Monday, so the weeks are easy to read. */
const monday = Date.UTC(2026, 8, 7);
const now = monday + 2 * WEEK_MS + 3 * DAY_MS + 9 * 60 * 60_000;
const today = Math.floor(now / DAY_MS) * DAY_MS;

const customer = (account: Omit<AccountActivity, "internal">): AccountActivity => ({ ...account, internal: false });
const ours = (account: Omit<AccountActivity, "internal">): AccountActivity => ({ ...account, internal: true });

describe("accountStats events", () => {
  it("passes what accounts did through as counts by kind, and an empty object when nothing was counted", () => {
    const stats = accountStats([], "7d", now, [{ event: "machine_linked", count: 2 }, { event: "command_sent", count: 5 }]);
    expect(stats.events).toEqual({ machine_linked: 2, command_sent: 5 });
    expect(accountStats([], "7d", now).events).toEqual({});
  });
});

describe("accountStats", () => {
  const accounts = [
    /* signed up week 0, used it in weeks 1 and 2 */
    customer({ joinedAt: monday + 60_000, days: [monday, monday + WEEK_MS + DAY_MS, monday + 2 * WEEK_MS] }),
    /* signed up week 0, never came back */
    customer({ joinedAt: monday + 3 * DAY_MS, days: [monday + 3 * DAY_MS] }),
    /* signed up yesterday */
    customer({ joinedAt: now - DAY_MS, days: [today - DAY_MS] }),
    /* signed up long ago, active today */
    customer({ joinedAt: monday - 30 * WEEK_MS, days: [today] }),
  ];

  it("counts accounts, new ones, active ones, and the ones that came back", () => {
    const week = accountStats(accounts, "7d", now);
    expect(week.total).toBe(4);
    expect(week.newInRange).toBe(1);
    expect(week.activeInRange).toBe(3);
    /* Active and not new: the account from week 0 and the one from long ago. */
    expect(week.returningInRange).toBe(2);
    const all = accountStats(accounts, "all", now);
    expect(all.newInRange).toBe(4);
    expect(all.activeInRange).toBe(4);
    expect(all.returningInRange).toBe(0);
  });

  it("counts the period before the range the same way, and nothing before all time", () => {
    const week = accountStats(accounts, "7d", now);
    /*
     * The three that had signed up by the start of this week's range; two of
     * them used it in the week before, both having signed up before that.
     */
    expect(week.previous).toEqual({ total: 3, newAccounts: 0, active: 2, returning: 2 });
    expect(accountStats(accounts, "all", now).previous).toBeNull();
  });

  it("sends new accounts per day, with zeros for quiet days", () => {
    const stats = accountStats(accounts, "30d", now);
    expect(stats.newByDay).toHaveLength(90);
    expect(stats.newByDay.reduce((sum, point) => sum + point.count, 0)).toBe(3);
    expect(stats.newByDay.at(-2)?.count).toBe(1);
  });

  it("sends active accounts per day over the same days, counting the sign-up day as use", () => {
    const stats = accountStats(accounts, "30d", now);
    expect(stats.activeByDay.map((point) => point.day)).toEqual(stats.newByDay.map((point) => point.day));
    expect(stats.activeByDay.at(-1)).toEqual({ day: today, count: 1 });
    expect(stats.activeByDay.at(-2)).toEqual({ day: today - DAY_MS, count: 1 });
  });

  it("buckets accounts by how many days they used it, over the ones it could know about", () => {
    const stats = accountStats(accounts, "7d", now);
    /* The first day any account was recorded as active; the fourth signed up long before it. */
    expect(stats.activeSince).toBe(monday);
    expect(stats.engagementBase).toBe(3);
    expect(stats.engagement).toEqual([
      { label: "one_day", value: 2 },
      { label: "two_days", value: 0 },
      { label: "three_to_six_days", value: 1 },
      { label: "seven_or_more_days", value: 0 },
    ]);
  });

  it("builds sign-up cohorts without any identifier", () => {
    const stats = accountStats(accounts, "7d", now);
    expect(stats.cohorts).toEqual([
      { weekStart: monday, size: 2, active: [1, 1] },
      { weekStart: monday + 2 * WEEK_MS, size: 1, active: [] },
    ]);
    expect(JSON.stringify(stats)).not.toMatch(/uid|email/);
  });

  it("has nothing to say about an empty app rather than failing", () => {
    const stats = accountStats([], "7d", now);
    expect(stats.total).toBe(0);
    expect(stats.activeSince).toBeNull();
    expect(stats.engagementBase).toBe(0);
    expect(stats.engagement.every((bucket) => bucket.value === 0)).toBe(true);
    expect(stats.cohorts).toEqual([]);
  });
});

describe("accountStats leaves our own accounts out", () => {
  const accounts = [
    customer({ joinedAt: now - 2 * DAY_MS, days: [today - 2 * DAY_MS, today] }),
    ours({ joinedAt: now - 2 * DAY_MS, days: [today - 2 * DAY_MS, today - DAY_MS, today] }),
    ours({ joinedAt: monday, days: [monday, today] }),
  ];

  it("counts them out of every figure and reports how many it left out", () => {
    const stats = accountStats(accounts, "7d", now);
    expect(stats.excluded).toBe(2);
    expect(stats.total).toBe(1);
    expect(stats.newInRange).toBe(1);
    expect(stats.activeInRange).toBe(1);
    expect(stats.engagementBase).toBe(1);
    expect(stats.engagement).toEqual([
      { label: "one_day", value: 0 },
      { label: "two_days", value: 1 },
      { label: "three_to_six_days", value: 0 },
      { label: "seven_or_more_days", value: 0 },
    ]);
    expect(stats.cohorts).toEqual([{ weekStart: weekStart(now), size: 1, active: [] }]);
    expect(stats.activeByDay.at(-1)).toEqual({ day: today, count: 1 });
  });

  it("leaves the figures alone when none of the accounts are ours", () => {
    const outside = accounts.map((account) => ({ ...account, internal: false }));
    const stats = accountStats(outside, "7d", now);
    expect(stats.excluded).toBe(0);
    expect(stats.total).toBe(3);
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
