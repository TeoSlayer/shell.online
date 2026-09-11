import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./firebase", () => ({
  auth: { currentUser: { getIdToken: async () => "id-token" } },
}));

import { fetchDevices, NETWORK_FAILURE, SERVER_FAILURE } from "./api";

function respond(status: number, text: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request errors", () => {
  it("says shell.online could not be reached, naming no URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchDevices()).rejects.toThrow(NETWORK_FAILURE);
  });

  it("does not pass on a parser error when the edge answers with HTML", async () => {
    respond(502, "<html><body>Bad gateway</body></html>");
    await expect(fetchDevices()).rejects.toThrow(SERVER_FAILURE);
  });

  it("treats an unreadable success as a failure rather than returning it", async () => {
    respond(200, "<html></html>");
    await expect(fetchDevices()).rejects.toThrow(SERVER_FAILURE);
  });

  it("passes the service's own message through", async () => {
    respond(404, JSON.stringify({ error: "no such machine" }));
    await expect(fetchDevices()).rejects.toThrow("no such machine");
  });

  it("falls back to a sentence when a failure carries no message", async () => {
    respond(500, "");
    await expect(fetchDevices()).rejects.toThrow(SERVER_FAILURE);
  });

  it("returns the body of a success", async () => {
    respond(200, JSON.stringify({ devices: [] }));
    await expect(fetchDevices()).resolves.toEqual({ devices: [] });
  });
});
