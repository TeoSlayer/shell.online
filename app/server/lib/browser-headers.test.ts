import { describe, expect, it } from "vitest";
import { browserSecurityHeaders } from "./browser-headers";

function policy(issuer?: string): string {
  return browserSecurityHeaders(issuer)["Content-Security-Policy"] ?? "";
}

describe("the browser security policy", () => {
  it("lets the browser reach the configured provider", () => {
    const csp = policy("https://auth.example.test/realms/shell");
    /* Discovery, JWKS and the token endpoint are ordinary fetches. */
    expect(csp).toContain("connect-src 'self' wss: https://auth.example.test");
    /* The authorization request is a navigation away from this origin. */
    expect(csp).toContain("form-action 'self' https://auth.example.test");
  });

  it("names the origin only, never the realm path", () => {
    expect(policy("https://auth.example.test/realms/shell")).not.toContain("/realms/shell");
  });

  it("allows this origin to frame itself, for the silent renew", () => {
    expect(policy()).toContain("frame-ancestors 'self'");
    expect(policy()).toContain("frame-src 'self'");
  });

  it("allows nothing extra when no provider is configured", () => {
    expect(policy()).toContain("connect-src 'self' wss:;");
    expect(policy()).toContain("form-action 'self'");
    expect(policy("not a url")).toBe(policy());
  });
});
