import {
  INSTALL_CONVERSION_DAYS,
  RETENTION_WEEKS,
  VISITOR_MEMORY_DAYS,
  type StatsRange,
} from "../shared/stats";
import {
  DAY_MS,
  dayStart,
  STATS_PRESENCE_LEASE_MS,
  statsRangeStart,
  WEEK_MS,
  weekStart,
  type AudienceRow,
  type BreakdownRow,
  type InstallConversionRow,
  type LivePresenceRow,
  type MetricSummaryRow,
  type MetricTrendRow,
  type PeriodUniqueRow,
  type PreviousPeriodRows,
  type RetentionRow,
  type StatsSnapshotRows,
  type SurfaceSinceRow,
  type UniqueDayRow,
  type UniqueSummaryRow,
} from "../shared/stats-snapshot";
import { uniqueSurface, type AnalyticsEvent, type AnalyticsRecord } from "./analytics";

export const HOUR_MS = 60 * 60 * 1_000;

/*
 * Everything the dashboard's Durable Object does with its database, written
 * over the two cursor methods it needs, so the same code runs against any
 * SQLite: the object's own storage in production, node:sqlite in the tests.
 * The object itself only parses requests and hands them here.
 */
export interface StatsSqlCursor<T> {
  toArray(): T[];
  /** The single row, or a throw when there is not exactly one. */
  one(): T;
}

export interface StatsSql {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): StatsSqlCursor<T>;
}

export type StatsEventRecord = AnalyticsRecord & { at: number; visitor?: string };

export interface StatsPresence {
  key: string;
  activeSessions: number;
  activeViewers: number;
}

export interface CollectedStatsRows {
  rows: StatsSnapshotRows;
  rangeStart: number;
}

export const ANALYTICS_EVENTS = new Set<AnalyticsEvent>([
  "page_view",
  "copy",
  "cta_click",
  "installer_download",
  "install_outcome",
  "binary_download",
  "skill_download",
  "session_created",
  "session_started",
  "share_opened",
  "viewer_connected",
  "viewer_disconnected",
  "collaboration_started",
  "session_ended",
  "viewer_rejected",
  "input_denied",
  "stats_view",
]);

/** How far an event's own clock may differ from the store's before it is refused. */
const MAX_EVENT_SKEW_MS = 10 * 60 * 1_000;

interface MinimumRow extends Record<string, unknown> {
  minimum: number | null;
}

export function initializeStatsSchema(sql: StatsSql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS metric_hourly (
      bucket INTEGER NOT NULL,
      event TEXT NOT NULL,
      target TEXT NOT NULL,
      device TEXT NOT NULL,
      client TEXT NOT NULL,
      referrer TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      value_sum REAL NOT NULL DEFAULT 0,
      value_max REAL NOT NULL DEFAULT 0,
      auxiliary_sum REAL NOT NULL DEFAULT 0,
      auxiliary_max REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, event, target, device, client, referrer)
    )
  `);
  sql.exec("CREATE INDEX IF NOT EXISTS metric_hourly_event_bucket ON metric_hourly(event, bucket)");
  sql.exec(`
    CREATE TABLE IF NOT EXISTS live_presence (
      presence_key TEXT PRIMARY KEY,
      active_sessions INTEGER NOT NULL,
      active_viewers INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  sql.exec("CREATE INDEX IF NOT EXISTS live_presence_expiry ON live_presence(expires_at)");
  /*
   * Who was seen, as keyed hashes only: one row per person per day per
   * surface, and one row per person with their first and last day. Both are
   * forgotten VISITOR_MEMORY_DAYS after the person was last seen, so "new"
   * means "not seen in that long" and nothing older than that is kept.
   */
  sql.exec(`
    CREATE TABLE IF NOT EXISTS visitor_days (
      surface TEXT NOT NULL,
      visitor TEXT NOT NULL,
      day INTEGER NOT NULL,
      PRIMARY KEY (surface, visitor, day)
    )
  `);
  sql.exec("CREATE INDEX IF NOT EXISTS visitor_days_day ON visitor_days(day)");
  sql.exec(`
    CREATE TABLE IF NOT EXISTS visitors (
      surface TEXT NOT NULL,
      visitor TEXT NOT NULL,
      first_day INTEGER NOT NULL,
      last_day INTEGER NOT NULL,
      PRIMARY KEY (surface, visitor)
    )
  `);
  sql.exec("CREATE INDEX IF NOT EXISTS visitors_last_day ON visitors(last_day)");
  sql.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_marks (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);
  migrateStatsData(sql);
}

/**
 * The last day machines were keyed by address and user agent; since the day
 * after, by address alone. A machine row from before cannot match the same
 * machine seen after, so it would sit in the cohorts as a ghost that never
 * came back.
 */
