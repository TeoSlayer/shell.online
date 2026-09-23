import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { MemoryStore } from "../server/lib/store-memory";
import { PostgresStore } from "../server/lib/store-postgres";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(enabled = true) {
  const captured: any[] = [], pending: Promise<unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    captured.push(JSON.parse(init.body)); return new Response("1");
  }));
  const store = new MemoryStore(null);
  vi.spyOn(PostgresStore, "connect").mockResolvedValue(store as never);
  const env: Env = {
    POSTHOG_ENABLED: enabled ? "1" : undefined,
    ASSETS: { fetch: async () => new Response("fixture") },
    HYPERDRIVE: { connectionString: "PRIVATE_DB_SECRET" },
    OIDC_ISSUER: "https://auth.example.test", OIDC_AUDIENCE: "test",
    WEB_ORIGIN: "https://app.shell.online", RELAY_URL: "https://shell.online",
  };
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  return { env, ctx, captured, pending, store };
}

describe("actual account Worker telemetry boundary", () => {
  it("records exactly one bounded HTTP result, never headers, query or response bodies", async () => {
    const s = setup();
    for (const [path, expected, outcome] of [["health", 200, "ok"], ["vault", 401, "denied"]] as const) {
      const response = await worker.fetch(new Request(`https://app.shell.online/api/${path}?password=PRIVATE_QUERY`, {
        headers: { "X-Private": "PRIVATE_HEADER", cookie: "secret=PRIVATE_COOKIE" },
      }), s.env, s.ctx);
      expect(response.status).toBe(expected);
      await Promise.all(s.pending);
      expect(s.captured.at(-1)).toMatchObject({ event: "service_request", properties: { outcome, service: "accounts", trigger: "request" } });
    }
    expect(s.captured).toHaveLength(2);
    expect(JSON.stringify(s.captured)).not.toContain("PRIVATE_");
    expect(s.captured.every(e => !e.properties.$session_id && !e.properties.$current_url)).toBe(true);
  });
  it("records database-open failures without changing the thrown error or leaking it", async () => {
    const s = setup(), failure = new Error("PRIVATE_DATABASE_PASSWORD");
    vi.mocked(PostgresStore.connect).mockRejectedValue(failure);
    await expect(worker.fetch(new Request("https://app.shell.online/api/vault"), s.env, s.ctx)).rejects.toBe(failure);
    await Promise.all(s.pending);
    expect(s.captured).toHaveLength(1);
    expect(s.captured[0].properties).toMatchObject({ operation: "vault_read", outcome: "failed" });
    expect(JSON.stringify(s.captured)).not.toContain("PRIVATE_");
  });
  it("does not turn pages/assets/unknown endpoints into API successes", async () => {
    const s = setup();
    await worker.fetch(new Request("https://app.shell.online/assets/file.js"), s.env, s.ctx);
    await worker.fetch(new Request("https://app.shell.online/api/health", { headers: { Purpose: "prefetch" } }), s.env, s.ctx);
    await worker.fetch(new Request("https://app.shell.online/api/PRIVATE_UNKNOWN"), s.env, s.ctx);
    await Promise.all(s.pending);
    expect(s.captured).toEqual([]);
  });
  it("stays disabled when unconfigured and tolerates a broken collector", async () => {
    const s = setup(false);
    await worker.fetch(new Request("https://app.shell.online/api/health"), s.env, s.ctx);
    expect(s.captured).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("collector unavailable"); }));
    const response = await worker.fetch(new Request("https://app.shell.online/api/health"), { ...s.env, POSTHOG_ENABLED: "1" }, s.ctx);
    expect(response.status).toBe(200);
    await Promise.all(s.pending);
  });
  it.each(["ok", "open", "purge", "close"])("measures the scheduled task including %s failure, once", async mode => {
    const s = setup(); vi.spyOn(console, "error").mockImplementation(() => {});
    if (mode === "open") vi.mocked(PostgresStore.connect).mockRejectedValue(new Error("PRIVATE_OPEN"));
    if (mode === "purge") vi.spyOn(s.store, "purgeExpired").mockRejectedValue(new Error("PRIVATE_PURGE"));
    if (mode === "close") vi.spyOn(s.store, "close").mockRejectedValue(new Error("PRIVATE_CLOSE"));
    await worker.scheduled({ cron: "*/5 * * * *" }, s.env, s.ctx).catch(() => {});
    await Promise.allSettled(s.pending);
    expect(s.captured).toHaveLength(1);
    expect(s.captured[0].properties).toMatchObject({ operation: "service_purge", trigger: "scheduled", outcome: mode === "ok" ? "ok" : "failed" });
    expect(JSON.stringify(s.captured)).not.toContain("PRIVATE_");
  });
});
