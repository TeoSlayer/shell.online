import { DurableObject } from "cloudflare:workers";
import {
  RETENTION_WEEKS,
  VISITOR_MEMORY_DAYS,
  isStatsRange,
  type StatsRange,
} from "../shared/stats";
import {
  buildStatsSnapshot,
  DAY_MS,
  dayStart,
  STATS_PRESENCE_LEASE_MS,
  statsRangeStart,
  WEEK_MS,
  weekStart,
  type BreakdownRow,
  type LivePresenceRow,
  type MetricSummaryRow,
  type MetricTrendRow,
  type RetentionRow,
  type UniqueDayRow,
  type UniqueSummaryRow,
} from "../shared/stats-snapshot";
import {
  normalizeAnalyticsRecord,
  uniqueSurface,
  type AnalyticsContext,
  type AnalyticsEvent,
  type AnalyticsRecord,
} from "./analytics";

const HOUR_MS = 60 * 60 * 1_000;
const STATS_OBJECT_NAME = "shell-online-global-stats";
const ANALYTICS_EVENTS = new Set<AnalyticsEvent>([
  "page_view",
  "copy",
  "cta_click",
  "installer_download",
  "binary_download",
  "skill_download",
  "session_created",
  "session_started",
  "share_opened",
  "viewer_connected",
  "viewer_disconnected",
  "collaboration_started",
  "session_ended",
  "stats_view",
]);

interface MinimumRow extends Record<string, string | number | null> {
  minimum: number | null;
}

export async function submitStatsEvent(
  namespace: DurableObjectNamespace<StatsStore>,
  event: AnalyticsEvent,
  target: string,
  context: AnalyticsContext = {},
): Promise<void> {
  const record = normalizeAnalyticsRecord(event, target, context);
  try {
    const response = await namespace.getByName(STATS_OBJECT_NAME).fetch(
      "https://stats.internal/internal/record",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...record, at: Date.now(), visitor: context.visitor }),
      },
    );
    if (!response.ok) throw new Error(`Stats store rejected event: ${response.status}`);
  } catch {
    // Product behavior must never depend on dashboard aggregation.
  }
}

export function fetchStatsSnapshot(
  namespace: DurableObjectNamespace<StatsStore>,
  range: StatsRange,
  uniquesConfigured: boolean,
): Promise<Response> {
  return namespace.getByName(STATS_OBJECT_NAME).fetch(
    `https://stats.internal/internal/stats?range=${range}&uniques=${uniquesConfigured ? "1" : "0"}`,
  );
}

export async function updateStatsPresence(
  namespace: DurableObjectNamespace<StatsStore>,
  key: string,
  activeSessions: number,
  activeViewers: number,
): Promise<void> {
  try {
    const response = await namespace.getByName(STATS_OBJECT_NAME).fetch(
      "https://stats.internal/internal/presence",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, activeSessions, activeViewers }),
      },
    );
    if (!response.ok) throw new Error(`Stats presence rejected update: ${response.status}`);
  } catch {
    // Live product behavior must never depend on dashboard presence.
  }
}

export async function removeStatsPresence(
  namespace: DurableObjectNamespace<StatsStore>,
  key: string,
): Promise<void> {
  try {
    const response = await namespace.getByName(STATS_OBJECT_NAME).fetch(
      "https://stats.internal/internal/presence/remove",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      },
    );
    if (!response.ok) throw new Error(`Stats presence rejected removal: ${response.status}`);
  } catch {
    // Presence leases expire automatically if explicit cleanup cannot be recorded.
  }
}

