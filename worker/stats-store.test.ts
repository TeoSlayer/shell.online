import { describe, expect, it } from "vitest";
import {
  buildStatsSnapshot,
  STATS_PRESENCE_LEASE_MS,
  STATS_PRESENCE_REFRESH_MS,
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
    }, "24h", now, now - 24 * 60 * 60 * 1_000);

    expect(snapshot.metrics.activeSessions).toBe(0);
    expect(snapshot.metrics.activeViewers).toBe(0);
    expect(STATS_PRESENCE_LEASE_MS).toBeGreaterThan(STATS_PRESENCE_REFRESH_MS * 2);
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
