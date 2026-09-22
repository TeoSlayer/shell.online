import { describe, expect, it } from "vitest";
import { browserSecurityHeaders } from "./browser-headers";

function policy(issuer?: string): string {
  return browserSecurityHeaders(issuer)["Content-Security-Policy"] ?? "";
}

describe("the browser security policy", () => {
  it("lets the browser reach the configured provider", () => {
    const csp = policy("https://auth.example.test/realms/shell");
    /* Discovery, JWKS and the token endpoint are ordinary fetches. */
    expect(csp.split("; ").find(rule => rule.startsWith("connect-src "))?.split(" ")).toContain("https://auth.example.test");
    /* The authorization request is a navigation away from this origin. */
    expect(csp).toContain("form-action 'self' https://auth.example.test");
    /* Silent renewal navigates a hidden iframe to the provider first. */
    expect(csp).toContain("frame-src 'self' https://auth.example.test");
  });

  it("names the origin only, never the realm path", () => {
    expect(policy("https://auth.example.test/realms/shell")).not.toContain("/realms/shell");
  });

  it("allows PostHog ingestion but never remote scripts, frames or replay", () => {
    for (const csp of [policy(), policy("https://auth.example.test")]) {
      const rules = csp.split("; ").filter(rule => rule.includes("posthog"));
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatch(/^connect-src /);
      expect(rules[0]).toContain("https://us.i.posthog.com");
      expect(csp).not.toContain("unsafe-eval");
    }
  });

  it("allows this origin to frame itself for OIDC silent renew", () => {
    expect(policy("https://auth.example.test")).toContain("frame-ancestors 'self'");
    expect(policy("https://auth.example.test")).toContain("frame-src 'self'");
  });

  it("preserves Firebase popup, iframe and token access when OIDC is absent", () => {
    expect(policy()).toContain("https://identitytoolkit.googleapis.com");
    expect(policy()).toContain("frame-src https://*.firebaseapp.com");
    expect(browserSecurityHeaders()["X-Frame-Options"]).toBe("DENY");
    expect(policy("not a url")).toBe(policy());
  });
});
