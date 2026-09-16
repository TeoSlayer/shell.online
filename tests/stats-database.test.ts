import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { INSTALL_CONVERSION_DAYS } from "../shared/stats";
import { buildStatsSnapshot, DAY_MS, dayStart, STATS_PRESENCE_LEASE_MS, WEEK_MS, weekStart } from "../shared/stats-snapshot";
import type { AnalyticsEvent } from "../worker/analytics";
import {
  clearStatsPresence,
  collectStatsRows,
  HOUR_MS,
  initializeStatsSchema,
  MACHINE_KEY_DAY,
  migrateStatsData,
  parseStatsPresence,
  parseStatsRecord,
  recordStatsEvent,
  writeStatsPresence,
  type StatsEventRecord,
  type StatsSql,
} from "../worker/stats-database";

/*
 * The Durable Object's database code, run against node:sqlite, which is the
 * same engine the object's storage runs. The adapter is the two cursor
 * methods the code uses and nothing else.
 */
function openDatabase(): StatsSql {
  const database = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const statement = database.prepare(query);
      const values = bindings as (string | number | null)[];
      if (!/^\s*SELECT/i.test(query)) {
        statement.run(...values);
        return { toArray: () => [], one: () => { throw new Error("a statement returns no rows"); } };
      }
      const rows = statement.all(...values).map((row) => ({ ...row }));
      return {
        toArray: () => rows as never,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as never;
        },
      };
    },
  };
}

function freshDatabase(): StatsSql {
  const sql = openDatabase();
  initializeStatsSchema(sql);
  /* A second run must be a no-op: the object runs it on every start. */
  initializeStatsSchema(sql);
  return sql;
}

/* 12:00 UTC on a Tuesday, so weeks and days are easy to read. */
const now = Date.UTC(2026, 8, 15, 12);
/** 06:00 UTC, n days before today. */
const daysAgo = (n: number): number => dayStart(now) - n * DAY_MS + 6 * HOUR_MS;
/** A visitor hash: twenty hex characters, as the Worker sends them. */
const hash = (name: string): string => name.charCodeAt(0).toString(16).padStart(2, "0").repeat(10);

function event(at: number, name: AnalyticsEvent, target: string, extras: Partial<StatsEventRecord> = {}): StatsEventRecord {
  return { event: name, target, device: "desktop", client: "web", referrer: "direct", count: 1, value: 0, auxiliary: 0, at, ...extras };
}

const bySurface = <T extends { surface: string }>(rows: T[]): T[] => [...rows].sort((left, right) => left.surface.localeCompare(right.surface));

