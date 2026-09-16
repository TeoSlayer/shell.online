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

/** How long after installing a machine has to start a session to count as converted. */
export const INSTALL_CONVERSION_DAYS = 7;

/**
 * Machines followed from a binary download to a first session, by address:
 * the one join the dashboard can make between the installer and the CLI.
 */
export interface StatsInstallConversion {
  /** Machines whose first install was in the range. */
  installers: number;
  /** Of those, installed at least INSTALL_CONVERSION_DAYS ago, so their window has fully elapsed. */
  matured: number;
  /** Of the matured, started a session within the window. */
  started: number;
}

export interface StatsSeriesPoint {
  at: number;
  /** Sessions created. */
  sessions: number;
  /** Sessions whose host connected. */
  started: number;
  shares: number;
  collaborations: number;
  /** Landing and documentation views, crawlers left out. */
  pageViews: number;
  /** Release binaries served, crawlers left out. */
  installs: number;
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
  /**
   * Midnight UTC of the earliest day this surface's people were counted, or
   * null. Surfaces start on different days: machines were re-keyed after
   * visitors were first counted, so a "new" machine and a "new" visitor are
   * measured from different starts.
   */
  since: number | null;
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
  /**
   * Midnight UTC of the earliest day anyone was counted, or null when nobody
   * has been. Events are counted from the first event and people from the
   * day the salt was set, so a range can hold more days of events than of
   * people; peopleCountedSince says when a figure has to say so.
   */
  since: number | null;
  surfaces: Record<UniqueSurface, StatsUniqueCount>;
  daily: StatsUniqueDay[];
}

/**
 * One event's requests by who made them, from the user agent. A browser is a
 * person looking; a tool is a person's machine doing what it was told; a
 * crawler is neither, and is kept out of every figure about people.
 */
export interface StatsAudience {
  /** Desktop, tablet and phone browsers. */
  browsers: number;
  /** curl, wget and the shell CLI. */
  tools: number;
  /** Crawlers, monitors and headless browsers that say so. */
  crawlers: number;
  /** No user agent, or one the classifier could not place. */
  unknown: number;
}

export interface StatsAudiences {
  /** Landing and documentation page views. */
  views: StatsAudience;
  /** Requests for the install script. */
  installer: StatsAudience;
  /** Release binaries served. */
  installs: StatsAudience;
  /** Browser connections to a shared terminal. */
  viewers: StatsAudience;
}

/**
 * The figures the page is built on, each with the crawlers taken out, so a
 * step of the funnel and its comparison with the period before mean the same
 * thing. The raw event totals stay in metrics and the ledger.
 */
export interface StatsFigures {
  /** Landing and documentation views from browsers: people looking. */
  siteViews: number;
  /** The same pages fetched by self-identified crawlers. */
  crawlerViews: number;
  ctaClicks: number;
  /** The curl, Homebrew or source-build command copied on the landing page: intent before the terminal. */
  installCopies: number;
  /** Install script fetches by curl or wget: the installer actually run, not read. */
  installerRuns: number;
  /** Release binaries served to anything but a crawler: an install completed. */
  installs: number;
  sessionsStarted: number;
  /** Sessions that ended without the host ever connecting: a blocked WebSocket, usually. */
  neverStarted: number;
  sharesOpened: number;
  /** Opened sessions that allow typing: the only ones a keystroke can come from. */
  sharesOpenedWritable: number;
  collaborations: number;
}

/** The same figures for the period of equal length before the range. */
export interface StatsComparison {
  rangeStart: number;
  rangeEnd: number;
  figures: StatsFigures;
  /** Distinct people per surface in that period, or null when people were not counted for all of it. */
  people: Record<UniqueSurface, number> | null;
}

/** Requests a funnel step leaves out, so the reader sees what was not counted and why. */
export interface StatsFunnelExclusion {
  label: string;
  count: number;
}

export interface StatsFunnelStep {
  key: string;
  label: string;
  count: number;
  /** Distinct people behind the count, when the surface is counted. */
  unique: number | null;
  /** What the count is, in one sentence, so nobody has to guess. */
  note: string;
  /** What the count leaves out: crawler views, an installer read in a browser. */
  excluded: StatsFunnelExclusion[];
  /** When the share is of part of the basis step, that part and its name: typed, of the opened sessions that allow typing. */
  basisCount?: number;
  basisLabel?: string;
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

/** The account counts over one period, so a range can be read against the one before it. */
export interface StatsAccountPeriod {
  total: number;
  newAccounts: number;
  active: number;
  returning: number;
}

/** How many accounts have used the app on how many separate days. */
export interface StatsAccountEngagement {
  label: string;
  value: number;
}

/**
 * Aggregates the accounts app answers with, when the dashboard is linked to
 * it. Our own accounts are left out of every figure here before it is sent;
 * `excluded` says how many, so the number can be checked rather than trusted.
 */
export interface StatsAccountStats {
  total: number;
  newInRange: number;
  activeInRange: number;
  /** Of the active, that had signed up before the range began: the ones that came back. */
  returningInRange: number;
  /** The same four over the period of equal length before the range, or null over all time. */
  previous: StatsAccountPeriod | null;
  newByDay: { day: number; count: number }[];
  /** Accounts that used the app on each day, over the same days as newByDay. */
  activeByDay: { day: number; count: number }[];
  /** Accounts by how many separate days they have used the app. */
  engagement: StatsAccountEngagement[];
  /** How many accounts the engagement figures are over: those that signed up since activeSince. */
  engagementBase: number;
  /** Midnight UTC of the first day an account was recorded as active, or null. */
  activeSince: number | null;
  /** Accounts left out of every figure here because they are ours. */
  excluded: number;
  cohorts: StatsRetentionCohort[];
  /** Things done in the app in the range, by kind: machines linked, commands sent. Counts of things, not of accounts. */
  events: Record<string, number>;
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
    /** Of those, sessions the owner made read-only, where nobody can type. */
    sharesOpenedReadOnly: number;
    viewerConnections: number;
    collaborations: number;
    /** Browsers that opened a link and were turned away: full, expired or unknown session. */
    viewersRejected: number;
    /** Viewers who tried to type into a read-only session, once each. */
    inputDenied: number;
    /** From creation to the first browser open, over sessions that were opened. */
    averageSecondsToOpen: number;
    /** From the first open to the first keystroke, over sessions that were typed into. */
    averageSecondsToType: number;
    /** How long a viewer stayed connected, over viewers that disconnected. */
    averageViewerSeconds: number;
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
    /** Installers that reported finishing, from the script itself. */
    installsReported: number;
    /** Installers that reported failing, by their own account. */
    installFailuresReported: number;
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
  figures: StatsFigures;
  audiences: StatsAudiences;
  /** Null on the all-time range, or when the period before is older than collection. */
  previous: StatsComparison | null;
  funnel: StatsFunnelStep[];
  /** Null until people are counted. */
  installConversion: StatsInstallConversion | null;
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
    /** Sessions opened, by the device class of the first viewer. */
    openedDevices: StatsBreakdownItem[];
    /** Sessions typed into, by the device class of the first typist. */
    typedDevices: StatsBreakdownItem[];
    /** Why viewers were turned away. */
    rejections: StatsBreakdownItem[];
    /** How installs ended, as the scripts reported. */
    installOutcomes: StatsBreakdownItem[];
  };
  targets: StatsTargetMetric[];
}

export function isStatsRange(value: string | null): value is StatsRange {
  return STATS_RANGES.includes(value as StatsRange);
}

export function isUniqueSurface(value: string): value is UniqueSurface {
  return UNIQUE_SURFACES.includes(value as UniqueSurface);
}
