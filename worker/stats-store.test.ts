import { describe, expect, it } from "vitest";
import {
  buildRetentionCohorts,
  buildStatsSnapshot,
  DAY_MS,
  STATS_PRESENCE_LEASE_MS,
  STATS_PRESENCE_REFRESH_MS,
  WEEK_MS,
  weekStart,
} from "../shared/stats-snapshot";

describe("statistics live presence", () => {
  it("uses live leases instead of subtracting unrelated lifecycle totals", () => {
    const now = Date.UTC(2026, 7, 21, 7, 30);
    const collectingSince = now - 10 * 60 * 60 * 1_000;
    const snapshot = buildStatsSnapshot({
      summary: [
        metric("viewer_connected", "viewer", 14),
        metric("viewer_disconnected", "viewer", 12),
        metric("session_ended", "disconnected_timeout", 2, 123_914),
      ],
      trend: [],
      devices: [],
      referrers: [],
      clients: [],
      live: { active_sessions: 1, active_viewers: 3 },
      collectingSince,
      uniques: [],
      uniqueDays: [],
      retention: [],
      uniquesConfigured: false,
    }, "all", now, collectingSince);

    expect(snapshot.metrics).toMatchObject({
      activeSessions: 1,
      activeViewers: 3,
      sessionsCreated: 0,
      viewerConnections: 14,
    });
  });

  it("reports zero live sessions even when historical sessions outnumber ends", () => {
    const now = Date.UTC(2026, 7, 21, 7, 30);
    const snapshot = buildStatsSnapshot({
      summary: [
        metric("session_created", "cli", 10),
        metric("session_ended", "task_exit", 4),
      ],
      trend: [],
      devices: [],
      referrers: [],
      clients: [],
      live: { active_sessions: 0, active_viewers: 0 },
      collectingSince: now - 60_000,
      uniques: [],
      uniqueDays: [],
      retention: [],
      uniquesConfigured: false,
    }, "24h", now, now - 24 * 60 * 60 * 1_000);

    expect(snapshot.metrics.activeSessions).toBe(0);
    expect(snapshot.metrics.activeViewers).toBe(0);
    expect(STATS_PRESENCE_LEASE_MS).toBeGreaterThan(STATS_PRESENCE_REFRESH_MS * 2);
  });
});

describe("people and the funnel", () => {
  const now = Date.UTC(2026, 8, 14, 12);
  const rangeStart = now - 7 * DAY_MS;
  const rows = {
    summary: [
      metric("page_view", "landing", 969),
      metric("page_view", "docs_app", 30),
      metric("page_view", "docs", 18),
      metric("page_view", "unknown_path", 57),
      metric("page_view", "not_found", 3),
      metric("cta_click", "signup_hero", 12),
      metric("installer_download", "posix", 62),
      metric("binary_download", "darwin-arm64", 4),
      metric("session_created", "cli", 48),
      metric("session_started", "cli", 48),
      metric("share_opened", "viewer", 6),
      metric("collaboration_started", "remote_input", 5),
    ],
    trend: [],
    devices: [],
    referrers: [],
    clients: [],
    live: { active_sessions: 0, active_viewers: 0 },
    collectingSince: now - 30 * DAY_MS,
    uniques: [
      { surface: "site", unique_count: 400, new_count: 350 },
      { surface: "cli", unique_count: 9, new_count: 2 },
      { surface: "viewer", unique_count: 5, new_count: 5 },
      { surface: "install", unique_count: 40, new_count: 38 },
    ],
    uniqueDays: [
      { day: now - 2 * DAY_MS, surface: "site", unique_count: 120 },
      { day: now - 2 * DAY_MS, surface: "cli", unique_count: 4 },
      { day: now - DAY_MS, surface: "site", unique_count: 140 },
    ],
    retention: [],
    uniquesConfigured: true,
  };

  it("keeps docs, unknown paths and 404s apart and counts people beside events", () => {
    const snapshot = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(snapshot.version).toBe(2);
    expect(snapshot.metrics).toMatchObject({
      landingViews: 969,
      docsViews: 48,
      unknownPaths: 57,
      notFoundViews: 3,
      ctaClicks: 12,
      binaryDownloads: 4,
    });
    expect(snapshot.uniques.surfaces.site).toEqual({ unique: 400, new: 350, returning: 50 });
    expect(snapshot.uniques.surfaces.cli).toEqual({ unique: 9, new: 2, returning: 7 });
    expect(snapshot.uniques.daily.map((day) => [day.site, day.cli])).toEqual([[120, 4], [140, 0]]);
    expect(snapshot.rates.signup).toBeCloseTo(12 / 969);
    expect(snapshot.breakdowns.pages.map((page) => page.label)).toEqual(["landing", "unknown_path", "docs_app", "docs", "not_found"]);
  });

  it("lays the funnel out from a first look to a first keystroke", () => {
    const snapshot = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(snapshot.funnel.map((step) => [step.key, step.count, step.unique])).toEqual([
      ["visited", 1017, 400],
      ["signup", 12, null],
      ["installer", 62, 40],
      ["installed", 4, null],
      ["session", 48, 9],
      ["opened", 6, 5],
      ["typed", 5, null],
    ]);
    for (const step of snapshot.funnel) expect(step.note.length).toBeGreaterThan(20);
    expect(snapshot.funnel.map((step) => step.basis)).toEqual([null, "visited", "visited", "installer", null, "session", "opened"]);
  });

  it("says when nobody is being counted", () => {
    const snapshot = buildStatsSnapshot({ ...rows, uniques: [], uniquesConfigured: false }, "7d", now, rangeStart);
    expect(snapshot.uniques.configured).toBe(false);
    expect(snapshot.funnel[0].unique).toBeNull();
    expect(snapshot.uniques.surfaces.site).toEqual({ unique: 0, new: 0, returning: 0 });
  });
});

