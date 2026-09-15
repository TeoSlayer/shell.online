export const STATS_RANGES = ["24h", "7d", "30d", "all"] as const;
export type StatsRange = typeof STATS_RANGES[number];

/*
 * The four places a person can be counted once. A visitor to the site, a
 * machine running the CLI, a browser opening a shared terminal, and a machine
 * fetching the installer are different people often enough to be kept apart.
 */
export const UNIQUE_SURFACES = ["site", "cli", "viewer", "install"] as const;
export type UniqueSurface = typeof UNIQUE_SURFACES[number];

/** How long the dashboard remembers a visitor hash, so "new" has a meaning. */
export const VISITOR_MEMORY_DAYS = 120;

/** How many weekly cohorts the retention grids show. */
export const RETENTION_WEEKS = 8;

export interface StatsSeriesPoint {
  at: number;
  sessions: number;
  shares: number;
  collaborations: number;
  pageViews: number;
}

export interface StatsBreakdownItem {
  label: string;
  value: number;
}

export interface StatsTargetMetric {
  event: string;
  target: string;
  count: number;
  value: number;
  maximum: number;
  auxiliary: number;
  auxiliaryMaximum: number;
}

export interface StatsUniqueCount {
  /** Distinct people seen in the range. */
  unique: number;
  /** Of those, first seen in the range. */
  new: number;
  /** Of those, seen before the range began. */
  returning: number;
}

export interface StatsUniqueDay {
  day: number;
  site: number;
  cli: number;
  viewer: number;
  install: number;
}

export interface StatsUniques {
  /** False until the Worker has a visitor salt; every count is then zero. */
  configured: boolean;
  memoryDays: number;
  surfaces: Record<UniqueSurface, StatsUniqueCount>;
  daily: StatsUniqueDay[];
}

export interface StatsFunnelStep {
  key: string;
  label: string;
  count: number;
  /** Distinct people behind the count, when the surface is counted. */
  unique: number | null;
  /** What the count is, in one sentence, so nobody has to guess. */
  note: string;
  /**
   * The step this one is a share of, or null when it is its own population:
   * sessions in a range come from every install ever made, not from this
   * range's installs, so a percentage there would mislead.
   */
  basis: string | null;
}

/**
 * One weekly cohort: everyone first seen in the week starting at weekStart,
 * and how many of them were seen again in each later week. active[0] is the
 * week after the first; the current, unfinished week is included as it stands.
 */
export interface StatsRetentionCohort {
  weekStart: number;
  size: number;
  active: number[];
}

export interface StatsRetention {
  weeks: number;
  site: StatsRetentionCohort[];
  cli: StatsRetentionCohort[];
}

/** Aggregates the accounts app answers with, when the dashboard is linked to it. */
export interface StatsAccountStats {
  total: number;
  newInRange: number;
  activeInRange: number;
  newByDay: { day: number; count: number }[];
  cohorts: StatsRetentionCohort[];
}

export type StatsAccounts = StatsAccountStats | { error: string } | null;

export interface StatsSnapshot {
  version: 2;
  generatedAt: number;
  collectingSince: number | null;
  range: StatsRange;
  rangeStart: number;
  trendStepMs: number;
  metrics: {
    activeSessions: number;
    activeViewers: number;
    sessionsCreated: number;
    sessionsStarted: number;
    sharesOpened: number;
    viewerConnections: number;
    collaborations: number;
    landingViews: number;
    docsViews: number;
    terminalViews: number;
    /** Documents answered with a 404. */
    notFoundViews: number;
    /** Paths the site did not know but answered anyway, with the landing page. */
    unknownPaths: number;
    /** Sign up free and Web app links clicked on the landing page. */
    ctaClicks: number;
    /** Requests for the install script, which humans and crawlers both make. */
    installs: number;
    skillDownloads: number;
    /** Release binaries served: the installer's last step, so a completed install. */
    binaryDownloads: number;
    copies: number;
    averageDurationSeconds: number;
    longestDurationSeconds: number;
    averagePeakViewers: number;
    maximumPeakViewers: number;
  };
  rates: {
    started: number;
    shared: number;
    collaborated: number;
    /** Sign-up clicks per landing view. */
    signup: number;
    /** Completed installs per landing view. */
    installed: number;
  };
  funnel: StatsFunnelStep[];
  uniques: StatsUniques;
  retention: StatsRetention;
  accounts: StatsAccounts;
  trend: StatsSeriesPoint[];
  breakdowns: {
    devices: StatsBreakdownItem[];
    referrers: StatsBreakdownItem[];
    clients: StatsBreakdownItem[];
    copies: StatsBreakdownItem[];
    downloads: StatsBreakdownItem[];
    outcomes: StatsBreakdownItem[];
    pages: StatsBreakdownItem[];
  };
  targets: StatsTargetMetric[];
}

export function isStatsRange(value: string | null): value is StatsRange {
  return STATS_RANGES.includes(value as StatsRange);
}

export function isUniqueSurface(value: string): value is UniqueSurface {
  return UNIQUE_SURFACES.includes(value as UniqueSurface);
}