export class StatsStore extends DurableObject<Record<string, never>> {
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState, env: Record<string, never>) {
    super(state, env);
    this.sql = state.storage.sql;
    this.sql.exec(`
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
    this.sql.exec("CREATE INDEX IF NOT EXISTS metric_hourly_event_bucket ON metric_hourly(event, bucket)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_presence (
        presence_key TEXT PRIMARY KEY,
        active_sessions INTEGER NOT NULL,
        active_viewers INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS live_presence_expiry ON live_presence(expires_at)");
    /*
     * Who was seen, as keyed hashes only: one row per person per day per
     * surface, and one row per person with their first and last day. Both are
     * forgotten VISITOR_MEMORY_DAYS after the person was last seen, so "new"
     * means "not seen in that long" and nothing older than that is kept.
     */
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS visitor_days (
        surface TEXT NOT NULL,
        visitor TEXT NOT NULL,
        day INTEGER NOT NULL,
        PRIMARY KEY (surface, visitor, day)
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS visitor_days_day ON visitor_days(day)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS visitors (
        surface TEXT NOT NULL,
        visitor TEXT NOT NULL,
        first_day INTEGER NOT NULL,
        last_day INTEGER NOT NULL,
        PRIMARY KEY (surface, visitor)
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS visitors_last_day ON visitors(last_day)");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/record" && request.method === "POST") {
      return this.record(request);
    }
    if (url.pathname === "/internal/stats" && request.method === "GET") {
      const requestedRange = url.searchParams.get("range");
      return this.snapshot(
        isStatsRange(requestedRange) ? requestedRange : "7d",
        url.searchParams.get("uniques") === "1",
      );
    }
    if (url.pathname === "/internal/presence" && request.method === "POST") {
      return this.updatePresence(request);
    }
    if (url.pathname === "/internal/presence/remove" && request.method === "POST") {
      return this.removePresence(request);
    }
    return statsJson({ error: "not found" }, 404);
  }

  private async updatePresence(request: Request): Promise<Response> {
    const presence = await parsePresenceRequest(request);
    if (!presence) return statsJson({ error: "invalid presence" }, 400);
    if (presence.activeSessions === 0 && presence.activeViewers === 0) {
      this.sql.exec("DELETE FROM live_presence WHERE presence_key = ?", presence.key);
      return new Response(null, { status: 204 });
    }
    this.sql.exec(
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
      Date.now() + STATS_PRESENCE_LEASE_MS,
    );
    return new Response(null, { status: 204 });
  }

  private async removePresence(request: Request): Promise<Response> {
    const presence = await parsePresenceRequest(request, true);
    if (!presence) return statsJson({ error: "invalid presence" }, 400);
    this.sql.exec("DELETE FROM live_presence WHERE presence_key = ?", presence.key);
    return new Response(null, { status: 204 });
  }

  private async record(request: Request): Promise<Response> {
    let candidate: unknown;
    try {
      candidate = await request.json();
    } catch {
      return statsJson({ error: "invalid event" }, 400);
    }
    const record = parseStatsRecord(candidate);
    if (!record) return statsJson({ error: "invalid event" }, 400);

    const bucket = Math.floor(record.at / HOUR_MS) * HOUR_MS;
    this.sql.exec(
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
    if (surface && record.visitor) {
      const day = dayStart(record.at);
      this.sql.exec(
        "INSERT OR IGNORE INTO visitor_days (surface, visitor, day) VALUES (?, ?, ?)",
        surface,
        record.visitor,
        day,
      );
      this.sql.exec(
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
    return new Response(null, { status: 204 });
  }

  private snapshot(range: StatsRange, uniquesConfigured: boolean): Response {
    const now = Date.now();
    this.sql.exec("DELETE FROM live_presence WHERE expires_at <= ?", now);
    const forgetBefore = dayStart(now) - VISITOR_MEMORY_DAYS * DAY_MS;
    this.sql.exec("DELETE FROM visitor_days WHERE day < ?", forgetBefore);
    this.sql.exec("DELETE FROM visitors WHERE last_day < ?", forgetBefore);
    const collectingSince = this.sql.exec<MinimumRow>(
      "SELECT MIN(bucket) AS minimum FROM metric_hourly",
    ).one().minimum;
    const rangeStart = statsRangeStart(range, now, collectingSince);
    const summary = this.sql.exec<MetricSummaryRow>(
      `SELECT event, target,
        SUM(count) AS count,
        SUM(value_sum) AS value_sum,
        MAX(value_max) AS value_max,
        SUM(auxiliary_sum) AS auxiliary_sum,
        MAX(auxiliary_max) AS auxiliary_max
      FROM metric_hourly
      WHERE bucket >= ?
      GROUP BY event, target
      ORDER BY count DESC, event, target`,
      rangeStart,
    ).toArray();
    const trend = this.sql.exec<MetricTrendRow>(
      `SELECT bucket, event, SUM(count) AS count
      FROM metric_hourly
      WHERE bucket >= ?
        AND event IN ('session_created', 'share_opened', 'collaboration_started', 'page_view')
      GROUP BY bucket, event
      ORDER BY bucket`,
      rangeStart,
    ).toArray();
    const devices = this.dimensionBreakdown("device", rangeStart, "page_view");
    const referrers = this.dimensionBreakdown("referrer", rangeStart, "page_view");
    const clients = this.dimensionBreakdown("client", rangeStart, "session_created");
    const live = this.sql.exec<LivePresenceRow>(
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
    const uniques = this.sql.exec<UniqueSummaryRow>(
      `SELECT seen.surface AS surface,
        COUNT(*) AS unique_count,
        SUM(CASE WHEN visitors.first_day >= ? THEN 1 ELSE 0 END) AS new_count
      FROM (SELECT DISTINCT surface, visitor FROM visitor_days WHERE day >= ?) AS seen
      JOIN visitors ON visitors.surface = seen.surface AND visitors.visitor = seen.visitor
      GROUP BY seen.surface`,
      uniqueStart,
      uniqueStart,
    ).toArray();
    const uniqueDays = this.sql.exec<UniqueDayRow>(
      `SELECT day, surface, COUNT(*) AS unique_count
      FROM visitor_days
      WHERE day >= ?
      GROUP BY day, surface
      ORDER BY day`,
      uniqueStart,
    ).toArray();
    const retention = this.sql.exec<RetentionRow>(
      `SELECT visitors.surface AS surface, visitors.visitor AS visitor,
        visitors.first_day AS first_day, visitor_days.day AS day
      FROM visitors
      JOIN visitor_days ON visitor_days.surface = visitors.surface AND visitor_days.visitor = visitors.visitor
      WHERE visitors.first_day >= ? AND visitors.surface IN ('site', 'cli')`,
      weekStart(now) - (RETENTION_WEEKS - 1) * WEEK_MS,
    ).toArray();

    const snapshot = buildStatsSnapshot(
      {
        summary,
        trend,
        devices,
        referrers,
        clients,
        live,
        collectingSince,
        uniques,
        uniqueDays,
        retention,
        uniquesConfigured,
      },
      range,
      now,
      rangeStart,
    );
    return statsJson(snapshot, 200, {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
  }

  private dimensionBreakdown(
    dimension: "device" | "client" | "referrer",
    rangeStart: number,
    event: AnalyticsEvent,
  ): BreakdownRow[] {
    return this.sql.exec<BreakdownRow>(
      `SELECT ${dimension} AS name, SUM(count) AS count
      FROM metric_hourly
      WHERE bucket >= ? AND event = ?
      GROUP BY ${dimension}
      ORDER BY count DESC
      LIMIT 12`,
      rangeStart,
      event,
    ).toArray();
  }
}

async function parsePresenceRequest(
  request: Request,
  keyOnly = false,
): Promise<{ key: string; activeSessions: number; activeViewers: number } | null> {
  let candidate: unknown;
  try {
    candidate = await request.json();
  } catch {
    return null;
  }
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

function parseStatsRecord(candidate: unknown): (AnalyticsRecord & { at: number; visitor?: string }) | null {
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
  if (Math.abs(Date.now() - at) > 10 * 60 * 1_000) return null;
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

function isDimension(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9._:/-]{1,64}$/.test(value);
}

function statsJson(
  value: unknown,
  status = 200,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...additionalHeaders,
    },
  });
}