describe("retention cohorts", () => {
  /* A Monday, so the weeks are easy to read. */
  const monday = Date.UTC(2026, 8, 7);
  const now = monday + 2 * WEEK_MS + 3 * DAY_MS;

  it("starts weeks on Monday", () => {
    expect(weekStart(monday + 6 * DAY_MS + 5 * 60 * 60_000)).toBe(monday);
    expect(weekStart(monday - 1)).toBe(monday - WEEK_MS);
  });

  it("counts each person once per later week, and leaves unfinished weeks to grow", () => {
    const rows = [
      /* a: arrived week 0, back in week 1 twice and week 2 */
      { visitor: "a", first_day: monday, day: monday },
      { visitor: "a", first_day: monday, day: monday + WEEK_MS },
      { visitor: "a", first_day: monday, day: monday + WEEK_MS + DAY_MS },
      { visitor: "a", first_day: monday, day: monday + 2 * WEEK_MS + DAY_MS },
      /* b: arrived week 0, never back */
      { visitor: "b", first_day: monday + 2 * DAY_MS, day: monday + 2 * DAY_MS },
      /* c: arrived week 1, back in week 2 */
      { visitor: "c", first_day: monday + WEEK_MS + 3 * DAY_MS, day: monday + WEEK_MS + 3 * DAY_MS },
      { visitor: "c", first_day: monday + WEEK_MS + 3 * DAY_MS, day: monday + 2 * WEEK_MS },
      /* d: arrived this week */
      { visitor: "d", first_day: now, day: now },
    ];
    expect(buildRetentionCohorts(rows, now, 8)).toEqual([
      { weekStart: monday, size: 2, active: [1, 1] },
      { weekStart: monday + WEEK_MS, size: 1, active: [1] },
      { weekStart: monday + 2 * WEEK_MS, size: 1, active: [] },
    ]);
  });

  it("ignores cohorts older than the grid shows", () => {
    const old = { visitor: "z", first_day: monday - 12 * WEEK_MS, day: monday };
    expect(buildRetentionCohorts([old], now, 8)).toEqual([]);
  });
});

function metric(
  event: string,
  target: string,
  count: number,
  value = 0,
): Record<string, string | number | null> & {
  event: string;
  target: string;
  count: number;
  value_sum: number;
  value_max: number;
  auxiliary_sum: number;
  auxiliary_max: number;
} {
  return {
    event,
    target,
    count,
    value_sum: value,
    value_max: value,
    auxiliary_sum: 0,
    auxiliary_max: 0,
  };
}