export const MACHINE_KEY_DAY = Date.UTC(2026, 8, 15);

/**
 * One-time repairs to what is stored, each done once and marked as done.
 * The first drops the machine rows keyed the old way; a machine seen on the
 * cut-over day itself is lost with them, a few hours of history against 120
 * days of ghosts.
 */
export function migrateStatsData(sql: StatsSql): void {
  const done = sql.exec<{ value: number }>("SELECT value FROM dashboard_marks WHERE name = 'machine_key'").toArray();
  if (done.length > 0) return;
  sql.exec("DELETE FROM visitor_days WHERE surface IN ('cli', 'install') AND day <= ?", MACHINE_KEY_DAY);
  sql.exec("DELETE FROM visitors WHERE surface IN ('cli', 'install') AND last_day <= ?", MACHINE_KEY_DAY);
  sql.exec("INSERT INTO dashboard_marks (name, value) VALUES ('machine_key', 1)", );
}

/** One event into its hour bucket, and its person into the day's visitors when it has one. */
export function recordStatsEvent(sql: StatsSql, record: StatsEventRecord): void {
  const bucket = Math.floor(record.at / HOUR_MS) * HOUR_MS;
  sql.exec(
    `INSERT INTO metric_hourly (
      bucket, event, target, device, client, referrer,
      count, value_sum, value_max, auxiliary_sum, auxiliary_max
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket, event, target, device, client, referrer) DO UPDATE SET
      count = metric_hourly.count + excluded.count,
      value_sum = metric_hourly.value_sum + excluded.value_sum,
      value_max = MAX(metric_hourly.value_max, excluded.value_max),
      auxiliary_sum = metric_hourly.auxiliary_sum + excluded.auxiliary_sum,
      auxiliary_max = MAX(metric_hourly.auxiliary_max, excluded.auxiliary_max)`,
    bucket,
    record.event,
    record.target,
    record.device,
    record.client,
    record.referrer,
    record.count,
    record.value,
    record.value,
    record.auxiliary,
    record.auxiliary,
  );
  const surface = record.visitor ? uniqueSurface(record.event, record.target) : null;
  if (!surface || !record.visitor) return;
  const day = dayStart(record.at);
  sql.exec(
    "INSERT OR IGNORE INTO visitor_days (surface, visitor, day) VALUES (?, ?, ?)",
    surface,
    record.visitor,
    day,
  );
  sql.exec(
    `INSERT INTO visitors (surface, visitor, first_day, last_day) VALUES (?, ?, ?, ?)
    ON CONFLICT (surface, visitor) DO UPDATE SET
      first_day = MIN(visitors.first_day, excluded.first_day),
      last_day = MAX(visitors.last_day, excluded.last_day)`,
    surface,
    record.visitor,
    day,
    day,
  );
}

/** A session object's lease on "live": renewed while it has sockets, dropped when it has none. */
export function writeStatsPresence(sql: StatsSql, presence: StatsPresence, now = Date.now()): void {
  if (presence.activeSessions === 0 && presence.activeViewers === 0) {
    clearStatsPresence(sql, presence.key);
    return;
  }
  sql.exec(
    `INSERT INTO live_presence (
      presence_key, active_sessions, active_viewers, expires_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (presence_key) DO UPDATE SET
      active_sessions = excluded.active_sessions,
      active_viewers = excluded.active_viewers,
      expires_at = excluded.expires_at`,
    presence.key,
    presence.activeSessions,
    presence.activeViewers,
    now + STATS_PRESENCE_LEASE_MS,
  );
}

export function clearStatsPresence(sql: StatsSql, key: string): void {
  sql.exec("DELETE FROM live_presence WHERE presence_key = ?", key);
}

/**
 * Everything a snapshot is built from, for one range. Expired leases and
 * people past the memory window are dropped first, so what is counted is
 * exactly what is kept.
 */
