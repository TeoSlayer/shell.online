import { describe, expect, it } from "vitest";
import { encryptionFragment, sessionIdFromShareUrl, sessionSocketUrl } from "./socket-url";

const ID = "VLWgqcUgToMSkL6PzqxYtnHEUl2sz8xE";

describe("sessionSocketUrl", () => {
  it("connects directly when the app is served from the relay", () => {
    const target = sessionSocketUrl(`https://shell.online/s/${ID}`, "https://shell.online");
    expect(target).toEqual({
      url: `wss://shell.online/api/sessions/${ID}/ws`,
      proxied: false,
    });
  });

  it("goes through the dev proxy when the origins differ", () => {
    /* The relay 403s a foreign Origin, so a direct socket would be refused. */
    const target = sessionSocketUrl(`http://127.0.0.1:8788/s/${ID}`, "http://localhost:5173");
    expect(target).toEqual({
      url: `ws://localhost:5173/relay/api/sessions/${ID}/ws`,
      proxied: true,
    });
  });

  it("follows the app's scheme, not the relay's", () => {
    /* A ws:// socket from an https:// page is blocked as mixed content. */
    const target = sessionSocketUrl(`http://127.0.0.1:8788/s/${ID}`, "https://app.example.com");
    expect(target?.url.startsWith("wss://app.example.com/relay/")).toBe(true);
  });

  it("keeps a non-default port on a same-origin connection", () => {
    const target = sessionSocketUrl(`http://127.0.0.1:8788/s/${ID}`, "http://127.0.0.1:8788");
    expect(target).toEqual({ url: `ws://127.0.0.1:8788/api/sessions/${ID}/ws`, proxied: false });
  });

  it("ignores the encryption fragment when building the socket URL", () => {
    const target = sessionSocketUrl(
      `https://shell.online/s/${ID}#salt=i6AaAzfYyklCDqgMRgEIDw`,
      "https://shell.online",
    );
    expect(target?.url).toBe(`wss://shell.online/api/sessions/${ID}/ws`);
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
      expect(sessionSocketUrl(bad, "https://shell.online")).toBeNull();
    }
  });

  it("refuses a malformed app origin", () => {
    expect(sessionSocketUrl(`https://shell.online/s/${ID}`, "nonsense")).toBeNull();
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
