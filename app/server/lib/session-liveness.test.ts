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
