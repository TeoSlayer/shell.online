import { describe, expect, it } from "vitest";
import type { SessionRecord } from "./api";
import {
  HOST_GONE_MS,
  hostGone,
  keepKnownLiveness,
  sessionEnded,
  sessionOnline,
  sessionStateLabel,
} from "./session-liveness";

describe("session liveness presentation", () => {
  it("keeps a disconnected session reopenable without calling it online", () => {
    const session = { relayStatus: "disconnected" as const };
    expect(sessionEnded(session)).toBe(false);
    expect(sessionOnline(session)).toBe(false);
    expect(sessionStateLabel(session)).toBe("Offline");
  });

  it("treats exited and missing relay sessions as ended", () => {
    for (const relayStatus of ["exited", "missing"] as const) {
      expect(sessionEnded({ relayStatus })).toBe(true);
      expect(sessionOnline({ relayStatus })).toBe(false);
    }
  });

  it("does not turn a failed liveness check into a false process exit", () => {
    const session = { relayStatus: "unknown" as const };
    expect(sessionEnded(session)).toBe(false);
    expect(sessionStateLabel(session)).toBe("Status unavailable");
  });
});

describe("a machine that stopped answering", () => {
  const seen = 1_000_000_000_000;
  const disconnected = { relayStatus: "disconnected" as const, hostLastSeenAt: seen };

  it("is still just offline while it could be reconnecting", () => {
    const soon = seen + HOST_GONE_MS - 1;
    expect(hostGone(disconnected, soon)).toBe(false);
    expect(sessionEnded(disconnected, soon)).toBe(false);
    expect(sessionStateLabel(disconnected, soon)).toBe("Offline");
  });

  /*
   * The reboot and power-cut case. Nothing closes these sessions -- the CLI
   * never got to -- so before this they sat in the Write column, offered as
   * something to type into, until the relay expired them hours later.
   */
  it("is over once it has been away longer than a reconnect could take", () => {
    const later = seen + HOST_GONE_MS;
    expect(hostGone(disconnected, later)).toBe(true);
    expect(sessionEnded(disconnected, later)).toBe(true);
    expect(sessionOnline(disconnected, later)).toBe(false);
    expect(sessionStateLabel(disconnected, later)).toBe("Machine gone");
  });

  it("comes back to life by itself when the machine does", () => {
    const back = { relayStatus: "connected" as const, hostLastSeenAt: seen };
    expect(sessionEnded(back, seen + HOST_GONE_MS * 10)).toBe(false);
    expect(sessionOnline(back, seen + HOST_GONE_MS * 10)).toBe(true);
  });

  it("leaves a persistent session waiting, because that is what it is for", () => {
    const waiting = { ...disconnected, persistent: true };
    expect(sessionEnded(waiting, seen + HOST_GONE_MS * 10)).toBe(false);
    expect(sessionStateLabel(waiting, seen + HOST_GONE_MS * 10)).toBe("Offline");
  });

  it("says nothing about a session no host has ever reached", () => {
    const never = { relayStatus: "disconnected" as const };
    expect(hostGone(never, Date.now())).toBe(false);
  });
});

describe("keeping a known relay state across a poll", () => {
  const base = { id: "s1", command: "npm test" } as unknown as SessionRecord;

  it("ignores an unknown that arrives after something known", () => {
    const previous = [{ ...base, relayStatus: "disconnected" as const, relayCheckedAt: 5, hostLastSeenAt: 4 }];
    const merged = keepKnownLiveness(previous, [{ ...base, relayStatus: "unknown" as const }]);
    expect(merged[0]).toMatchObject({ relayStatus: "disconnected", relayCheckedAt: 5, hostLastSeenAt: 4 });
  });

  it("accepts every answer that is not unknown", () => {
    const previous = [{ ...base, relayStatus: "connected" as const }];
    const merged = keepKnownLiveness(previous, [{ ...base, relayStatus: "exited" as const }]);
    expect(merged[0].relayStatus).toBe("exited");
  });

  it("has nothing to keep for a session it has not seen before", () => {
    const merged = keepKnownLiveness([], [{ ...base, relayStatus: "unknown" as const }]);
    expect(merged[0].relayStatus).toBe("unknown");
  });
});
