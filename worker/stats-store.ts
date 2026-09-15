import { DurableObject } from "cloudflare:workers";
import { isStatsRange, type StatsRange } from "../shared/stats";
import { buildStatsSnapshot } from "../shared/stats-snapshot";
import { normalizeAnalyticsRecord, type AnalyticsContext, type AnalyticsEvent } from "./analytics";
import {
  clearStatsPresence,
  collectStatsRows,
  initializeStatsSchema,
  parseStatsPresence,
  parseStatsRecord,
  recordStatsEvent,
  writeStatsPresence,
  type StatsSql,
  type StatsSqlCursor,
} from "./stats-database";

const STATS_OBJECT_NAME = "shell-online-global-stats";

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

/*
 * The Durable Object: one per deployment, holding the dashboard's database.
 * It parses what the Worker and the session objects send and hands the SQL
 * to stats-database, which is where the counting lives and is tested.
 */
export class StatsStore extends DurableObject<Record<string, never>> {
  private readonly sql: StatsSql;

  constructor(state: DurableObjectState, env: Record<string, never>) {
    super(state, env);
    this.sql = durableSql(state.storage.sql);
    initializeStatsSchema(this.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/record" && request.method === "POST") {
      const record = parseStatsRecord(await readJson(request));
      if (!record) return statsJson({ error: "invalid event" }, 400);
      recordStatsEvent(this.sql, record);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/internal/stats" && request.method === "GET") {
      const requestedRange = url.searchParams.get("range");
      return this.snapshot(
        isStatsRange(requestedRange) ? requestedRange : "7d",
        url.searchParams.get("uniques") === "1",
      );
    }
    if (url.pathname === "/internal/presence" && request.method === "POST") {
      const presence = parseStatsPresence(await readJson(request));
      if (!presence) return statsJson({ error: "invalid presence" }, 400);
      writeStatsPresence(this.sql, presence);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/internal/presence/remove" && request.method === "POST") {
      const presence = parseStatsPresence(await readJson(request), true);
      if (!presence) return statsJson({ error: "invalid presence" }, 400);
      clearStatsPresence(this.sql, presence.key);
      return new Response(null, { status: 204 });
    }
    return statsJson({ error: "not found" }, 404);
  }

  private snapshot(range: StatsRange, uniquesConfigured: boolean): Response {
    const now = Date.now();
    const { rows, rangeStart } = collectStatsRows(this.sql, range, uniquesConfigured, now);
    return statsJson(buildStatsSnapshot(rows, range, now, rangeStart), 200, {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
  }
}

/** The object's SqlStorage behind the two cursor methods the database code uses. */
function durableSql(storage: SqlStorage): StatsSql {
  return {
    exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): StatsSqlCursor<T> {
      return storage.exec(query, ...bindings) as unknown as StatsSqlCursor<T>;
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
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
