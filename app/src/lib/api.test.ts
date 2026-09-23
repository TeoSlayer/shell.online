import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./oidc", () => ({
  oidcConfigured: true,
  userManager: { getUser: async () => ({ id_token: "id-token", expired: false }) },
}));
vi.mock("./firebase", () => ({ auth: null }));
const { result } = vi.hoisted(() => ({ result: vi.fn() }));
vi.mock("../../../web/posthog", () => ({ trackAppAction: vi.fn(), beginApiRequest: vi.fn(() => result) }));

import { fetchDevices, revokeDevice, request, NETWORK_FAILURE, SERVER_FAILURE } from "./api";
import { trackAppAction } from "../../../web/posthog";

function respond(status: number, text: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
    expect(result).toHaveBeenCalledExactlyOnceWith("ok");
  });
  it.each([
    [200, '{"revoked":true}', true, undefined],
    [403, '{"error":"PRIVATE_ERROR"}', false, "http"],
    [200, '<html>PRIVATE_ERROR</html>', false, "response"],
  ])("records exactly one categorized mutation result for status %s", async (status, text, ok, failure) => {
    respond(status as number, text as string);
    await revokeDevice("private-device").catch(() => {});
    expect(trackAppAction).toHaveBeenCalledTimes(1);
    expect(trackAppAction).toHaveBeenCalledWith("/api/devices/private-device", "DELETE", ok, ...(failure ? [failure] : []));
    expect(JSON.stringify(vi.mocked(trackAppAction).mock.calls)).not.toContain("PRIVATE_ERROR");
    expect(result).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledWith(status === 403 ? "denied" : status === 200 && ok ? "ok" : "response");
  });
  it("records a failed body read without falsely recording success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => { throw new Error("PRIVATE_ERROR"); } })));
    await expect(revokeDevice("private-device")).rejects.toThrow(NETWORK_FAILURE);
    expect(trackAppAction).toHaveBeenCalledExactlyOnceWith("/api/devices/private-device", "DELETE", false, "network");
    expect(result).toHaveBeenCalledExactlyOnceWith("network");
  });
  it("distinguishes cancellation from a network failure", async () => {
    const controller = new AbortController(); controller.abort();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("PRIVATE", "AbortError"); }));
    await expect(request("/api/notifications", { signal: controller.signal })).rejects.toThrow(NETWORK_FAILURE);
    expect(result).toHaveBeenCalledExactlyOnceWith("cancelled");
  });
});
