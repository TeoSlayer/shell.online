import { describe, expect, it, vi } from "vitest";
import { relaySessionLiveness } from "./session-liveness";

const id = "a".repeat(32);
const session = { id, startedAt: 1 };

describe("relay session liveness", () => {
  it("reports relay states without fetching a stored share URL", async () => {
    const fetcher = vi.fn(async (_input?: unknown) => Response.json({ exists: true, status: "connected" }));
    const source = relaySessionLiveness("https://relay.example/base", { fetcher });

    await expect(source.one(id)).resolves.toMatchObject({ relayStatus: "connected" });
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://relay.example/api/sessions/${id}`);
  });

  it("distinguishes an ended relay object from a temporarily unreachable relay", async () => {
    const missing = relaySessionLiveness("https://relay.example", {
      fetcher: vi.fn(async () => new Response(null, { status: 404 })),
    });
    const unavailable = relaySessionLiveness("https://relay.example", {
      fetcher: vi.fn(async () => { throw new Error("network down"); }),
    });

    await expect(missing.one(id)).resolves.toMatchObject({ relayStatus: "missing" });
    await expect(unavailable.one(id)).resolves.toMatchObject({ relayStatus: "unknown" });
  });

  it("deduplicates concurrent checks and caches successful answers", async () => {
    const fetcher = vi.fn(async () => Response.json({ exists: true, status: "disconnected" }));
    const source = relaySessionLiveness("https://relay.example", { fetcher });

    const [one, two] = await Promise.all([source.one(id), source.one(id)]);
    const batch = await source.many([session]);

    expect(one.relayStatus).toBe("disconnected");
    expect(two.relayStatus).toBe("disconnected");
    expect(batch.get(id)?.relayStatus).toBe("disconnected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds each batch and eventually checks older unchecked sessions", async () => {
    let clock = 1_000;
    const fetcher = vi.fn(async () => Response.json({ exists: true, status: "connected" }));
    const source = relaySessionLiveness("https://relay.example", {
      fetcher,
      now: () => clock,
      maxChecksPerBatch: 1,
    });
    const first = { id: "a".repeat(32), startedAt: 2 };
    const second = { id: "b".repeat(32), startedAt: 1 };

    expect((await source.many([first, second])).get(first.id)?.relayStatus).toBe("connected");
    clock += 1;
    expect((await source.many([first, second])).get(second.id)?.relayStatus).toBe("connected");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not spend relay checks on locally closed or invalid session ids", async () => {
    const fetcher = vi.fn();
    const source = relaySessionLiveness("https://relay.example", { fetcher });
    const result = await source.many([
      { ...session, closedAt: 3 },
      { id: "../../metadata", startedAt: 1 },
    ]);

    expect(result.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes on when the relay last had the host socket", async () => {
    const source = relaySessionLiveness("https://relay.example", {
      fetcher: vi.fn(async () =>
        Response.json({ exists: true, status: "disconnected", host_last_seen_at: 1_700_000_000_000 })),
    });

    await expect(source.one(id)).resolves.toMatchObject({
      relayStatus: "disconnected",
      hostLastSeenAt: 1_700_000_000_000,
    });
  });

  /*
   * A card that alternated between "Offline" and "Status unavailable" every
   * few seconds -- and so between the Write and Finished columns -- was this:
   * a rate-limited or timed-out check overwrote a state the service already
   * had with "unknown".
   */
  it("keeps the last known state when a later check cannot be made", async () => {
    let clock = 1_000;
    let reply = () => Response.json({ exists: true, status: "disconnected", host_last_seen_at: 500 });
    const source = relaySessionLiveness("https://relay.example", {
      fetcher: vi.fn(async () => reply()),
      now: () => clock,
    });

    await source.many([session]);
    /* Past the cached answer's life, so the next batch re-checks and is refused. */
    clock += 31_000;
    reply = () => new Response(null, { status: 429 });
    const rateLimited = (await source.many([session])).get(id);
    /* And again with the relay unreachable rather than refusing. */
    clock += 6_000;
    reply = () => { throw new Error("network down"); };
    const unreachable = (await source.many([session])).get(id);

    expect(rateLimited).toMatchObject({ relayStatus: "disconnected", hostLastSeenAt: 500 });
    expect(unreachable).toMatchObject({ relayStatus: "disconnected", hostLastSeenAt: 500 });
  });

  it("reports a known state rather than unknown when the budget is spent", async () => {
    let clock = 1_000;
    const source = relaySessionLiveness("https://relay.example", {
      fetcher: vi.fn(async () => Response.json({ exists: true, status: "connected" })),
      now: () => clock,
      maxChecksPerMinute: 1,
    });

    expect((await source.one(id)).relayStatus).toBe("connected");
    clock += 6_000;
    expect((await source.one(id)).relayStatus).toBe("connected");
  });

  /*
   * The checks are a small shared budget. Re-confirming machines that are
   * away every five seconds spent all of it, and a session nobody had
   * managed to look at yet never got a turn.
   */
  it("does not spend the check budget re-confirming an absent machine", async () => {
    let clock = 1_000;
    const fetcher = vi.fn(async () => Response.json({ exists: true, status: "disconnected", host_last_seen_at: 1 }));
    const source = relaySessionLiveness("https://relay.example", { fetcher, now: () => clock });

    await source.many([session]);
    for (let poll = 0; poll < 5; poll += 1) {
      clock += 4_000;
      await source.many([session]);
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps aggregate reconciliation below the relay's connection-rate budget", async () => {
    const fetcher = vi.fn(async () => Response.json({ exists: true, status: "connected" }));
    const source = relaySessionLiveness("https://relay.example", {
      fetcher,
      maxChecksPerBatch: 10,
      maxChecksPerMinute: 2,
    });
    const sessions = ["a", "b", "c"].map((letter, index) => ({
      id: letter.repeat(32),
      startedAt: index,
    }));

    const states = await source.many(sessions);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect([...states.values()].filter((state) => state.relayStatus === "connected")).toHaveLength(2);
    expect([...states.values()].filter((state) => state.relayStatus === "unknown")).toHaveLength(1);
  });
});
