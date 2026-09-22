import { describe, expect, it } from "vitest";
import {
  audienceOf,
  buildAudiences,
  buildRetentionCohorts,
  buildStatsSnapshot,
  DAY_MS,
  dayStart,
  installsCompleted,
  peopleCountedSince,
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
      openedDevices: [],
      typedDevices: [],
      live: { active_sessions: 1, active_viewers: 3 },
      collectingSince,
      byDevice: [],
      previous: null,
      uniques: [],
      uniqueDays: [],
      retention: [],
      installConversion: null,
      uniquesConfigured: false,
      uniquesSince: null,
      uniquesSinceBySurface: [],
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
      openedDevices: [],
      typedDevices: [],
      live: { active_sessions: 0, active_viewers: 0 },
      collectingSince: now - 60_000,
      byDevice: [],
      previous: null,
      uniques: [],
      uniqueDays: [],
      retention: [],
      installConversion: null,
      uniquesConfigured: false,
      uniquesSince: null,
      uniquesSinceBySurface: [],
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
      metric("share_opened", "viewer", 5, 100),
      metric("share_opened", "viewer_read_only", 1, 20),
      metric("collaboration_started", "remote_input", 5, 50),
      metric("viewer_disconnected", "viewer", 12, 3_600),
      metric("viewer_rejected", "session_full", 2),
      metric("viewer_rejected", "expired", 3),
      metric("input_denied", "read_only", 1),
      metric("install_outcome", "ok", 3),
      metric("install_outcome", "checksum_mismatch", 1),
      metric("copy", "install", 20),
      metric("copy", "brew_install", 5),
      metric("copy", "share", 3),
      metric("session_ended", "never_started", 4),
      metric("session_ended", "task_exit", 40, 1_200),
    ],
    /* The same totals by who made the requests; each event's rows add up to its summary row. */
    byDevice: [
      audience("page_view", "landing", "desktop", 700),
      audience("page_view", "landing", "mobile", 60),
      audience("page_view", "landing", "bot", 200),
      audience("page_view", "landing", "cli", 9),
      audience("page_view", "docs_app", "desktop", 30),
      audience("page_view", "docs", "bot", 18),
      audience("page_view", "unknown_path", "bot", 57),
      audience("installer_download", "posix", "cli", 50),
      audience("installer_download", "posix", "desktop", 4),
      audience("installer_download", "posix", "bot", 8),
      audience("binary_download", "darwin-arm64", "cli", 3),
      audience("binary_download", "darwin-arm64", "bot", 1),
      audience("viewer_connected", "viewer", "desktop", 12),
    ],
    previous: null,
    trend: [],
    devices: [],
    referrers: [],
    clients: [],
    openedDevices: [{ name: "desktop", count: 4 }, { name: "mobile", count: 2 }],
    typedDevices: [{ name: "desktop", count: 4 }, { name: "mobile", count: 1 }],
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
    installConversion: { installers: 12, matured: 9, started: 4 },
    uniquesConfigured: true,
    uniquesSince: dayStart(now - 20 * DAY_MS),
    /* Machines were re-keyed after visitors were first counted, so their start is later. */
    uniquesSinceBySurface: [
      { surface: "site", minimum: dayStart(now - 20 * DAY_MS) },
      { surface: "cli", minimum: dayStart(now - 2 * DAY_MS) },
      { surface: "install", minimum: dayStart(now - 2 * DAY_MS) },
    ],
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
    expect(snapshot.uniques.surfaces.site).toEqual({ unique: 400, new: 350, returning: 50, since: dayStart(now - 20 * DAY_MS) });
    expect(snapshot.uniques.surfaces.cli).toEqual({ unique: 9, new: 2, returning: 7, since: dayStart(now - 2 * DAY_MS) });
    expect(snapshot.uniques.daily.map((day) => [day.site, day.cli])).toEqual([[120, 4], [140, 0]]);
    expect(snapshot.rates.signup).toBeCloseTo(12 / 969);
    expect(snapshot.breakdowns.pages.map((page) => page.label)).toEqual(["landing", "unknown_path", "docs_app", "docs", "not_found"]);
  });

  it("folds device classes into audiences, and counts only the events the page tells apart", () => {
    expect(["desktop", "mobile", "tablet"].map(audienceOf)).toEqual(["browsers", "browsers", "browsers"]);
    expect(audienceOf("cli")).toBe("tools");
    expect(audienceOf("bot")).toBe("crawlers");
    expect(audienceOf("unknown")).toBe("unknown");
    expect(audienceOf("something-new")).toBe("unknown");
    expect(installsCompleted({ browsers: 1, tools: 2, crawlers: 5, unknown: 1 })).toBe(4);
    const audiences = buildAudiences([
      { event: "session_created", target: "cli", device: "cli", count: 9 },
      { event: "page_view", target: "not_found", device: "bot", count: 3 },
      { event: "page_view", target: "session", device: "mobile", count: 2 },
      { event: "viewer_connected", target: "viewer", device: "mobile", count: 2 },
    ]);
    expect(audiences.views).toEqual({ browsers: 0, tools: 0, crawlers: 0, unknown: 0 });
    expect(audiences.viewers).toEqual({ browsers: 2, tools: 0, crawlers: 0, unknown: 0 });
  });

  it("tells browsers, tools and crawlers apart in every figure about people", () => {
    const snapshot = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(snapshot.audiences.views).toEqual({ browsers: 790, tools: 9, crawlers: 218, unknown: 0 });
    expect(snapshot.audiences.installer).toEqual({ browsers: 4, tools: 50, crawlers: 8, unknown: 0 });
    expect(snapshot.audiences.installs).toEqual({ browsers: 0, tools: 3, crawlers: 1, unknown: 0 });
    expect(snapshot.figures).toEqual({
      pageLoads: 0,
      installsReported: 3,
      siteViews: 790,
      crawlerViews: 218,
      ctaClicks: 12,
      installCopies: 25,
      installerRuns: 50,
      installs: 3,
      sessionsStarted: 48,
      neverStarted: 4,
      sharesOpened: 6,
      sharesOpenedWritable: 5,
      collaborations: 5,
    });
    /* The raw totals are untouched: the ledger still shows every request. */
    expect(snapshot.metrics.landingViews + snapshot.metrics.docsViews).toBe(1017);
    expect(snapshot.metrics.installs).toBe(62);
  });

  /*
   * The funnel counts what a person is plausibly behind, and lists beside
   * each step what it left out, so 969 landing views do not read as 969
   * visitors and 62 installer fetches do not read as 62 installs attempted.
   */
  it("lays the funnel out from a first look to a first keystroke, crawlers beside it", () => {
    const snapshot = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(snapshot.funnel.map((step) => [step.key, step.count, step.unique])).toEqual([
      ["visited", 790, 400],
      ["loaded", 0, null],
      ["signup", 12, null],
      ["copied", 25, null],
      ["installer", 50, 40],
      ["installed", 3, null],
      ["reported_install", 3, null],
      ["session", 48, 9],
      ["opened", 6, 5],
      ["typed", 5, null],
    ]);
    expect(snapshot.funnel.map((step) => step.excluded)).toEqual([
      [{ label: "by crawlers", count: 218 }, { label: "by tools", count: 9 }],
      [],
      [],
      [],
      [{ label: "read in a browser", count: 4 }, { label: "by crawlers", count: 8 }],
      [{ label: "by crawlers", count: 1 }],
      [],
      [{ label: "created but never connected", count: 4 }],
      [],
      [{ label: "opened read-only, typing impossible", count: 1 }],
    ]);
    for (const step of snapshot.funnel) expect(step.note.length).toBeGreaterThan(20);
    expect(snapshot.funnel.map((step) => step.basis)).toEqual([null, null, null, null, null, null, null, null, "session", "opened"]);
  });

  it("keeps what happens after a link is opened: waits, stays, refusals, and read-only sessions apart", () => {
    const snapshot = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(snapshot.metrics).toMatchObject({
      sharesOpened: 6,
      sharesOpenedReadOnly: 1,
      viewersRejected: 5,
      inputDenied: 1,
      averageSecondsToOpen: 20,
      averageSecondsToType: 10,
      averageViewerSeconds: 300,
    });
    const typed = snapshot.funnel.find((step) => step.key === "typed");
    expect(typed).toMatchObject({ basis: "opened", basisCount: 5, basisLabel: "opened sessions that allow typing" });
    expect(typed?.excluded).toEqual([{ label: "opened read-only, typing impossible", count: 1 }]);
    expect(snapshot.breakdowns.rejections).toEqual([{ label: "expired", value: 3 }, { label: "session_full", value: 2 }]);
    expect(snapshot.metrics).toMatchObject({ installsReported: 3, installFailuresReported: 1 });
    expect(snapshot.breakdowns.installOutcomes).toEqual([{ label: "ok", value: 3 }, { label: "checksum_mismatch", value: 1 }]);
    expect(snapshot.breakdowns.openedDevices).toEqual([{ label: "desktop", value: 4 }, { label: "mobile", value: 2 }]);
    expect(snapshot.breakdowns.typedDevices).toEqual([{ label: "desktop", value: 4 }, { label: "mobile", value: 1 }]);
  });

  it("compares with the period before, when there is one worth comparing with", () => {
    const previous = {
      rangeStart: rangeStart - 7 * DAY_MS,
      summary: [
        metric("cta_click", "signup_hero", 6),
        metric("session_started", "cli", 40),
        metric("share_opened", "viewer", 4),
        metric("collaboration_started", "remote_input", 2),
      ],
      byDevice: [
        audience("page_view", "landing", "desktop", 500),
        audience("page_view", "landing", "bot", 300),
        audience("installer_download", "posix", "cli", 40),
        audience("binary_download", "darwin-arm64", "cli", 2),
      ],
      uniques: [{ surface: "site", unique_count: 300 }, { surface: "cli", unique_count: 8 }],
    };
    const snapshot = buildStatsSnapshot({ ...rows, previous }, "7d", now, rangeStart);
    expect(snapshot.previous).toEqual({
      rangeStart: rangeStart - 7 * DAY_MS,
      rangeEnd: rangeStart,
      figures: {
        pageLoads: 0,
        installsReported: 0,
        siteViews: 500,
        crawlerViews: 300,
        ctaClicks: 6,
        installCopies: 0,
        installerRuns: 40,
        installs: 2,
        sessionsStarted: 40,
        neverStarted: 0,
        sharesOpened: 4,
        sharesOpenedWritable: 4,
        collaborations: 2,
      },
      people: { site: 300, cli: 8, viewer: 0, install: 0 },
    });

    /* People counted from inside the previous period: figures compare, people do not. */
    const late = buildStatsSnapshot({ ...rows, previous, uniquesSince: dayStart(now - 10 * DAY_MS) }, "7d", now, rangeStart);
    expect(late.previous?.figures.siteViews).toBe(500);
    expect(late.previous?.people).toBeNull();

    /* Collection began inside the previous period: an empty comparison would say everything doubled. */
    expect(buildStatsSnapshot({ ...rows, previous, collectingSince: now - 10 * DAY_MS }, "7d", now, rangeStart).previous).toBeNull();
    expect(buildStatsSnapshot({ ...rows, previous: null }, "all", now, now - 30 * DAY_MS).previous).toBeNull();
  });

  it("draws installs and started sessions as their own lines", () => {
    const hour = 60 * 60 * 1_000;
    const bucket = Math.floor((now - DAY_MS) / hour) * hour;
    const snapshot = buildStatsSnapshot({
      ...rows,
      trend: [
        { bucket, event: "session_created", count: 4 },
        { bucket, event: "session_started", count: 3 },
        { bucket, event: "binary_download", count: 2 },
        { bucket, event: "page_view", count: 9 },
      ],
    }, "7d", now, rangeStart);
    const point = snapshot.trend.find((candidate) => candidate.at === Math.floor(bucket / (6 * hour)) * 6 * hour);
    expect(point).toMatchObject({ sessions: 4, started: 3, installs: 2, pageViews: 9, shares: 0, collaborations: 0 });
  });

  it("follows machines from the installer to a first session", () => {
    const snapshot = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(snapshot.installConversion).toEqual({ installers: 12, matured: 9, started: 4 });
    const empty = buildStatsSnapshot({ ...rows, installConversion: { installers: 0, matured: null, started: null } }, "7d", now, rangeStart);
    expect(empty.installConversion).toEqual({ installers: 0, matured: 0, started: 0 });
  });

  it("says when nobody is being counted", () => {
    const snapshot = buildStatsSnapshot({ ...rows, uniques: [], uniquesConfigured: false }, "7d", now, rangeStart);
    expect(snapshot.uniques.configured).toBe(false);
    expect(snapshot.uniques.since).toBeNull();
    expect(snapshot.installConversion).toBeNull();
    expect(snapshot.funnel[0].unique).toBeNull();
    expect(snapshot.uniques.surfaces.site).toEqual({ unique: 0, new: 0, returning: 0, since: null });
  });

  /*
   * The salt was set on the 14th and the dashboard opened on the 15th, on the
   * 30-day range: thirty days of views beside one day of people. The snapshot
   * has to carry the day people start from, and say when it is inside the
   * range, or the funnel reads as 29,333 views from 84 people.
   */
  it("says since when people have been counted, and whether that is inside the range", () => {
    const covered = buildStatsSnapshot(rows, "7d", now, rangeStart);
    expect(covered.uniques.since).toBe(dayStart(now - 20 * DAY_MS));
    expect(peopleCountedSince(covered.uniques, covered.rangeStart)).toBeNull();

    const yesterday = dayStart(now - DAY_MS);
    const partial = buildStatsSnapshot({ ...rows, uniquesSince: yesterday }, "30d", now, now - 30 * DAY_MS);
    expect(partial.uniques.since).toBe(yesterday);
    expect(peopleCountedSince(partial.uniques, partial.rangeStart)).toBe(yesterday);

    /* Each surface starts on its own day: visitors cover the week, machines do not. */
    expect(covered.uniques.surfaces.site.since).toBe(dayStart(now - 20 * DAY_MS));
    expect(covered.uniques.surfaces.cli.since).toBe(dayStart(now - 2 * DAY_MS));
    expect(covered.uniques.surfaces.viewer.since).toBeNull();
    expect(peopleCountedSince(covered.uniques, rangeStart, "site")).toBeNull();
    expect(peopleCountedSince(covered.uniques, rangeStart, "cli")).toBe(dayStart(now - 2 * DAY_MS));
    expect(peopleCountedSince(covered.uniques, rangeStart, "viewer")).toBeNull();
    const unconfigured = buildStatsSnapshot({ ...rows, uniquesConfigured: false }, "7d", now, rangeStart);
    expect(unconfigured.uniques.surfaces.cli.since).toBeNull();

    /* People are kept by day, so a range that starts inside their first day is covered. */
    expect(peopleCountedSince({ configured: true, since: dayStart(rangeStart) }, rangeStart + 60_000)).toBeNull();
    expect(peopleCountedSince({ configured: false, since: yesterday }, now - 30 * DAY_MS)).toBeNull();
    expect(peopleCountedSince({ configured: true, since: null }, now - 30 * DAY_MS)).toBeNull();
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

function audience(
  event: string,
  target: string,
  device: string,
  count: number,
): Record<string, string | number | null> & { event: string; target: string; device: string; count: number } {
  return { event, target, device, count };
}

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
