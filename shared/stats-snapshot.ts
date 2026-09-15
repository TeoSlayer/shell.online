import {
  RETENTION_WEEKS,
  UNIQUE_SURFACES,
  VISITOR_MEMORY_DAYS,
  isUniqueSurface,
  type StatsAccounts,
  type StatsBreakdownItem,
  type StatsFunnelStep,
  type StatsRange,
  type StatsRetentionCohort,
  type StatsSeriesPoint,
  type StatsSnapshot,
  type StatsTargetMetric,
  type StatsUniqueCount,
  type StatsUniqueDay,
  type StatsUniques,
  type UniqueSurface,
} from "./stats";

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const STATS_PRESENCE_REFRESH_MS = 45_000;
export const STATS_PRESENCE_LEASE_MS = 3 * 60 * 1_000;

export interface MetricSummaryRow extends Record<string, string | number | null> {
  event: string;
  target: string;
  count: number;
  value_sum: number;
  value_max: number;
  auxiliary_sum: number;
  auxiliary_max: number;
}

export interface MetricTrendRow extends Record<string, string | number | null> {
  bucket: number;
  event: string;
  count: number;
}

export interface BreakdownRow extends Record<string, string | number | null> {
  name: string;
  count: number;
}

export interface LivePresenceRow extends Record<string, string | number | null> {
  active_sessions: number;
  active_viewers: number;
}

/** Distinct visitor hashes seen on one surface in the range, and how many were first seen in it. */
export interface UniqueSummaryRow extends Record<string, string | number | null> {
  surface: string;
  unique_count: number;
  new_count: number;
}

export interface UniqueDayRow extends Record<string, string | number | null> {
  day: number;
  surface: string;
  unique_count: number;
}

/** One visitor on one day, with the day they were first seen, for the cohort grids. */
export interface RetentionRow extends Record<string, string | number | null> {
  surface: string;
  visitor: string;
  first_day: number;
  day: number;
}

export interface StatsSnapshotRows {
  summary: MetricSummaryRow[];
  trend: MetricTrendRow[];
  devices: BreakdownRow[];
  referrers: BreakdownRow[];
  clients: BreakdownRow[];
  live: LivePresenceRow;
  collectingSince: number | null;
  uniques: UniqueSummaryRow[];
  uniqueDays: UniqueDayRow[];
  retention: RetentionRow[];
  uniquesConfigured: boolean;
}

/** Midnight UTC of the day that contains `at`. */
export function dayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** Monday 00:00 UTC of the week that contains `at`. */
export function weekStart(at: number): number {
  const day = dayStart(at);
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return day - sinceMonday * DAY_MS;
}