describe("the dashboard's database", () => {
  it("adds events into hour buckets, keeping sums and maxima per dimension", () => {
    const sql = freshDatabase();
    recordStatsEvent(sql, event(daysAgo(1), "session_ended", "task_exit", { device: "cli", value: 100, auxiliary: 3 }));
    recordStatsEvent(sql, event(daysAgo(1) + 60_000, "session_ended", "task_exit", { device: "cli", value: 50, auxiliary: 5 }));
    recordStatsEvent(sql, event(daysAgo(1) + HOUR_MS, "session_ended", "task_exit", { device: "cli", value: 10, auxiliary: 1 }));
    recordStatsEvent(sql, event(daysAgo(1) + HOUR_MS, "session_ended", "task_exit", { device: "desktop", value: 1, auxiliary: 0 }));
    const { rows } = collectStatsRows(sql, "7d", false, now);
    expect(rows.summary).toEqual([
      { event: "session_ended", target: "task_exit", count: 4, value_sum: 161, value_max: 100, auxiliary_sum: 9, auxiliary_max: 5 },
    ]);
    expect(rows.live).toEqual({ active_sessions: 0, active_viewers: 0 });
  });

  it("answers a range with its own buckets, the period before with its own, and all time with everything", () => {
    const sql = freshDatabase();
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing"));
    recordStatsEvent(sql, event(daysAgo(1) + 60_000, "page_view", "landing"));
    recordStatsEvent(sql, event(daysAgo(10), "page_view", "landing"));
    recordStatsEvent(sql, event(daysAgo(20), "page_view", "landing"));

    const week = collectStatsRows(sql, "7d", false, now);
    expect(week.rangeStart).toBe(now - 7 * DAY_MS);
    expect(week.rows.summary).toMatchObject([{ event: "page_view", target: "landing", count: 2 }]);
    expect(week.rows.trend).toEqual([{ bucket: Math.floor(daysAgo(1) / HOUR_MS) * HOUR_MS, event: "page_view", count: 2 }]);
    expect(week.rows.previous).toMatchObject({ rangeStart: now - 14 * DAY_MS, summary: [{ count: 1 }], byDevice: [{ device: "desktop", count: 1 }], uniques: [] });
    expect(week.rows.collectingSince).toBe(Math.floor(daysAgo(20) / HOUR_MS) * HOUR_MS);

    const all = collectStatsRows(sql, "all", false, now);
    expect(all.rangeStart).toBe(all.rows.collectingSince);
    expect(all.rows.previous).toBeNull();
    expect(all.rows.summary).toMatchObject([{ count: 4 }]);

    /* The last 24 hours start at noon yesterday; the 06:00 views fall in the day before that. */
    const day = collectStatsRows(sql, "24h", false, now);
    expect(day.rows.summary).toEqual([]);
    expect(day.rows.previous).toMatchObject({ rangeStart: now - 2 * DAY_MS, summary: [{ count: 2 }] });

    /* Crawlers stay out of the charts, and installs and started sessions join them. */
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing", { device: "bot", client: "bot" }));
    recordStatsEvent(sql, event(daysAgo(1), "binary_download", "linux-amd64", { device: "cli", client: "curl" }));
    recordStatsEvent(sql, event(daysAgo(1), "binary_download", "linux-amd64", { device: "bot", client: "bot" }));
    recordStatsEvent(sql, event(daysAgo(1), "session_started", "cli", { device: "cli", client: "shell/0.16.0" }));
    const charted = collectStatsRows(sql, "7d", false, now).rows.trend;
    const hour = Math.floor(daysAgo(1) / HOUR_MS) * HOUR_MS;
    expect(charted).toEqual([
      { bucket: hour, event: "binary_download", count: 1 },
      { bucket: hour, event: "page_view", count: 2 },
      { bucket: hour, event: "session_started", count: 1 },
    ]);
  });

  it("splits the counted events by device class and ranks dimensions by count", () => {
    const sql = freshDatabase();
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing", { device: "desktop", referrer: "hacker_news" }));
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing", { device: "desktop", referrer: "direct" }));
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing", { device: "bot", client: "bot" }));
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "docs_app", { device: "mobile" }));
    recordStatsEvent(sql, event(daysAgo(1), "installer_download", "posix", { device: "cli", client: "curl" }));
    recordStatsEvent(sql, event(daysAgo(1), "session_created", "cli", { device: "cli", client: "shell/0.15.1" }));
    recordStatsEvent(sql, event(daysAgo(1), "share_opened", "viewer", { device: "mobile" }));
    recordStatsEvent(sql, event(daysAgo(1), "collaboration_started", "remote_input", { device: "mobile" }));
    const { rows } = collectStatsRows(sql, "7d", false, now);
    expect(rows.byDevice).toEqual([
      { event: "installer_download", target: "posix", device: "cli", count: 1 },
      { event: "page_view", target: "docs_app", device: "mobile", count: 1 },
      { event: "page_view", target: "landing", device: "bot", count: 1 },
      { event: "page_view", target: "landing", device: "desktop", count: 2 },
    ]);
    expect(rows.devices).toEqual([{ name: "desktop", count: 2 }, { name: "bot", count: 1 }, { name: "mobile", count: 1 }]);
    expect(rows.referrers).toEqual([{ name: "direct", count: 3 }, { name: "hacker_news", count: 1 }]);
    expect(rows.clients).toEqual([{ name: "shell/0.15.1", count: 1 }]);
    expect(rows.openedDevices).toEqual([{ name: "mobile", count: 1 }]);
    expect(rows.typedDevices).toEqual([{ name: "mobile", count: 1 }]);
  });

  it("counts a person once per day per surface, tells new from returning, and says since when", () => {
    const sql = freshDatabase();
    recordStatsEvent(sql, event(daysAgo(10), "page_view", "landing", { visitor: hash("a") }));
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing", { visitor: hash("a") }));
    recordStatsEvent(sql, event(daysAgo(1) + 60_000, "page_view", "docs", { visitor: hash("a") }));
    recordStatsEvent(sql, event(daysAgo(1), "cta_click", "signup_hero", { visitor: hash("b") }));
    recordStatsEvent(sql, event(daysAgo(1), "session_created", "cli", { device: "cli", visitor: hash("c") }));
    /* No person behind these: an unknown path with a hash, and a page view without one. */
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "unknown_path", { visitor: hash("d") }));
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing"));

    const { rows } = collectStatsRows(sql, "7d", true, now);
    expect(rows.uniquesSince).toBe(dayStart(daysAgo(10)));
    expect(rows.uniquesSinceBySurface).toEqual([
      { surface: "cli", minimum: dayStart(daysAgo(1)) },
      { surface: "site", minimum: dayStart(daysAgo(10)) },
    ]);
    expect(bySurface(rows.uniques)).toEqual([
      { surface: "cli", unique_count: 1, new_count: 1 },
      { surface: "site", unique_count: 2, new_count: 1 },
    ]);
    expect(rows.uniqueDays).toEqual([
      { day: dayStart(daysAgo(1)), surface: "cli", unique_count: 1 },
      { day: dayStart(daysAgo(1)), surface: "site", unique_count: 2 },
    ]);
    expect(rows.previous?.uniques).toEqual([{ surface: "site", unique_count: 1 }]);
    expect(rows.retention.filter((row) => row.visitor === hash("a")).map((row) => row.day).sort()).toEqual(
      [dayStart(daysAgo(10)), dayStart(daysAgo(1))].sort(),
    );
    expect(rows.retention.every((row) => row.surface === "site" || row.surface === "cli")).toBe(true);
  });

  it("forgets people past the memory window, and a returning one keeps their first day", () => {
    const sql = freshDatabase();
    recordStatsEvent(sql, event(daysAgo(130), "page_view", "landing", { visitor: hash("o") }));
    recordStatsEvent(sql, event(daysAgo(130), "page_view", "landing", { visitor: hash("a") }));
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing", { visitor: hash("a") }));

    const { rows } = collectStatsRows(sql, "all", true, now);
    expect(rows.uniquesSince).toBe(dayStart(daysAgo(1)));
    /* First seen since collection began, so new on the all-time range; returning on a week. */
    expect(rows.uniques).toEqual([{ surface: "site", unique_count: 1, new_count: 1 }]);
    expect(collectStatsRows(sql, "7d", true, now).rows.uniques).toEqual([{ surface: "site", unique_count: 1, new_count: 0 }]);
    /* The metrics keep the old view; only the person is forgotten. */
    expect(rows.summary).toMatchObject([{ event: "page_view", count: 3 }]);
    const left = sql.exec<{ visitor: string; first_day: number }>("SELECT visitor, first_day FROM visitors ORDER BY visitor").toArray();
    expect(left).toEqual([{ visitor: hash("a"), first_day: dayStart(daysAgo(130)) }]);
  });

  it("follows machines from the installer to a first session within the window", () => {
    const sql = freshDatabase();
    const install = (name: string, when: number): void =>
      recordStatsEvent(sql, event(when, "binary_download", "darwin-arm64", { device: "cli", client: "curl", visitor: hash(name) }));
    const session = (name: string, when: number): void =>
      recordStatsEvent(sql, event(when, "session_created", "cli", { device: "cli", client: "shell/0.15.1", visitor: hash(name) }));
    install("1", daysAgo(20)); session("1", daysAgo(18));                 /* within the window */
    install("2", daysAgo(20)); session("2", daysAgo(5));                  /* too late */
    install("3", daysAgo(3));                                            /* too fresh to tell */
    install("4", daysAgo(20));                                           /* never */
    session("5", daysAgo(25)); install("5", daysAgo(20));                 /* already had the CLI */
    install("6", daysAgo(40));                                           /* before the range */

    const { rows } = collectStatsRows(sql, "30d", true, now);
    expect(rows.installConversion).toEqual({ installers: 5, matured: 4, started: 1 });
    expect(INSTALL_CONVERSION_DAYS).toBe(7);
    expect(collectStatsRows(sql, "30d", false, now).rows.installConversion).toBeNull();
    expect(collectStatsRows(sql, "all", true, now).rows.installConversion).toMatchObject({ installers: 6 });
  });

  it("drops the machine rows keyed the old way once, and never again", () => {
    const sql = freshDatabase();
    /* A database from before the mark existed. */
    sql.exec("DELETE FROM dashboard_marks");
    const cutover = MACHINE_KEY_DAY + 6 * HOUR_MS;
    recordStatsEvent(sql, event(cutover - DAY_MS, "session_created", "cli", { device: "cli", visitor: hash("o") }));
    recordStatsEvent(sql, event(cutover, "binary_download", "darwin-arm64", { device: "cli", visitor: hash("p") }));
    recordStatsEvent(sql, event(cutover - DAY_MS, "page_view", "landing", { visitor: hash("v") }));
    recordStatsEvent(sql, event(cutover + DAY_MS, "session_created", "cli", { device: "cli", visitor: hash("n") }));
    /* Seen before and after the cut-over: the row survives, its first day with it. */
    recordStatsEvent(sql, event(cutover - DAY_MS, "session_created", "cli", { device: "cli", visitor: hash("k") }));
    recordStatsEvent(sql, event(cutover + DAY_MS, "session_created", "cli", { device: "cli", visitor: hash("k") }));

    migrateStatsData(sql);
    const left = sql.exec<{ surface: string; visitor: string; first_day: number }>(
      "SELECT surface, visitor, first_day FROM visitors ORDER BY surface, visitor",
    ).toArray();
    expect(left).toEqual([
      { surface: "cli", visitor: hash("k"), first_day: dayStart(cutover - DAY_MS) },
      { surface: "cli", visitor: hash("n"), first_day: dayStart(cutover + DAY_MS) },
      { surface: "site", visitor: hash("v"), first_day: dayStart(cutover - DAY_MS) },
    ]);
    expect(sql.exec<{ day: number }>("SELECT day FROM visitor_days WHERE visitor = ? ORDER BY day", hash("k")).toArray())
      .toEqual([{ day: dayStart(cutover + DAY_MS) }]);

    /* Done once: a later old-looking row is left alone. */
    recordStatsEvent(sql, event(cutover - DAY_MS, "session_created", "cli", { device: "cli", visitor: hash("z") }));
    initializeStatsSchema(sql);
    migrateStatsData(sql);
    expect(sql.exec<{ visitor: string }>("SELECT visitor FROM visitors WHERE visitor = ?", hash("z")).toArray()).toHaveLength(1);
  });

  it("keeps a live presence lease until it ends, and drops it when told", () => {
    const sql = freshDatabase();
    const key = (letter: string): string => letter.repeat(22);
    writeStatsPresence(sql, { key: key("a"), activeSessions: 1, activeViewers: 2 }, now);
    writeStatsPresence(sql, { key: key("b"), activeSessions: 1, activeViewers: 5 }, now - STATS_PRESENCE_LEASE_MS - 1);
    writeStatsPresence(sql, { key: key("c"), activeSessions: 1, activeViewers: 0 }, now);
    clearStatsPresence(sql, key("c"));
    expect(collectStatsRows(sql, "7d", false, now).rows.live).toEqual({ active_sessions: 1, active_viewers: 2 });
    writeStatsPresence(sql, { key: key("a"), activeSessions: 1, activeViewers: 3 }, now);
    expect(collectStatsRows(sql, "7d", false, now).rows.live).toEqual({ active_sessions: 1, active_viewers: 3 });
    writeStatsPresence(sql, { key: key("a"), activeSessions: 0, activeViewers: 0 }, now);
    expect(collectStatsRows(sql, "7d", false, now).rows.live).toEqual({ active_sessions: 0, active_viewers: 0 });
  });

  it("hands the cohort grids only people first seen inside them", () => {
    const sql = freshDatabase();
    const monday = weekStart(now);
    recordStatsEvent(sql, event(monday - 2 * WEEK_MS + HOUR_MS, "page_view", "landing", { visitor: hash("r") }));
    recordStatsEvent(sql, event(monday - WEEK_MS + HOUR_MS, "page_view", "landing", { visitor: hash("r") }));
    recordStatsEvent(sql, event(monday - 10 * WEEK_MS + HOUR_MS, "page_view", "landing", { visitor: hash("z") }));
    recordStatsEvent(sql, event(monday - WEEK_MS + HOUR_MS, "page_view", "landing", { visitor: hash("z") }));
    recordStatsEvent(sql, event(monday - WEEK_MS + HOUR_MS, "viewer_connected", "viewer", { visitor: hash("v") }));
    const { rows } = collectStatsRows(sql, "7d", true, now);
    expect(rows.retention.map((row) => [row.visitor, row.first_day, row.day])).toEqual([
      [hash("r"), monday - 2 * WEEK_MS, monday - 2 * WEEK_MS],
      [hash("r"), monday - 2 * WEEK_MS, monday - WEEK_MS],
    ]);
  });

  it("builds a coherent snapshot from what it recorded", () => {
    const sql = freshDatabase();
    for (let index = 0; index < 5; index += 1) {
      recordStatsEvent(sql, event(daysAgo(1) + index * HOUR_MS, "page_view", "landing", { visitor: hash("p") }));
    }
    recordStatsEvent(sql, event(daysAgo(1), "page_view", "landing", { device: "bot", client: "bot" }));
    recordStatsEvent(sql, event(daysAgo(1), "installer_download", "posix", { device: "cli", client: "curl", visitor: hash("m") }));
    recordStatsEvent(sql, event(daysAgo(1), "binary_download", "darwin-arm64", { device: "cli", client: "curl", visitor: hash("m") }));
    recordStatsEvent(sql, event(daysAgo(1), "session_created", "cli", { device: "cli", client: "shell/0.15.1", visitor: hash("m") }));
    recordStatsEvent(sql, event(daysAgo(1), "session_started", "cli", { device: "cli", client: "shell/0.15.1" }));
    recordStatsEvent(sql, event(daysAgo(1), "share_opened", "viewer", { value: 30, visitor: hash("p") }));
    recordStatsEvent(sql, event(daysAgo(1), "viewer_connected", "viewer", { visitor: hash("p") }));
    recordStatsEvent(sql, event(daysAgo(9), "page_view", "landing", { visitor: hash("q") }));
    /* Collection began before the period of comparison, or there would be none. */
    recordStatsEvent(sql, event(daysAgo(16), "page_view", "landing"));

    const { rows, rangeStart } = collectStatsRows(sql, "7d", true, now);
    const snapshot = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(snapshot.figures).toMatchObject({ siteViews: 5, crawlerViews: 1, installerRuns: 1, installs: 1, sessionsStarted: 1, sharesOpened: 1 });
    expect(snapshot.uniques.surfaces).toMatchObject({
      site: { unique: 1, new: 1, returning: 0 },
      install: { unique: 1 },
      cli: { unique: 1 },
      viewer: { unique: 1 },
    });
    expect(snapshot.uniques.since).toBe(dayStart(daysAgo(9)));
    expect(snapshot.metrics.averageSecondsToOpen).toBe(30);
    expect(snapshot.previous).toMatchObject({ figures: { siteViews: 1 }, people: null });
    expect(snapshot.installConversion).toEqual({ installers: 1, matured: 0, started: 0 });
  });

  it("parses only records shaped as the Worker sends them, within ten minutes of its own clock", () => {
    const base = { event: "page_view", target: "landing", device: "desktop", client: "web", referrer: "direct", count: 1, value: 0, auxiliary: 0, at: now };
    expect(parseStatsRecord(base, now)).toEqual(base);
    expect(parseStatsRecord({ ...base, visitor: hash("a") }, now)).toEqual({ ...base, visitor: hash("a") });
    expect(parseStatsRecord({ ...base, at: now - 9 * 60_000 }, now)).not.toBeNull();
    expect(parseStatsRecord({ ...base, at: now - 11 * 60_000 }, now)).toBeNull();
    expect(parseStatsRecord({ ...base, event: "made_up" }, now)).toBeNull();
    expect(parseStatsRecord({ ...base, target: "Not A Target" }, now)).toBeNull();
    expect(parseStatsRecord({ ...base, count: 2 }, now)).toBeNull();
    expect(parseStatsRecord({ ...base, value: "12" }, now)).toBeNull();
    expect(parseStatsRecord({ ...base, visitor: "not-a-hash" }, now)).toBeNull();
    expect(parseStatsRecord({ ...base, visitor: 12345 }, now)).toBeNull();
    expect(parseStatsRecord(undefined, now)).toBeNull();
    expect(parseStatsRecord("page_view", now)).toBeNull();
  });

  it("parses a presence lease only from a session object's key and small counts", () => {
    const key = "k".repeat(22);
    expect(parseStatsPresence({ key, activeSessions: 1, activeViewers: 3 })).toEqual({ key, activeSessions: 1, activeViewers: 3 });
    expect(parseStatsPresence({ key, activeSessions: 0, activeViewers: 0 })).toEqual({ key, activeSessions: 0, activeViewers: 0 });
    expect(parseStatsPresence({ key, activeSessions: 2, activeViewers: 0 })).toBeNull();
    expect(parseStatsPresence({ key, activeSessions: 1, activeViewers: 17 })).toBeNull();
    expect(parseStatsPresence({ key, activeSessions: 1, activeViewers: 1.5 })).toBeNull();
    expect(parseStatsPresence({ key: "short", activeSessions: 1, activeViewers: 0 })).toBeNull();
    expect(parseStatsPresence({ key }, true)).toEqual({ key, activeSessions: 0, activeViewers: 0 });
    expect(parseStatsPresence(null)).toBeNull();
  });
});