export function collectStatsRows(
  sql: StatsSql,
  range: StatsRange,
  uniquesConfigured: boolean,
  now = Date.now(),
): CollectedStatsRows {
  sql.exec("DELETE FROM live_presence WHERE expires_at <= ?", now);
  const forgetBefore = dayStart(now) - VISITOR_MEMORY_DAYS * DAY_MS;
  sql.exec("DELETE FROM visitor_days WHERE day < ?", forgetBefore);
  sql.exec("DELETE FROM visitors WHERE last_day < ?", forgetBefore);
  const collectingSince = sql.exec<MinimumRow>("SELECT MIN(bucket) AS minimum FROM metric_hourly").one().minimum;
  /* Taken after the purge, so it is the earliest day people can still be counted from. */
  const uniquesSince = sql.exec<MinimumRow>("SELECT MIN(day) AS minimum FROM visitor_days").one().minimum;
  const uniquesSinceBySurface = sql.exec<SurfaceSinceRow>(
    "SELECT surface, MIN(day) AS minimum FROM visitor_days GROUP BY surface ORDER BY surface",
  ).toArray();
  const rangeStart = statsRangeStart(range, now, collectingSince);
  /* Buckets are hours and events at most ten minutes ahead of this clock, so nothing sits past tomorrow. */
  const rangeEnd = now + DAY_MS;
  const summary = metricSummary(sql, rangeStart, rangeEnd);
  const byDevice = audienceRows(sql, rangeStart, rangeEnd);
  /*
   * The period of equal length before the range, for comparison. People are
   * counted by day, so its days are the whole days before the range's first
   * day. The all-time range has nothing before it.
   */
  let previous: PreviousPeriodRows | null = null;
  if (range !== "all") {
    const previousStart = rangeStart - (now - rangeStart);
    previous = {
      rangeStart: previousStart,
      summary: metricSummary(sql, previousStart, rangeStart),
      byDevice: audienceRows(sql, previousStart, rangeStart),
      uniques: sql.exec<PeriodUniqueRow>(
        `SELECT surface, COUNT(DISTINCT visitor) AS unique_count
        FROM visitor_days
        WHERE day >= ? AND day < ?
        GROUP BY surface`,
        dayStart(previousStart),
        dayStart(rangeStart),
      ).toArray(),
    };
  }
  /* The charts are about people, so crawlers stay out of them; the ledger keeps every request. */
  const trend = sql.exec<MetricTrendRow>(
    `SELECT bucket, event, SUM(count) AS count
    FROM metric_hourly
    WHERE bucket >= ?
      AND event IN ('session_created', 'session_started', 'share_opened', 'collaboration_started', 'page_view', 'binary_download')
      AND device != 'bot'
    GROUP BY bucket, event
    ORDER BY bucket, event`,
    rangeStart,
  ).toArray();
  const live = sql.exec<LivePresenceRow>(
    `SELECT
      COALESCE(SUM(active_sessions), 0) AS active_sessions,
      COALESCE(SUM(active_viewers), 0) AS active_viewers
    FROM live_presence`,
  ).one();
  /*
   * People are counted by day, so a range that starts mid-day includes the
   * whole of that day: a day is the finest grain the visitor tables keep.
   */
  const uniqueStart = dayStart(rangeStart);
  const uniques = sql.exec<UniqueSummaryRow>(
    `SELECT seen.surface AS surface,
      COUNT(*) AS unique_count,
      SUM(CASE WHEN visitors.first_day >= ? THEN 1 ELSE 0 END) AS new_count
    FROM (SELECT DISTINCT surface, visitor FROM visitor_days WHERE day >= ?) AS seen
    JOIN visitors ON visitors.surface = seen.surface AND visitors.visitor = seen.visitor
    GROUP BY seen.surface`,
    uniqueStart,
    uniqueStart,
  ).toArray();
  const uniqueDays = sql.exec<UniqueDayRow>(
    `SELECT day, surface, COUNT(*) AS unique_count
    FROM visitor_days
    WHERE day >= ?
    GROUP BY day, surface
    ORDER BY day, surface`,
    uniqueStart,
  ).toArray();
  /*
   * Installers followed to their first session. Both surfaces key a machine
   * by address, so the join is on the hash. A machine counts as matured once
   * its window has fully elapsed, so a fresh install is not a miss, and a
   * machine whose sessions predate the install already had the CLI.
   */
  const conversionWindow = INSTALL_CONVERSION_DAYS * DAY_MS;
  const installConversion = uniquesConfigured
    ? sql.exec<InstallConversionRow>(
      `SELECT COUNT(*) AS installers,
        SUM(CASE WHEN installs.first_day <= ? THEN 1 ELSE 0 END) AS matured,
        SUM(CASE WHEN installs.first_day <= ?
          AND cli.first_day IS NOT NULL
          AND cli.first_day >= installs.first_day
          AND cli.first_day < installs.first_day + ? THEN 1 ELSE 0 END) AS started
      FROM visitors AS installs
      LEFT JOIN visitors AS cli ON cli.surface = 'cli' AND cli.visitor = installs.visitor
      WHERE installs.surface = 'install' AND installs.first_day >= ?`,
      dayStart(now) - conversionWindow,
      dayStart(now) - conversionWindow,
      conversionWindow,
      uniqueStart,
    ).one()
    : null;
  const retention = sql.exec<RetentionRow>(
    `SELECT visitors.surface AS surface, visitors.visitor AS visitor,
      visitors.first_day AS first_day, visitor_days.day AS day
    FROM visitors
    JOIN visitor_days ON visitor_days.surface = visitors.surface AND visitor_days.visitor = visitors.visitor
    WHERE visitors.first_day >= ? AND visitors.surface IN ('site', 'cli')`,
    weekStart(now) - (RETENTION_WEEKS - 1) * WEEK_MS,
  ).toArray();

  return {
    rangeStart,
    rows: {
      summary,
      byDevice,
      previous,
      trend,
      devices: dimensionBreakdown(sql, "device", rangeStart, "page_view"),
      referrers: dimensionBreakdown(sql, "referrer", rangeStart, "page_view"),
      clients: dimensionBreakdown(sql, "client", rangeStart, "session_created"),
      openedDevices: dimensionBreakdown(sql, "device", rangeStart, "share_opened"),
      typedDevices: dimensionBreakdown(sql, "device", rangeStart, "collaboration_started"),
      live,
      collectingSince,
      uniques,
      uniqueDays,
      retention,
      installConversion,
      uniquesConfigured,
      uniquesSince,
      uniquesSinceBySurface,
    },
  };
}

