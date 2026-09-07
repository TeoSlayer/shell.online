import { describe, expect, it } from "vitest";
import { buildCallback, parseAuthorizeRequest } from "./cli-authorize";

const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function search(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    redirect_uri: "http://127.0.0.1:51234/callback",
    state: "st_abc",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== null) params.set(key, value);
  }
  return `?${params.toString()}`;
}

describe("parseAuthorizeRequest", () => {
  it("accepts a well-formed loopback request", () => {
    const result = parseAuthorizeRequest(search());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.state).toBe("st_abc");
      expect(result.request.port).toBe("51234");
      expect(result.request.codeChallenge).toBe(challenge);
    }
  });

  it("accepts localhost and IPv6 loopback", () => {
    expect(parseAuthorizeRequest(search({ redirect_uri: "http://localhost:8080/callback" })).ok).toBe(true);
    expect(parseAuthorizeRequest(search({ redirect_uri: "http://[::1]:8080/callback" })).ok).toBe(true);
  });

  it("refuses a callback that points off this machine", () => {
    const result = parseAuthorizeRequest(
      search({ redirect_uri: "http://attacker.example.com:8080/callback" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      /* The person needs to understand why, not just that it failed. */
      expect(result.reason).toContain("other than a terminal on this computer");
    }
  });

  it("refuses a host that merely looks like loopback", () => {
    expect(
      parseAuthorizeRequest(search({ redirect_uri: "http://127.0.0.1.evil.com:8080/callback" })).ok,
    ).toBe(false);
  });

  it("refuses an https or non-http callback", () => {
    expect(parseAuthorizeRequest(search({ redirect_uri: "https://127.0.0.1:8080/callback" })).ok).toBe(false);
    expect(parseAuthorizeRequest(search({ redirect_uri: "javascript:alert(1)" })).ok).toBe(false);
  });

  it("refuses a missing parameter", () => {
    expect(parseAuthorizeRequest(search({ state: null })).ok).toBe(false);
    expect(parseAuthorizeRequest(search({ redirect_uri: null })).ok).toBe(false);
    expect(parseAuthorizeRequest(search({ code_challenge: null })).ok).toBe(false);
  });

  it("refuses a plain challenge method", () => {
    expect(parseAuthorizeRequest(search({ code_challenge_method: "plain" })).ok).toBe(false);
  });

  it("refuses a malformed challenge", () => {
    expect(parseAuthorizeRequest(search({ code_challenge: "short" })).ok).toBe(false);
    expect(parseAuthorizeRequest(search({ code_challenge: `${challenge}+` })).ok).toBe(false);
  });

  it("refuses a callback with the wrong path or no port", () => {
    expect(parseAuthorizeRequest(search({ redirect_uri: "http://127.0.0.1:8080/steal" })).ok).toBe(false);
    expect(parseAuthorizeRequest(search({ redirect_uri: "http://127.0.0.1/callback" })).ok).toBe(false);
  });

  it("refuses an empty query without throwing", () => {
    expect(parseAuthorizeRequest("").ok).toBe(false);
  });
});

describe("buildCallback", () => {
  it("adds parameters to the loopback callback", () => {
    const url = new URL(
      buildCallback("http://127.0.0.1:51234/callback", { code: "shc_a", state: "st_abc" }),
    );
    expect(url.origin).toBe("http://127.0.0.1:51234");
    expect(url.searchParams.get("code")).toBe("shc_a");
    expect(url.searchParams.get("state")).toBe("st_abc");
  });

  it("escapes values rather than concatenating", () => {
    const url = new URL(
      buildCallback("http://127.0.0.1:51234/callback", {
        error: "access_denied",
        error_description: "You declined the request.",
      }),
    );
    expect(url.searchParams.get("error_description")).toBe("You declined the request.");
  });
});
