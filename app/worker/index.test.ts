import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

function environment(fetchAsset: Env["ASSETS"]["fetch"]): Env {
  return {
    ASSETS: { fetch: fetchAsset },
    HYPERDRIVE: { connectionString: "postgres://unused" },
    FIREBASE_PROJECT_ID: "test-project",
    WEB_ORIGIN: "https://app.shell.online",
    RELAY_URL: "https://shell.online",
  };
}

describe("Cloudflare app assets", () => {
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
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(response.headers.get("Content-Security-Policy")).toContain("https://apis.google.com");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
