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

export interface AccountStats {
  total: number;
  newInRange: number;
  activeInRange: number;
  newByDay: { day: number; count: number }[];
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

export function accountStats(
  activity: AccountActivity[],
  range: StatsRange,
  now = Date.now(),
  events: AppEventCount[] = [],
): AccountStats {
  const start = rangeStart(range, now);
  const startDay = dayStart(start);
  const newByDay = new Map<number, number>();
  const firstDay = dayStart(now) - (NEW_BY_DAY_LIMIT - 1) * DAY_MS;
  for (let day = firstDay; day <= dayStart(now); day += DAY_MS) newByDay.set(day, 0);

  let newInRange = 0;
  let activeInRange = 0;
  const rows: { visitor: string; first_day: number; day: number }[] = [];
  activity.forEach((account, index) => {
    const joinedDay = dayStart(account.joinedAt);
    if (account.joinedAt >= start) newInRange += 1;
    /* Signing up is using it, so a brand-new account is active on its first day. */
    if (account.joinedAt >= start || account.days.some((day) => day >= startDay)) activeInRange += 1;
    if (newByDay.has(joinedDay)) newByDay.set(joinedDay, (newByDay.get(joinedDay) ?? 0) + 1);
    const visitor = String(index);
    rows.push({ visitor, first_day: joinedDay, day: joinedDay });
    for (const day of account.days) rows.push({ visitor, first_day: joinedDay, day });
  });

  return {
    total: activity.length,
    newInRange,
    activeInRange,
    newByDay: [...newByDay.entries()].map(([day, count]) => ({ day, count })),
    cohorts: buildRetentionCohorts(rows, now),
    events: Object.fromEntries(events.map((entry) => [entry.event, entry.count])),
  };
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
