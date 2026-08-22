import {
  type StatsBreakdownItem,
  type StatsRange,
  type StatsSeriesPoint,
  type StatsSnapshot,
  type StatsTargetMetric,
} from "./stats";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
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

export interface StatsSnapshotRows {
  summary: MetricSummaryRow[];
  trend: MetricTrendRow[];
  devices: BreakdownRow[];
  referrers: BreakdownRow[];
  clients: BreakdownRow[];
  live: LivePresenceRow;
  collectingSince: number | null;
}

export function buildStatsSnapshot(
  rows: StatsSnapshotRows,
  range: StatsRange,
  now: number,
  rangeStart: number,
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
  const trendStepMs = statsTrendStep(range, now - rangeStart);

  return {
    version: 1,
    generatedAt: now,
    collectingSince: rows.collectingSince,
    range,
    rangeStart,
    trendStepMs,
    metrics: {
      activeSessions: Math.max(0, Number(rows.live.active_sessions)),
      activeViewers: Math.max(0, Number(rows.live.active_viewers)),
      sessionsCreated,
      sessionsStarted,
      sharesOpened,
      viewerConnections: total("viewer_connected"),
      collaborations,
      landingViews: total("page_view", "landing"),
      terminalViews: total("page_view", "session"),
      installs: total("installer_download"),
      skillDownloads: total("skill_download"),
      binaryDownloads: total("binary_download"),
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
    },
    rates: {
      started: ratio(sessionsStarted, sessionsCreated),
      shared: ratio(sharesOpened, sessionsCreated),
      collaborated: ratio(collaborations, sessionsCreated),
    },
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