export function buildStatsSnapshot(
  rows: StatsSnapshotRows,
  range: StatsRange,
  now: number,
  rangeStart: number,
  accounts: StatsAccounts = null,
): StatsSnapshot {
  const total = (event: string, target?: string): number => rows.summary
    .filter((row) => row.event === event && (target === undefined || row.target === target))
    .reduce((sum, row) => sum + Number(row.count), 0);
  const ended = rows.summary.filter((row) => row.event === "session_ended");
  const endedCount = ended.reduce((sum, row) => sum + Number(row.count), 0);
  const durationSum = ended.reduce((sum, row) => sum + Number(row.value_sum), 0);
  const peakViewerSum = ended.reduce((sum, row) => sum + Number(row.auxiliary_sum), 0);
  const sessionsCreated = total("session_created");
  const sessionsStarted = total("session_started");
  const sharesOpened = total("share_opened");
  const collaborations = total("collaboration_started");
  const landingViews = total("page_view", "landing");
  const docsViews = rows.summary
    .filter((row) => row.event === "page_view" && row.target.startsWith("docs"))
    .reduce((sum, row) => sum + Number(row.count), 0);
  const ctaClicks = total("cta_click");
  const binaryDownloads = total("binary_download");
  const trendStepMs = statsTrendStep(range, now - rangeStart);
  const uniques = buildUniques(rows);

  const metrics: StatsSnapshot["metrics"] = {
    activeSessions: Math.max(0, Number(rows.live.active_sessions)),
    activeViewers: Math.max(0, Number(rows.live.active_viewers)),
    sessionsCreated,
    sessionsStarted,
    sharesOpened,
    viewerConnections: total("viewer_connected"),
    collaborations,
    landingViews,
    docsViews,
    terminalViews: total("page_view", "session"),
    notFoundViews: total("page_view", "not_found"),
    unknownPaths: total("page_view", "unknown_path"),
    ctaClicks,
    installs: total("installer_download"),
    skillDownloads: total("skill_download"),
    binaryDownloads,
    copies: total("copy"),
    averageDurationSeconds: endedCount === 0 ? 0 : durationSum / endedCount,
    longestDurationSeconds: ended.reduce(
      (maximum, row) => Math.max(maximum, Number(row.value_max)),
      0,
    ),
    averagePeakViewers: endedCount === 0 ? 0 : peakViewerSum / endedCount,
    maximumPeakViewers: ended.reduce(
      (maximum, row) => Math.max(maximum, Number(row.auxiliary_max)),
      0,
    ),
  };

  return {
    version: 2,
    generatedAt: now,
    collectingSince: rows.collectingSince,
    range,
    rangeStart,
    trendStepMs,
    metrics,
    rates: {
      started: ratio(sessionsStarted, sessionsCreated),
      shared: ratio(sharesOpened, sessionsCreated),
      collaborated: ratio(collaborations, sessionsCreated),
      signup: ratio(ctaClicks, landingViews),
      installed: ratio(binaryDownloads, landingViews),
    },
    funnel: buildFunnel(metrics, uniques),
    uniques,
    retention: {
      weeks: RETENTION_WEEKS,
      site: buildRetentionCohorts(rows.retention.filter((row) => row.surface === "site"), now),
      cli: buildRetentionCohorts(rows.retention.filter((row) => row.surface === "cli"), now),
    },
    accounts,
    trend: buildTrend(rows.trend, rangeStart, now, trendStepMs),
    breakdowns: {
      devices: breakdown(rows.devices),
      referrers: breakdown(rows.referrers),
      clients: breakdown(rows.clients),
      copies: targetBreakdown(rows.summary, "copy"),
      downloads: [
        ...targetBreakdown(rows.summary, "installer_download"),
        ...targetBreakdown(rows.summary, "skill_download"),
        ...targetBreakdown(rows.summary, "binary_download"),
      ].sort((left, right) => right.value - left.value),
      outcomes: targetBreakdown(rows.summary, "session_ended"),
      pages: targetBreakdown(rows.summary, "page_view"),
    },
    targets: rows.summary.map((row): StatsTargetMetric => ({
      event: row.event,
      target: row.target,
      count: Number(row.count),
      value: Number(row.value_sum),
      maximum: Number(row.value_max),
      auxiliary: Number(row.auxiliary_sum),
      auxiliaryMaximum: Number(row.auxiliary_max),
    })),
  };
}

/*
 * The path from a first look to a first keystroke, one row per step, each
 * saying what it counts. A step's count is an event total; its unique figure
 * is how many distinct people were behind it, on the surfaces that count
 * people. The two are shown side by side rather than blended, because a
 * hundred page views from one crawler and a hundred visitors are different
 * news.
 */
export function buildFunnel(
  metrics: StatsSnapshot["metrics"],
  uniques: StatsUniques,
): StatsFunnelStep[] {
  const people = (surface: UniqueSurface): number | null =>
    uniques.configured ? uniques.surfaces[surface].unique : null;
  return [
    {
      key: "visited",
      label: "Visited the site",
      count: metrics.landingViews + metrics.docsViews,
      unique: people("site"),
      note: "Landing and documentation page views. Crawlers count as views, not as people.",
      basis: null,
    },
    {
      key: "signup",
      label: "Clicked Sign up",
      count: metrics.ctaClicks,
      unique: null,
      note: "Any Sign up free or Web app link on the landing page.",
      basis: "visited",
    },
    {
      key: "installer",
      label: "Fetched the installer",
      count: metrics.installs,
      unique: people("install"),
      note: "Requests for the install script. Reading it counts; so does piping it to sh.",
      basis: "visited",
    },
    {
      key: "installed",
      label: "Completed an install",
      count: metrics.binaryDownloads,
      unique: null,
      note: "Release binaries served, the installer's last step. Homebrew and source builds are not in this number.",
      basis: "installer",
    },
    {
      key: "session",
      label: "Started a session",
      count: metrics.sessionsStarted,
      unique: people("cli"),
      note: "A shell command connected its process to the relay. Not a share of the step before: sessions come from every install to date.",
      basis: null,
    },
    {
      key: "opened",
      label: "Opened it in a browser",
      count: metrics.sharesOpened,
      unique: people("viewer"),
      note: "Sessions whose link was opened at least once, by anyone, the owner included.",
      basis: "session",
    },
    {
      key: "typed",
      label: "Typed from a browser",
      count: metrics.collaborations,
      unique: null,
      note: "Sessions that received at least one keystroke from a browser.",
      basis: "opened",
    },
  ];
}

