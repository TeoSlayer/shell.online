export const STATS_RANGES = ["24h", "7d", "30d", "all"] as const;
export type StatsRange = typeof STATS_RANGES[number];

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

export interface StatsSnapshot {
  version: 1;
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
    terminalViews: number;
    installs: number;
    skillDownloads: number;
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
  };
  trend: StatsSeriesPoint[];
  breakdowns: {
    devices: StatsBreakdownItem[];
    referrers: StatsBreakdownItem[];
    clients: StatsBreakdownItem[];
    copies: StatsBreakdownItem[];
    downloads: StatsBreakdownItem[];
    outcomes: StatsBreakdownItem[];
  };
  targets: StatsTargetMetric[];
}

export function isStatsRange(value: string | null): value is StatsRange {
  return STATS_RANGES.includes(value as StatsRange);
}