function metricSummary(sql: StatsSql, from: number, to: number): MetricSummaryRow[] {
  return sql.exec<MetricSummaryRow>(
    `SELECT event, target,
      SUM(count) AS count,
      SUM(value_sum) AS value_sum,
      MAX(value_max) AS value_max,
      SUM(auxiliary_sum) AS auxiliary_sum,
      MAX(auxiliary_max) AS auxiliary_max
    FROM metric_hourly
    WHERE bucket >= ? AND bucket < ?
    GROUP BY event, target
    ORDER BY count DESC, event, target`,
    from,
    to,
  ).toArray();
}

/** Who made the requests: the same totals, split by device class, for the events the page tells apart. */
function audienceRows(sql: StatsSql, from: number, to: number): AudienceRow[] {
  return sql.exec<AudienceRow>(
    `SELECT event, target, device, SUM(count) AS count
    FROM metric_hourly
    WHERE bucket >= ? AND bucket < ?
      AND event IN ('page_view', 'installer_download', 'binary_download', 'viewer_connected')
    GROUP BY event, target, device
    ORDER BY event, target, device`,
    from,
    to,
  ).toArray();
}

function dimensionBreakdown(
  sql: StatsSql,
  dimension: "device" | "client" | "referrer",
  rangeStart: number,
  event: AnalyticsEvent,
): BreakdownRow[] {
  return sql.exec<BreakdownRow>(
    `SELECT ${dimension} AS name, SUM(count) AS count
    FROM metric_hourly
    WHERE bucket >= ? AND event = ?
    GROUP BY ${dimension}
    ORDER BY count DESC, name
    LIMIT 12`,
    rangeStart,
    event,
  ).toArray();
}

/** A record as the Worker sends it, or null for anything else: a stranger's shape, a stale clock, a bad hash. */
export function parseStatsRecord(candidate: unknown, now = Date.now()): StatsEventRecord | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.event !== "string" ||
    !ANALYTICS_EVENTS.has(value.event as AnalyticsEvent) ||
    !isDimension(value.target) ||
    !isDimension(value.device) ||
    !isDimension(value.client) ||
    !isDimension(value.referrer) ||
    value.count !== 1 ||
    !Number.isFinite(value.value) ||
    !Number.isFinite(value.auxiliary) ||
    !Number.isFinite(value.at)
  ) return null;
  const at = Number(value.at);
  if (Math.abs(now - at) > MAX_EVENT_SKEW_MS) return null;
  if (value.visitor !== undefined && (typeof value.visitor !== "string" || !/^[a-f0-9]{20}$/.test(value.visitor))) {
    return null;
  }
  return {
    ...(typeof value.visitor === "string" ? { visitor: value.visitor } : {}),
    event: value.event as AnalyticsEvent,
    target: value.target,
    device: value.device as AnalyticsRecord["device"],
    client: value.client,
    referrer: value.referrer,
    count: 1,
    value: Number(value.value),
    auxiliary: Number(value.auxiliary),
    at,
  };
}

export function parseStatsPresence(candidate: unknown, keyOnly = false): StatsPresence | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const value = candidate as Record<string, unknown>;
  if (typeof value.key !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value.key)) return null;
  if (keyOnly) return { key: value.key, activeSessions: 0, activeViewers: 0 };
  if (
    !Number.isInteger(value.activeSessions) ||
    (value.activeSessions !== 0 && value.activeSessions !== 1) ||
    !Number.isInteger(value.activeViewers) ||
    Number(value.activeViewers) < 0 ||
    Number(value.activeViewers) > 16
  ) return null;
  return {
    key: value.key,
    activeSessions: Number(value.activeSessions),
    activeViewers: Number(value.activeViewers),
  };
}

function isDimension(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9._:/-]{1,64}$/.test(value);
}
