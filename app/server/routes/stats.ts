import type { AccountActivity } from "../lib/store";
import type { AppEventCount } from "../lib/types";

/*
 * Account figures for the statistics dashboard on stats.shell.online.
 *
 * The relay's dashboard counts people by keyed hashes, which is the best it
 * can do without accounts. This app has the exact thing: an account signed up
 * on a day and used the app on some days after. What leaves here is
 * aggregates only, computed from rows that carry no identifier, so the
 * dashboard learns how many and never who.
 */

export const STATS_RANGES = ["24h", "7d", "30d", "all"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export const DAY_MS = 24 * 60 * 60_000;
export const WEEK_MS = 7 * DAY_MS;
/** How many weekly sign-up cohorts the dashboard shows. Matches the relay's. */
export const RETENTION_WEEKS = 8;
/** How many days of new-account counts are sent, whatever the range. */
export const NEW_BY_DAY_LIMIT = 90;
/** How long an account's activity days are kept. */
export const ACCOUNT_ACTIVITY_MEMORY_MS = 400 * DAY_MS;

export interface RetentionCohort {
  weekStart: number;
  size: number;
  /** active[0] is the week after the sign-up week, and so on. */
  active: number[];
}

/** How many accounts have used the app on how many separate days. */
export const ENGAGEMENT_BUCKETS = [
  { label: "one_day", from: 1, to: 1 },
  { label: "two_days", from: 2, to: 2 },
  { label: "three_to_six_days", from: 3, to: 6 },
  { label: "seven_or_more_days", from: 7, to: Number.POSITIVE_INFINITY },
] as const;

/** The headline counts over one period, so a range can be read against the one before it. */
export interface AccountPeriod {
  /** Accounts in existence at the end of the period. */
  total: number;
  /** Of those, that signed up during it. */
  newAccounts: number;
  /** Accounts that used the app during it. */
  active: number;
  /** Of the active, that had signed up before it began: the ones that came back. */
  returning: number;
}

export interface AccountStats {
  /** Accounts there are now. */
  total: number;
  /** Of those, that signed up in the range. */
  newInRange: number;
  /** Accounts that used the app in the range. */
  activeInRange: number;
  /** Of the active, that had signed up before the range began. */
  returningInRange: number;
  /** The same four over the period of equal length before the range, or null over all time. */
  previous: AccountPeriod | null;
  newByDay: { day: number; count: number }[];
  /** Accounts that used the app on each day, over the same days as newByDay. */
  activeByDay: { day: number; count: number }[];
  /**
   * Accounts by how many separate days they have ever used the app, over the
   * accounts that signed up since activity was first recorded. An account
   * that signed up before that has days missing through no fault of its own,
   * and would read as a bounce.
   */
  engagement: { label: string; value: number }[];
  /** How many accounts the engagement figures are over. */
  engagementBase: number;
  /** Midnight UTC of the first day any account was recorded as active, or null. */
  activeSince: number | null;
  /** Accounts left out of every figure above because they are ours. */
  excluded: number;
  cohorts: RetentionCohort[];
  /** Things done in the range, by kind: machines linked, commands sent. Counts of things, not of accounts. */
  events: Record<string, number>;
}

export function isStatsRange(value: unknown): value is StatsRange {
  return typeof value === "string" && (STATS_RANGES as readonly string[]).includes(value);
}

export function dayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** Monday 00:00 UTC of the week containing `at`. */
export function weekStart(at: number): number {
  const day = dayStart(at);
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return day - sinceMonday * DAY_MS;
}

export function rangeStart(range: StatsRange, now: number): number {
  if (range === "24h") return now - DAY_MS;
  if (range === "7d") return now - 7 * DAY_MS;
  if (range === "30d") return now - 30 * DAY_MS;
  return 0;
}

/**
 * The account figures for one range.
 *
 * Our own accounts are dropped before anything is counted, and only the
 * number of them dropped is reported: the dashboard is read as product
 * signal, and the team's accounts are the most active there are. See
 * internal-accounts.ts.
 */
export function accountStats(
  activity: AccountActivity[],
  range: StatsRange,
  now = Date.now(),
  events: AppEventCount[] = [],
): AccountStats {
  const excluded = activity.filter((account) => account.internal).length;
  const accounts = activity.filter((account) => !account.internal);
  const start = rangeStart(range, now);
  const current = countPeriod(accounts, start, now);
  /*
   * The period of equal length before this one, so a headline figure can say
   * how it moved. All time has nothing before it.
   */
  const previous = range === "all" ? null : countPeriod(accounts, start - (now - start), start);

  const today = dayStart(now);
  const firstDay = today - (NEW_BY_DAY_LIMIT - 1) * DAY_MS;
  const newByDay = new Map<number, number>();
  const activeByDay = new Map<number, number>();
  for (let day = firstDay; day <= today; day += DAY_MS) {
    newByDay.set(day, 0);
    activeByDay.set(day, 0);
  }

  let activeSince: number | null = null;
  const rows: { visitor: string; first_day: number; day: number }[] = [];
  accounts.forEach((account, index) => {
    const joinedDay = dayStart(account.joinedAt);
    if (newByDay.has(joinedDay)) newByDay.set(joinedDay, (newByDay.get(joinedDay) ?? 0) + 1);
    /* The recorded days only, so this is when the app started keeping them. */
    for (const day of account.days) {
      const recorded = dayStart(day);
      if (activeSince === null || recorded < activeSince) activeSince = recorded;
    }
    for (const day of activeDays(account)) {
      if (activeByDay.has(day)) activeByDay.set(day, (activeByDay.get(day) ?? 0) + 1);
    }
    /*
     * Cohorts are built from rows shaped like the relay's visitor rows, with
     * the index standing in for a person: it never leaves this function, and
     * two runs of the same data give it to different accounts.
     */
    const visitor = String(index);
    rows.push({ visitor, first_day: joinedDay, day: joinedDay });
    for (const day of account.days) rows.push({ visitor, first_day: joinedDay, day });
  });

  /*
   * Days are only known from the day activity was first recorded, so an
   * account that signed up before it looks like one that never came back.
   * Engagement is over the accounts that signed up since, and says how many
   * that is.
   */
  const measurable = activeSince === null
    ? []
    : accounts.filter((account) => dayStart(account.joinedAt) >= (activeSince as number));

  return {
    total: current.total,
    newInRange: current.newAccounts,
    activeInRange: current.active,
    returningInRange: current.returning,
    previous,
    newByDay: [...newByDay.entries()].map(([day, count]) => ({ day, count })),
    activeByDay: [...activeByDay.entries()].map(([day, count]) => ({ day, count })),
    engagement: ENGAGEMENT_BUCKETS.map((bucket) => ({
      label: bucket.label,
      value: measurable.filter((account) => {
        const days = activeDays(account).length;
        return days >= bucket.from && days <= bucket.to;
      }).length,
    })),
    engagementBase: measurable.length,
    activeSince,
    excluded,
    cohorts: buildRetentionCohorts(rows, now),
    events: Object.fromEntries(events.map((entry) => [entry.event, entry.count])),
  };
}

/**
 * The days an account was in the app.
 *
 * Signing up is using it, so the sign-up day counts even where no activity
 * row was written for it -- which is every account that signed up before
 * activity was recorded at all, and any whose first request predated the
 * first hourly touch.
 */
function activeDays(account: AccountActivity): number[] {
  const days = new Set(account.days.map(dayStart));
  days.add(dayStart(account.joinedAt));
  return [...days].sort((left, right) => left - right);
}

/**
 * The four counts over one period: what existed, what arrived, what was used,
 * and how much of the use came from accounts that were already here.
 *
 * Sign-ups are placed by their exact time, in [start, end). Activity only has
 * a UTC day, so it is matched by day with both ends inclusive; that is what
 * makes a period and the one before it the same number of days, at the cost
 * of the two sharing the day they meet on.
 */
function countPeriod(accounts: AccountActivity[], start: number, end: number): AccountPeriod {
  const startDay = dayStart(start);
  const endDay = dayStart(end);
  let total = 0;
  let newAccounts = 0;
  let active = 0;
  let returning = 0;
  for (const account of accounts) {
    if (account.joinedAt >= end) continue;
    total += 1;
    const isNew = account.joinedAt >= start;
    if (isNew) newAccounts += 1;
    const used = isNew ||
      activeDays(account).some((day) => day >= startDay && day <= endDay);
    if (!used) continue;
    active += 1;
    if (!isNew) returning += 1;
  }
  return { total, newAccounts, active, returning };
}

/*
 * Weekly cohorts, the same way the relay's dashboard builds them from visitor
 * hashes: everyone who signed up in one week, and how many of them used the
 * app in each later week. The current week is included as it stands.
 */
export function buildRetentionCohorts(
  rows: { visitor: string; first_day: number; day: number }[],
  now: number,
  weeks = RETENTION_WEEKS,
): RetentionCohort[] {
  const thisWeek = weekStart(now);
  const earliest = thisWeek - (weeks - 1) * WEEK_MS;
  const cohorts = new Map<number, Map<string, Set<number>>>();
  for (const row of rows) {
    const cohortWeek = weekStart(row.first_day);
    if (cohortWeek < earliest || cohortWeek > thisWeek) continue;
    let members = cohorts.get(cohortWeek);
    if (!members) {
      members = new Map();
      cohorts.set(cohortWeek, members);
    }
    let active = members.get(row.visitor);
    if (!active) {
      active = new Set();
      members.set(row.visitor, active);
    }
    const later = Math.round((weekStart(row.day) - cohortWeek) / WEEK_MS);
    if (later >= 1) active.add(later);
  }
  return [...cohorts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([cohortWeek, members]) => {
      const span = Math.min(weeks - 1, Math.round((thisWeek - cohortWeek) / WEEK_MS));
      const active = Array.from({ length: span }, (_, index) => {
        let count = 0;
        for (const weeksActive of members.values()) if (weeksActive.has(index + 1)) count += 1;
        return count;
      });
      return { weekStart: cohortWeek, size: members.size, active };
    });
}
