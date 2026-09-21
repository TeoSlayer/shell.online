import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { MemoryStore } from "../server/lib/store-memory";
import { PostgresStore } from "../server/lib/store-postgres";

function environment(fetchAsset: Env["ASSETS"]["fetch"]): Env {
  return {
    ASSETS: { fetch: fetchAsset },
    HYPERDRIVE: { connectionString: "postgres://unused" },
    OIDC_ISSUER: "https://auth.example.test/realms/shell",
    OIDC_AUDIENCE: "shell-online-app",
    WEB_ORIGIN: "https://app.shell.online",
    RELAY_URL: "https://shell.online",
  };
}

describe("Cloudflare app assets", () => {
  it("wires the team authorization secret through the deployed Worker entrypoint", async () => {
    const store = new MemoryStore(null);
    const connect = vi.spyOn(PostgresStore, "connect").mockResolvedValue(store as never);
    const env = { ...environment(async () => new Response("")), MCP_TEAM_CHECK_TOKEN: "team-worker-secret".padEnd(40, "x") };
    const url = "https://app.shell.online/api/internal/mcp/team-authorized?session=s1&requester=u1&grant=g1";
    try {
      const response = await worker.fetch(new Request(url, {
        headers: { Authorization: `Bearer ${env.MCP_TEAM_CHECK_TOKEN}` },
      }), env, { waitUntil: vi.fn() });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authorized: false });
      const refused = await worker.fetch(new Request(url), env, { waitUntil: vi.fn() });
      expect(refused.status).toBe(401);
    } finally { connect.mockRestore(); }
  });
  it("routes assets through the Worker in production", async () => {
    const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(config).toMatch(/"run_worker_first"\s*:\s*true/);
  });

  it("adds the browser security headers to app documents", async () => {
    const fetchAsset = vi.fn(async () =>
      new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }),
    );

    const response = await worker.fetch(
      new Request("https://app.shell.online/sessions/example"),
      environment(fetchAsset),
      { waitUntil: vi.fn() },
    );

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "https://auth.example.test",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
  });
});
