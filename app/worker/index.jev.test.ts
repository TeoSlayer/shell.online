import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./index";

const wiring = vi.hoisted(() => ({
  createApp: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock("../server/app", () => ({ createApp: wiring.createApp }));
vi.mock("../server/lib/store-postgres", () => ({ PostgresStore: { connect: wiring.connect } }));

function environment(key?: string): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response("static client")) },
    HYPERDRIVE: { connectionString: "postgres://unused-entrypoint-fixture" },
    OIDC_ISSUER: "https://auth.example.test/realms/shell",
    OIDC_AUDIENCE: "shell-online-app",
    WEB_ORIGIN: "https://app.example.test",
    RELAY_URL: "https://relay.example.test",
    JEV_API_KEY: key,
  };
}

beforeEach(() => {
  vi.resetModules(); // Each case represents a fresh Worker isolate/router.
  vi.clearAllMocks();
  wiring.connect.mockResolvedValue({ close: wiring.close });
  wiring.createApp.mockReturnValue((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(204);
    response.end();
  });
});

describe("Cloudflare Jev deployment binding", () => {
  it.each([
    [undefined, undefined],
    [" \t ", undefined],
    ["  synthetic-entrypoint-key  ", "synthetic-entrypoint-key"],
  ])("passes only the normalized server binding to the API router (%j)", async (key, expected) => {
    const { default: worker } = await import("./index");
    const env = environment(key);
    const response = await worker.fetch(
      new Request("https://app.example.test/api/health"),
      env,
      { waitUntil: vi.fn() },
    );

    expect(wiring.createApp).toHaveBeenCalledOnce();
    expect(wiring.createApp.mock.calls[0][0].jevApiKey).toBe(expected);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(wiring.close).toHaveBeenCalledOnce();
  });

  it("does not initialize analysis or disclose the binding when serving assets", async () => {
    const { default: worker } = await import("./index");
    const response = await worker.fetch(
      new Request("https://app.example.test/game"),
      environment("synthetic-entrypoint-key"),
      { waitUntil: vi.fn() },
    );

    expect(await response.text()).toBe("static client");
    expect([...response.headers.values()].join(" ")).not.toContain("synthetic-entrypoint-key");
    expect(wiring.createApp).not.toHaveBeenCalled();
    expect(wiring.connect).not.toHaveBeenCalled();
  });
});
