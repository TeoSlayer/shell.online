import { describe, expect, it } from "vitest";
import { encryptionFragment, resolveSessionSocket, sessionIdFromShareUrl } from "./socket-url";

const ID = "VLWgqcUgToMSkL6PzqxYtnHEUl2sz8xE";

const RELAY = "http://127.0.0.1:8788";

/* Thin helper so the existing cases stay about URL shape, not result shape. */
function target(shareUrl: string, appOrigin: string, relay: string | undefined = RELAY) {
  const result = resolveSessionSocket(shareUrl, appOrigin, relay);
  return result.ok ? result.target : null;
}

describe("resolveSessionSocket", () => {
  it("connects directly when the app is served from the relay", () => {
    expect(target(`https://shell.online/s/${ID}`, "https://shell.online", undefined)).toEqual({
      url: `wss://shell.online/api/sessions/${ID}/ws`,
      proxied: false,
    });
  });

  it("goes through the dev proxy when the origins differ", () => {
    /* The relay 403s a foreign Origin, so a direct socket would be refused. */
    expect(target(`http://127.0.0.1:8788/s/${ID}`, "http://localhost:5173")).toEqual({
      url: `ws://localhost:5173/relay/api/sessions/${ID}/ws`,
      proxied: true,
    });
  });

  it("follows the app's scheme, not the relay's", () => {
    /* A ws:// socket from an https:// page is blocked as mixed content. */
    const resolved = target(`http://127.0.0.1:8788/s/${ID}`, "https://app.example.com");
    expect(resolved?.url.startsWith("wss://app.example.com/relay/")).toBe(true);
  });

  it("keeps a non-default port on a same-origin connection", () => {
    expect(target(`http://127.0.0.1:8788/s/${ID}`, "http://127.0.0.1:8788")).toEqual({
      url: `ws://127.0.0.1:8788/api/sessions/${ID}/ws`,
      proxied: false,
    });
  });

  it("ignores the encryption fragment when building the socket URL", () => {
    const resolved = target(
      `https://shell.online/s/${ID}#salt=i6AaAzfYyklCDqgMRgEIDw`,
      "https://shell.online",
      undefined,
    );
    expect(resolved?.url).toBe(`wss://shell.online/api/sessions/${ID}/ws`);
  });

  it("refuses a share URL whose path is not a session", () => {
    for (const bad of [
      "https://shell.online/",
      "https://shell.online/s/tooshort",
      `https://shell.online/s/${ID}/extra`,
      `https://shell.online/download/${ID}`,
      "not a url",
      "",
    ]) {
      expect(target(bad, "https://shell.online", undefined)).toBeNull();
    }
  });

  it("refuses a malformed app origin", () => {
    expect(target(`https://shell.online/s/${ID}`, "nonsense", undefined)).toBeNull();
  });
});

describe("a session on a relay the app cannot reach", () => {
  it("names both relays rather than reporting the session as missing", () => {
    /* Proxying it anyway would open a socket to the wrong relay, which answers
       "no such session" and sends you looking for the wrong problem. */
    const result = resolveSessionSocket(
      `https://shell.online/s/${ID}`,
      "http://localhost:5173",
      RELAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("https://shell.online");
      expect(result.reason).toContain("http://127.0.0.1:8788");
      expect(result.reason).toContain("SHELL_ONLINE_SERVER");
    }
  });

  it("explains when no relay is configured at all", () => {
    const result = resolveSessionSocket(
      `https://shell.online/s/${ID}`,
      "http://localhost:5173",
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not configured to reach");
  });

  it("still proxies when the relay matches", () => {
    const result = resolveSessionSocket(
      `http://127.0.0.1:8788/s/${ID}`,
      "http://localhost:5173",
      RELAY,
    );
    expect(result.ok).toBe(true);
  });

  it("reports a malformed relay setting plainly", () => {
    const result = resolveSessionSocket(
      `http://127.0.0.1:8788/s/${ID}`,
      "http://localhost:5173",
      "not a url",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not valid");
  });
});

describe("sessionIdFromShareUrl", () => {
  it("extracts the id", () => {
    expect(sessionIdFromShareUrl(`https://shell.online/s/${ID}#salt=abc`)).toBe(ID);
  });

  it("returns null for anything else", () => {
    expect(sessionIdFromShareUrl("https://shell.online/")).toBeNull();
    expect(sessionIdFromShareUrl("garbage")).toBeNull();
  });
});

describe("encryptionFragment", () => {
  it("returns the fragment when present", () => {
    expect(encryptionFragment(`https://shell.online/s/${ID}#salt=abc`)).toBe("#salt=abc");
  });

  it("returns an empty string when absent or malformed", () => {
    expect(encryptionFragment(`https://shell.online/s/${ID}`)).toBe("");
    expect(encryptionFragment("garbage")).toBe("");
  });
});
