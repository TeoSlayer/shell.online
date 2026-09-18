import { describe, expect, it, vi } from "vitest";
import { closeEndedSessions } from "./session-reconcile";
import type { SessionLiveness } from "./session-liveness";
import type { SessionRecord, Store } from "./store";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "a".repeat(32),
    uid: "uid-1",
    shareUrl: "https://shell.online/s/x",
    command: "npm test",
    readOnly: false,
    encrypted: true,
    persistent: false,
    host: "laptop",
    startedAt: 1_000,
    ...overrides,
  } as SessionRecord;
}

function storeWith(patchSession = vi.fn(async () => null)) {
  return { store: { patchSession } as unknown as Store, patchSession };
}

const states = (liveness: SessionLiveness) => new Map([["a".repeat(32), liveness]]);
const log = () => {};

describe("closing sessions the relay says are over", () => {
  it.each(["missing", "exited"] as const)("writes down a %s session's end", async (relayStatus) => {
    const { store, patchSession } = storeWith();
    const rows = [session()];

    const settled = await closeEndedSessions(
      store, rows, states({ relayStatus, relayCheckedAt: 9_000, hostLastSeenAt: 8_000 }), log, 9_500,
    );

    /* The host socket's last moment is the closest thing to a time of death. */
    expect(patchSession).toHaveBeenCalledWith("uid-1", "a".repeat(32), { closedAt: 8_000 });
    expect(settled[0].closedAt).toBe(8_000);
  });

  it("falls back to when the end was noticed", async () => {
    const { store, patchSession } = storeWith();

    await closeEndedSessions(store, [session()], states({ relayStatus: "missing" }), log, 9_500);

    expect(patchSession).toHaveBeenCalledWith("uid-1", "a".repeat(32), { closedAt: 9_500 });
  });

  /*
   * A machine that is merely away may be reconnecting, and a persistent
   * session is waiting to be resumed. Both are decided on the client, where
   * the answer can change back; writing one down here could not be undone.
   */
  it.each(["disconnected", "waiting", "connected", "unknown"] as const)(
    "leaves a %s session alone",
    async (relayStatus) => {
      const { store, patchSession } = storeWith();

      const settled = await closeEndedSessions(
        store, [session()], states({ relayStatus, hostLastSeenAt: 1 }), log, 9_500,
      );

      expect(patchSession).not.toHaveBeenCalled();
      expect(settled[0].closedAt).toBeUndefined();
    },
  );

  it("does not rewrite an end the machine already reported", async () => {
    const { store, patchSession } = storeWith();

    await closeEndedSessions(store, [session({ closedAt: 42 })], states({ relayStatus: "missing" }), log);

    expect(patchSession).not.toHaveBeenCalled();
  });

  it("still returns the sessions when the write fails", async () => {
    const patchSession = vi.fn(async () => { throw new Error("database down"); });
    const problems: string[] = [];

    const settled = await closeEndedSessions(
      { patchSession } as unknown as Store,
      [session()],
      states({ relayStatus: "exited" }),
      (message) => problems.push(message),
      9_500,
    );

    expect(settled).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });
});
