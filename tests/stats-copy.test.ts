import { describe, expect, it } from "vitest";
import { buildStatsSnapshot, DAY_MS, dayStart, type StatsSnapshotRows } from "../shared/stats-snapshot";
import {
  deltaChip,
  formatDuration,
  formatPercent,
  funnelInsight,
  humanize,
  outcomePhrase,
  ratio,
  sessionsInsight,
  trafficInsight,
} from "../shared/stats-copy";

const now = Date.UTC(2026, 8, 15, 12);
const rangeStart = now - 7 * DAY_MS;

function metric(event: string, target: string, count: number, value = 0) {
  return { event, target, count, value_sum: value, value_max: value, auxiliary_sum: 0, auxiliary_max: 0 };
}

/** A week with a little of everything, so every sentence has something to say. */
function rows(overrides: Partial<StatsSnapshotRows> = {}): StatsSnapshotRows {
  return {
    summary: [
      metric("page_view", "landing", 10),
      metric("copy", "install", 3),
      metric("installer_download", "posix", 4),
      metric("binary_download", "darwin-arm64", 1),
      metric("session_created", "cli", 6),
      metric("session_started", "cli", 5),
      metric("share_opened", "viewer", 2, 40),
      metric("collaboration_started", "remote_input", 1),
      metric("session_ended", "task_exit", 3, 300),
      metric("session_ended", "never_started", 1),
    ],
    byDevice: [
      { event: "page_view", target: "landing", device: "desktop", count: 8 },
      { event: "page_view", target: "landing", device: "bot", count: 2 },
      { event: "installer_download", target: "posix", device: "cli", count: 4 },
      { event: "binary_download", target: "darwin-arm64", device: "cli", count: 1 },
    ],
    previous: null,
    trend: [],
    devices: [],
    referrers: [{ name: "direct", count: 6 }, { name: "github", count: 4 }],
    clients: [],
    openedDevices: [],
    typedDevices: [],
    live: { active_sessions: 0, active_viewers: 0 },
    collectingSince: now - 30 * DAY_MS,
    uniques: [{ surface: "site", unique_count: 7, new_count: 7 }, { surface: "cli", unique_count: 3, new_count: 3 }],
    uniqueDays: [],
    retention: [],
    installConversion: null,
    uniquesConfigured: true,
    uniquesSince: dayStart(now - 20 * DAY_MS),
    ...overrides,
  };
}

describe("the dashboard's copy", () => {
  it("says what the funnel found, with crawlers, copies and never-connected sessions in their places", () => {
    const snapshot = buildStatsSnapshot(rows(), "7d", now, rangeStart);
    expect(funnelInsight(snapshot)).toBe(
      "8 views by people from 7 visitors, and 2 by crawlers kept out. 3 copied an install command. " +
      "4 installer runs, 1 completed (25%). 1 more was created but never connected. " +
      "5 sessions started on 3 machines; 40% were opened in a browser, and 50% of those were typed into.",
    );
  });

  it("says so when there is nothing to describe, instead of dividing by zero", () => {
    const empty = buildStatsSnapshot(rows({ summary: [], byDevice: [], uniques: [], referrers: [] }), "7d", now, rangeStart);
    expect(funnelInsight(empty)).toBe("No page views from browsers in this range. No session started.");
    expect(trafficInsight(empty)).toBe("No landing or documentation views in this range.");
    expect(sessionsInsight(empty)).toBe("No session was created in this range.");
  });

  it("says how much of the traffic was crawlers, where the rest came from, and what fell through", () => {
    const snapshot = buildStatsSnapshot(rows(), "7d", now, rangeStart);
    expect(trafficInsight(snapshot)).toBe("20% of 10 views were crawlers. Top source of landing visits: Direct (60%).");
    const lost = buildStatsSnapshot(rows({ summary: [...rows().summary, metric("page_view", "unknown_path", 1)] }), "7d", now, rangeStart);
    expect(trafficInsight(lost)).toContain("1 request hit a path the site does not know and got the landing page.");
  });

  it("says how sessions went: rate, outcome, lifetime, the wait for a first open, and who was turned away", () => {
    const snapshot = buildStatsSnapshot(rows(), "7d", now, rangeStart);
    const sentence = sessionsInsight(snapshot);
    expect(sentence).toContain("6 created, 5 started (83%), about 0.7 a day.");
    expect(sentence).toContain("75% of the 4 that ended did so because the task exited; a session lasted 1m on average.");
    expect(sentence).toContain("A link waited 20s for its first open on average.");
    expect(sentence).not.toContain("turned away");
    const refused = buildStatsSnapshot(rows({ summary: [...rows().summary, metric("viewer_rejected", "session_full", 1)] }), "7d", now, rangeStart);
    expect(sessionsInsight(refused)).toContain("1 viewer was turned away by a full, expired or unknown session.");
  });

  it("phrases every outcome the relay records, and quotes one it does not know", () => {
    expect(outcomePhrase("task_exit")).toBe("did so because the task exited");
    expect(outcomePhrase("persistent_task_exit")).toBe("did so because a persistent task exited");
    expect(outcomePhrase("disconnected_timeout")).toBe("timed out after the host disconnected");
    expect(outcomePhrase("never_started")).toBe("never started");
    expect(outcomePhrase("expired")).toBe("expired");
    expect(outcomePhrase("weird_thing")).toBe("ended as “Weird Thing”");
  });

  it("makes a delta chip that says new, same, a percentage, or a multiple, and nothing without a period before", () => {
    expect(deltaChip(10, null, "the 7d before")).toBeNull();
    expect(deltaChip(10, 5, "")).toBeNull();
    expect(deltaChip(0, 0, "the 7d before")).toEqual({ tone: "flat", text: "same", title: "0 in the 7d before" });
    expect(deltaChip(3, 0, "the 7d before")).toEqual({ tone: "up", text: "new", title: "0 in the 7d before" });
    expect(deltaChip(1000, 1002, "the 7d before")).toMatchObject({ tone: "flat", text: "same" });
    expect(deltaChip(150, 100, "the 7d before")).toEqual({ tone: "up", text: "▲50%", title: "100 in the 7d before" });
    expect(deltaChip(80, 100, "the 30d before")).toEqual({ tone: "down", text: "▼20%", title: "100 in the 30d before" });
    expect(deltaChip(1500, 100, "the 7d before")).toEqual({ tone: "up", text: "▲15×", title: "100 in the 7d before" });
    expect(deltaChip(2, 100, "the 7d before")).toEqual({ tone: "down", text: "▼98%", title: "100 in the 7d before" });
  });

  it("formats durations, shares and names the way the page shows them", () => {
    expect([0, 45, 90, 3_600, 5_400, 90_000, Number.NaN].map(formatDuration)).toEqual(["0s", "45s", "2m", "1h", "1.5h", "1d", "0s"]);
    expect([0.126, 2, -1, 0].map(formatPercent)).toEqual(["13%", "100%", "0%", "0%"]);
    expect(ratio(1, 0)).toBe(0);
    expect(ratio(3, 2)).toBe(1);
    expect(humanize("docs_app")).toBe("Docs · Web app");
    expect(humanize("darwin-arm64")).toBe("macOS arm64");
    expect(humanize("freebsd-armv7")).toBe("FreeBSD armv7");
    expect(humanize("typed_into_read_only")).toBe("Typed into a read-only session");
    expect(humanize("checksum_mismatch")).toBe("Checksum mismatch");
    expect(humanize("machine_linked")).toBe("Linked a machine");
    expect(humanize("some_new_thing")).toBe("Some New Thing");
  });
});