/**
 * Weekly cohorts from (visitor, first day, day) rows.
 *
 * A cohort is everyone first seen in one week. For each later week, the count
 * is how many of them were seen at all in that week, so the grid reads as
 * "of the 40 who arrived that week, 12 were back the week after". The current
 * week is included as it stands and grows until it ends.
 */
export function buildRetentionCohorts(
  rows: Pick<RetentionRow, "visitor" | "first_day" | "day">[],
  now: number,
  weeks = RETENTION_WEEKS,
): StatsRetentionCohort[] {
  const thisWeek = weekStart(now);
  const earliest = thisWeek - (weeks - 1) * WEEK_MS;
  const cohorts = new Map<number, Map<string, Set<number>>>();
  for (const row of rows) {
    const cohortWeek = weekStart(Number(row.first_day));
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
    const later = Math.round((weekStart(Number(row.day)) - cohortWeek) / WEEK_MS);
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

function buildUniques(rows: StatsSnapshotRows): StatsUniques {
  const surfaces = Object.fromEntries(
    UNIQUE_SURFACES.map((surface): [UniqueSurface, StatsUniqueCount] => [surface, { unique: 0, new: 0, returning: 0 }]),
  ) as Record<UniqueSurface, StatsUniqueCount>;
  for (const row of rows.uniques) {
    if (!isUniqueSurface(row.surface)) continue;
    const unique = Number(row.unique_count);
    const fresh = Math.min(unique, Number(row.new_count));
    surfaces[row.surface] = { unique, new: fresh, returning: unique - fresh };
  }
  const days = new Map<number, StatsUniqueDay>();
  for (const row of rows.uniqueDays) {
    if (!isUniqueSurface(row.surface)) continue;
    const day = Number(row.day);
    const point = days.get(day) ?? { day, site: 0, cli: 0, viewer: 0, install: 0 };
    point[row.surface] = Number(row.unique_count);
    days.set(day, point);
  }
  return {
    configured: rows.uniquesConfigured,
    memoryDays: VISITOR_MEMORY_DAYS,
    surfaces,
    daily: [...days.values()].sort((left, right) => left.day - right.day),
  };
}

export function statsRangeStart(
  range: StatsRange,
  now: number,
  collectingSince: number | null,
): number {
  if (range === "24h") return now - DAY_MS;
  if (range === "7d") return now - 7 * DAY_MS;
  if (range === "30d") return now - 30 * DAY_MS;
  return collectingSince ?? now - DAY_MS;
}

function statsTrendStep(range: StatsRange, duration: number): number {
  if (range === "24h") return HOUR_MS;
  if (range === "7d") return 6 * HOUR_MS;
  if (range === "30d") return DAY_MS;
  if (duration <= 45 * DAY_MS) return DAY_MS;
  if (duration <= 400 * DAY_MS) return 7 * DAY_MS;
  return 30 * DAY_MS;
}

function buildTrend(
  rows: MetricTrendRow[],
  rangeStart: number,
  now: number,
  stepMs: number,
): StatsSeriesPoint[] {
  const start = Math.floor(rangeStart / stepMs) * stepMs;
  const end = Math.floor(now / stepMs) * stepMs;
  const points = new Map<number, StatsSeriesPoint>();
  for (let at = start; at <= end; at += stepMs) {
    points.set(at, { at, sessions: 0, shares: 0, collaborations: 0, pageViews: 0 });
  }
  for (const row of rows) {
    const at = Math.floor(Number(row.bucket) / stepMs) * stepMs;
    const point = points.get(at);
    if (!point) continue;
    const count = Number(row.count);
    if (row.event === "session_created") point.sessions += count;
    if (row.event === "share_opened") point.shares += count;
    if (row.event === "collaboration_started") point.collaborations += count;
    if (row.event === "page_view") point.pageViews += count;
  }
  return Array.from(points.values()).slice(-180);
}

function breakdown(rows: BreakdownRow[]): StatsBreakdownItem[] {
  return rows
    .map((row) => ({ label: row.name, value: Number(row.count) }))
    .filter((row) => row.value > 0);
}

function targetBreakdown(rows: MetricSummaryRow[], event: string): StatsBreakdownItem[] {
  return rows
    .filter((row) => row.event === event && Number(row.count) > 0)
    .map((row) => ({ label: row.target, value: Number(row.count) }))
    .sort((left, right) => right.value - left.value);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.min(1, numerator / denominator);
}
