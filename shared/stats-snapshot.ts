import {
  RETENTION_WEEKS,
  UNIQUE_SURFACES,
  VISITOR_MEMORY_DAYS,
  isUniqueSurface,
  type StatsAccounts,
  type StatsAudience,
  type StatsAudiences,
  type StatsBreakdownItem,
  type StatsComparison,
  type StatsFigures,
  type StatsFunnelExclusion,
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

/** Machines seen installing, and how many of them went on to a first session. */
export interface InstallConversionRow extends Record<string, string | number | null> {
  installers: number | null;
  matured: number | null;
  started: number | null;
}

/** One visitor on one day, with the day they were first seen, for the cohort grids. */
export interface RetentionRow extends Record<string, string | number | null> {
  surface: string;
  visitor: string;
  first_day: number;
  day: number;
}

/** One event's count for one device class in the range. */
export interface AudienceRow extends Record<string, string | number | null> {
  event: string;
  target: string;
  device: string;
  count: number;
}

/** The earliest day people were counted on one surface. */
export interface SurfaceSinceRow extends Record<string, string | number | null> {
  surface: string;
  minimum: number | null;
}

/** Distinct visitor hashes seen on one surface in a period. */
export interface PeriodUniqueRow extends Record<string, string | number | null> {
  surface: string;
  unique_count: number;
}

/** The period of equal length before the range, for comparison. */
export interface PreviousPeriodRows {
  rangeStart: number;
  summary: MetricSummaryRow[];
  byDevice: AudienceRow[];
  uniques: PeriodUniqueRow[];
}

export interface StatsSnapshotRows {
  summary: MetricSummaryRow[];
  byDevice: AudienceRow[];
  /** Null on the all-time range. */
  previous: PreviousPeriodRows | null;
  trend: MetricTrendRow[];
  devices: BreakdownRow[];
  referrers: BreakdownRow[];
  clients: BreakdownRow[];
  openedDevices: BreakdownRow[];
  typedDevices: BreakdownRow[];
  live: LivePresenceRow;
  collectingSince: number | null;
  uniques: UniqueSummaryRow[];
  uniqueDays: UniqueDayRow[];
  retention: RetentionRow[];
  /** Null when people are not counted. */
  installConversion: InstallConversionRow | null;
  uniquesConfigured: boolean;
  /** Midnight UTC of the earliest visitor day still kept, or null when there is none. */
  uniquesSince: number | null;
  /** The same, per surface. */
  uniquesSinceBySurface: SurfaceSinceRow[];
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
  const total = (event: string, target?: string): number => sumCounts(rows.summary, event, target);
  const average = (event: string): number => averageValue(rows.summary, event);
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
  const audiences = buildAudiences(rows.byDevice);
  const figures = buildFigures(rows.summary, audiences);

  const metrics: StatsSnapshot["metrics"] = {
    activeSessions: Math.max(0, Number(rows.live.active_sessions)),
    activeViewers: Math.max(0, Number(rows.live.active_viewers)),
    sessionsCreated,
    sessionsStarted,
    sharesOpened,
    sharesOpenedReadOnly: total("share_opened", "viewer_read_only"),
    viewerConnections: total("viewer_connected"),
    collaborations,
    viewersRejected: total("viewer_rejected"),
    inputDenied: total("input_denied"),
    averageSecondsToOpen: average("share_opened"),
    averageSecondsToType: average("collaboration_started"),
    averageViewerSeconds: average("viewer_disconnected"),
    landingViews,
    docsViews,
    terminalViews: total("page_view", "session"),
    notFoundViews: total("page_view", "not_found"),
    unknownPaths: total("page_view", "unknown_path"),
    ctaClicks,
    installs: total("installer_download"),
    skillDownloads: total("skill_download"),
    binaryDownloads,
    installsReported: total("install_outcome", "ok"),
    installFailuresReported: total("install_outcome") - total("install_outcome", "ok"),
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
    figures,
    audiences,
    previous: buildComparison(rows.previous, rangeStart, rows.collectingSince, uniques),
    funnel: buildFunnel(figures, audiences, uniques),
    installConversion: uniques.configured && rows.installConversion
      ? {
        installers: Number(rows.installConversion.installers ?? 0),
        matured: Number(rows.installConversion.matured ?? 0),
        started: Number(rows.installConversion.started ?? 0),
      }
      : null,
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
      openedDevices: breakdown(rows.openedDevices),
      typedDevices: breakdown(rows.typedDevices),
      rejections: targetBreakdown(rows.summary, "viewer_rejected"),
      installOutcomes: targetBreakdown(rows.summary, "install_outcome"),
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

function sumCounts(rows: MetricSummaryRow[], event: string, target?: string): number {
  return rows
    .filter((row) => row.event === event && (target === undefined || row.target === target))
    .reduce((sum, row) => sum + Number(row.count), 0);
}

/** The mean of an event's value over its occurrences, or zero when there were none. */
function averageValue(rows: MetricSummaryRow[], event: string): number {
  const matching = rows.filter((row) => row.event === event);
  const count = matching.reduce((sum, row) => sum + Number(row.count), 0);
  if (count === 0) return 0;
  return matching.reduce((sum, row) => sum + Number(row.value_sum), 0) / count;
}

const AUDIENCE_EVENTS: Record<keyof StatsAudiences, (event: string, target: string) => boolean> = {
  views: (event, target) => event === "page_view" && (target === "landing" || target.startsWith("docs")),
  installer: (event) => event === "installer_download",
  installs: (event) => event === "binary_download",
  viewers: (event) => event === "viewer_connected",
};

/** Which audience a device class belongs to: the classifier's classes, folded to three that matter and a rest. */
export function audienceOf(device: string): keyof StatsAudience {
  if (device === "desktop" || device === "mobile" || device === "tablet") return "browsers";
  if (device === "cli") return "tools";
  if (device === "bot") return "crawlers";
  return "unknown";
}

export function buildAudiences(rows: AudienceRow[]): StatsAudiences {
  const empty = (): StatsAudience => ({ browsers: 0, tools: 0, crawlers: 0, unknown: 0 });
  const audiences: StatsAudiences = { views: empty(), installer: empty(), installs: empty(), viewers: empty() };
  for (const row of rows) {
    for (const key of Object.keys(AUDIENCE_EVENTS) as (keyof StatsAudiences)[]) {
      if (AUDIENCE_EVENTS[key](row.event, row.target)) audiences[key][audienceOf(row.device)] += Number(row.count);
    }
  }
  return audiences;
}

/** Everything but crawlers: a binary went to a person's machine, whatever fetched it. */
export function installsCompleted(installs: StatsAudience): number {
  return installs.browsers + installs.tools + installs.unknown;
}

export function buildFigures(summary: MetricSummaryRow[], audiences: StatsAudiences): StatsFigures {
  return {
    siteViews: audiences.views.browsers,
    crawlerViews: audiences.views.crawlers,
    ctaClicks: sumCounts(summary, "cta_click"),
    installCopies: sumCounts(summary, "copy", "install") + sumCounts(summary, "copy", "brew_install") + sumCounts(summary, "copy", "source_build"),
    installerRuns: audiences.installer.tools,
    installs: installsCompleted(audiences.installs),
    sessionsStarted: sumCounts(summary, "session_started"),
    neverStarted: sumCounts(summary, "session_ended", "never_started"),
    sharesOpened: sumCounts(summary, "share_opened"),
    sharesOpenedWritable: sumCounts(summary, "share_opened") - sumCounts(summary, "share_opened", "viewer_read_only"),
    collaborations: sumCounts(summary, "collaboration_started"),
  };
}

/**
 * The period before the range, when there is one worth comparing with: not
 * on the all-time range, and not when it reaches back before collection
 * began, since a comparison with an empty period says everything doubled.
 * People are compared only when they were counted for the whole of it.
 */
export function buildComparison(
  previous: PreviousPeriodRows | null,
  rangeStart: number,
  collectingSince: number | null,
  uniques: StatsUniques,
): StatsComparison | null {
  if (!previous || collectingSince === null || previous.rangeStart < collectingSince) return null;
  const audiences = buildAudiences(previous.byDevice);
  const covered = uniques.configured && uniques.since !== null && uniques.since <= dayStart(previous.rangeStart);
  let people: StatsComparison["people"] = null;
  if (covered) {
    people = Object.fromEntries(UNIQUE_SURFACES.map((surface) => [surface, 0])) as Record<UniqueSurface, number>;
    for (const row of previous.uniques) {
      if (isUniqueSurface(row.surface)) people[row.surface] = Number(row.unique_count);
    }
  }
  return {
    rangeStart: previous.rangeStart,
    rangeEnd: rangeStart,
    figures: buildFigures(previous.summary, audiences),
    people,
  };
}

/*
 * The path from a first look to a first keystroke, one row per step, each
 * saying what it counts and what it leaves out. A step's count is of requests
 * that a person is plausibly behind; its unique figure is how many distinct
 * people were, on the surfaces that count people. Crawlers are listed beside
 * the step they were kept out of, because a hundred page views from one
 * crawler and a hundred visitors are different news.
 */
export function buildFunnel(
  figures: StatsFigures,
  audiences: StatsAudiences,
  uniques: StatsUniques,
): StatsFunnelStep[] {
  const people = (surface: UniqueSurface): number | null =>
    uniques.configured ? uniques.surfaces[surface].unique : null;
  const excluded = (entries: StatsFunnelExclusion[]): StatsFunnelExclusion[] => entries.filter((entry) => entry.count > 0);
  return [
    {
      key: "visited",
      label: "Visited the site",
      count: figures.siteViews,
      unique: people("site"),
      note: "Landing and documentation page views from a browser.",
      excluded: excluded([
        { label: "by crawlers", count: audiences.views.crawlers },
        { label: "by tools", count: audiences.views.tools + audiences.views.unknown },
      ]),
      basis: null,
    },
    {
      key: "signup",
      label: "Clicked Sign up",
      count: figures.ctaClicks,
      unique: null,
      note: "Any Sign up free or Web app link on the landing page. Most accounts start elsewhere: the app, an invite, the CLI.",
      excluded: [],
      basis: "visited",
    },
    {
      key: "copied",
      label: "Copied an install command",
      count: figures.installCopies,
      unique: null,
      note: "The curl, Homebrew or source-build command copied on the landing page: intent, before a terminal is involved.",
      excluded: [],
      basis: "visited",
    },
    {
      key: "installer",
      label: "Ran the installer",
      count: figures.installerRuns,
      unique: people("install"),
      note: "The install script fetched by curl or wget, which is how it is run.",
      excluded: excluded([
        { label: "read in a browser", count: audiences.installer.browsers },
        { label: "by crawlers", count: audiences.installer.crawlers },
        { label: "unknown", count: audiences.installer.unknown },
      ]),
      basis: "visited",
    },
    {
      key: "installed",
      label: "Completed an install",
      count: figures.installs,
      unique: null,
      note: "A release binary served, the installer's last step. Homebrew and source builds are not in this number.",
      excluded: excluded([{ label: "by crawlers", count: audiences.installs.crawlers }]),
      basis: "installer",
    },
    {
      key: "session",
      label: "Started a session",
      count: figures.sessionsStarted,
      unique: people("cli"),
      note: "A shell command connected its process to the relay. Not a share of the step before: sessions come from every install to date.",
      excluded: excluded([{ label: "created but never connected", count: figures.neverStarted }]),
      basis: null,
    },
    {
      key: "opened",
      label: "Opened it in a browser",
      count: figures.sharesOpened,
      unique: people("viewer"),
      note: "Sessions whose link was opened at least once, by anyone, the owner included.",
      excluded: [],
      basis: "session",
    },
    {
      key: "typed",
      label: "Typed from a browser",
      count: figures.collaborations,
      unique: null,
      note: "Sessions that received at least one keystroke from a browser. Read-only sessions cannot, so they are not in the share.",
      excluded: excluded([{ label: "opened read-only, typing impossible", count: figures.sharesOpened - figures.sharesOpenedWritable }]),
      basis: "opened",
      basisCount: figures.sharesOpenedWritable,
      basisLabel: "opened sessions that allow typing",
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
    UNIQUE_SURFACES.map((surface): [UniqueSurface, StatsUniqueCount] => [surface, { unique: 0, new: 0, returning: 0, since: null }]),
  ) as Record<UniqueSurface, StatsUniqueCount>;
  for (const row of rows.uniques) {
    if (!isUniqueSurface(row.surface)) continue;
    const unique = Number(row.unique_count);
    const fresh = Math.min(unique, Number(row.new_count));
    surfaces[row.surface] = { ...surfaces[row.surface], unique, new: fresh, returning: unique - fresh };
  }
  if (rows.uniquesConfigured) {
    for (const row of rows.uniquesSinceBySurface) {
      if (isUniqueSurface(row.surface) && row.minimum !== null) surfaces[row.surface].since = Number(row.minimum);
    }
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
    since: rows.uniquesConfigured ? rows.uniquesSince : null,
    surfaces,
    daily: [...days.values()].sort((left, right) => left.day - right.day),
  };
}

/**
 * The day people counts start from, when that is after the range began, or
 * null when people cover the whole range. Events are counted from the first
 * event and people from the day the visitor salt was set, for at most
 * VISITOR_MEMORY_DAYS, so a 30-day range can hold thirty days of events and
 * one day of people. A people figure shown beside an event count over such a
 * range has to say so, or 29,333 views next to 84 people reads as nonsense.
 */
export function peopleCountedSince(
  uniques: Pick<StatsUniques, "configured" | "since"> & { surfaces?: Record<UniqueSurface, Pick<StatsUniqueCount, "since">> },
  rangeStart: number,
  surface?: UniqueSurface,
): number | null {
  if (!uniques.configured) return null;
  const since = surface === undefined ? uniques.since : uniques.surfaces?.[surface]?.since ?? null;
  if (since === null) return null;
  return since > dayStart(rangeStart) ? since : null;
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
    points.set(at, { at, sessions: 0, started: 0, shares: 0, collaborations: 0, pageViews: 0, installs: 0 });
  }
  for (const row of rows) {
    const at = Math.floor(Number(row.bucket) / stepMs) * stepMs;
    const point = points.get(at);
    if (!point) continue;
    const count = Number(row.count);
    if (row.event === "session_created") point.sessions += count;
    if (row.event === "session_started") point.started += count;
    if (row.event === "share_opened") point.shares += count;
    if (row.event === "collaboration_started") point.collaborations += count;
    if (row.event === "page_view") point.pageViews += count;
    if (row.event === "binary_download") point.installs += count;
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
