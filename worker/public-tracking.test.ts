import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "./index";
import { RELEASE_VERSION } from "../shared/release";

function harness(assetStatus = 200) {
  const records: unknown[] = [];
  const points: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const assets: string[] = [];
  const env = {
    ANALYTICS: { writeDataPoint: (point: unknown) => points.push(point) },
    STATS: {
      getByName: () => ({
        fetch: async (_url: unknown, options: { body: string }) => {
          records.push(JSON.parse(options.body));
          return new Response(null, { status: 204 });
        },
      }),
    },
    EVENT_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: {
      fetch: async (request: Request) => {
        assets.push(new URL(request.url).pathname);
        // Cloudflare's default HTML handling redirects /file.html to /file.
        // Passing that through would lose the original archived version URL.
        if (new URL(request.url).pathname.endsWith(".html")) {
          return new Response(null, {
            status: 307,
            headers: { Location: new URL(request.url).pathname.slice(0, -5) },
          });
        }
        return new Response("fixture", {
          status: assetStatus,
          headers: {
            "Content-Type": new URL(request.url).pathname.startsWith(
              "/downloads/",
            )
              ? "application/octet-stream"
              : "text/html",
          },
        });
      },
    },
  };
  return {
    records,
    points,
    assets,
    async fetch(
      path: string,
      body?: string,
      extraHeaders: Record<string, string> = {},
    ) {
      const request = new Request(`https://shell.online${path}`, {
        method: body === undefined ? "GET" : "POST",
        body,
        headers: {
          Origin: "https://shell.online",
          "User-Agent": "Mozilla/5.0",
          "Content-Type": "application/json",
          ...extraHeaders,
        },
      });
      const response = await worker.fetch(
        request as never,
        env as never,
        { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
      );
      while (pending.length) await Promise.all(pending.splice(0));
      return response;
    },
  };
}

describe("first-party analytics through the real Worker route", () => {
  it("serves the requested current guide but not current instructions for historical releases", async () => {
    const h = harness();
    await h.fetch(`/docs/v${RELEASE_VERSION}/mobile/`);
    const archive = await h.fetch("/docs/v0.6.0/mobile/");
    const agents = await h.fetch("/agents/");
    expect(archive.status).toBe(200);
    expect(archive.headers.get("Location")).toBeNull();
    expect(h.assets).toEqual(["/mobile/", "/docs/archive/", "/agents/"]);
    expect(agents.status).toBe(200);
    expect(agents.headers.get("Content-Security-Policy")).toContain(
      "www.googletagmanager.com",
    );
  });
  it("retains only fixed event fields and allowlisted source in both sinks", async () => {
    const h = harness();
    const response = await h.fetch(
      "/api/events",
      JSON.stringify({
        event: "copy",
        target: "install",
        source: "x",
        password: "PRIVATE_MARKER",
        url: "PRIVATE_MARKER",
      }),
    );
    expect(response.status).toBe(204);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({
      event: "copy",
      target: "install",
      referrer: "x",
    });
    expect(JSON.stringify([h.points, h.records])).not.toContain(
      "PRIVATE_MARKER",
    );
  });
  it("accepts loaded and all new CTA events without confusing them with signups", async () => {
    const h = harness();
    for (const [event, target] of [
      ["page_loaded", "landing"],
      ["cta_click", "start_hero"],
      ["cta_click", "start_footer"],
      ["cta_click", "demo"],
      ["cta_click", "github_star"],
      ["copy", "source_build"],
      ["copy", "docs_command"],
    ]) {
      expect(
        (
          await h.fetch(
            "/api/events",
            JSON.stringify({ event, target, source: "x" }),
          )
        ).status,
      ).toBe(204);
    }
    expect(h.records).toHaveLength(7);
  });
  it("bounds bodies even without Content-Length, rejects invalid source and malformed JSON", async () => {
    const h = harness();
    expect(
      (
        await h.fetch(
          "/api/events",
          JSON.stringify({
            event: "copy",
            target: "install",
            extra: "x".repeat(300),
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await h.fetch(
          "/api/events",
          '{"event":"copy","target":"install","source":"PRIVATE_MARKER"}',
        )
      ).status,
    ).toBe(400);
    expect((await h.fetch("/api/events", "null")).status).toBe(400);
    expect(h.records).toHaveLength(0);
  });
  it("honors browser privacy signals and rejects cross-origin event submissions", async () => {
    const h = harness();
    const body = '{"event":"copy","target":"install"}';
    expect(
      (await h.fetch("/api/events", body, { "Sec-GPC": "1" })).status,
    ).toBe(204);
    expect((await h.fetch("/api/events", body, { DNT: "1" })).status).toBe(204);
    expect(
      (
        await h.fetch("/api/events", body, {
          Origin: "https://untrusted.example",
        })
      ).status,
    ).toBe(403);
    expect(h.records).toHaveLength(0);
  });
  it("does not count partial range responses as another full binary download", async () => {
    const partial = harness(206);
    await partial.fetch("/downloads/shell-darwin-arm64", undefined, {
      Range: "bytes=0-99",
    });
    expect(partial.records).toHaveLength(0);
    const full = harness();
    await full.fetch("/downloads/shell-darwin-arm64");
    expect(full.records).toHaveLength(1);
    expect(full.records[0]).toMatchObject({ event: "binary_download" });
  });
  it("does not count speculative asset fetches as install intent", async () => {
    const h = harness();
    for (const path of [
      "/install",
      "/install.ps1",
      "/downloads/shell-darwin-arm64",
    ]) {
      await h.fetch(path, undefined, { "Sec-Purpose": "prefetch;prerender" });
      await h.fetch(path, undefined, { Purpose: "prefetch" });
    }
    expect(h.records).toHaveLength(0);
  });
});
