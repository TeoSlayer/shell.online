import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(_state: unknown, _env: unknown) {}
    blockConcurrencyWhile(_fn: () => Promise<unknown>) { return _fn(); }
  },
  DurableObjectState: class {},
}));

const { secureAssetResponse } = await import("../worker/index");

function htmlResponse(): Response {
  return new Response("<html></html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function csp(response: Response): string {
  return response.headers.get("Content-Security-Policy") ?? "";
}

describe("secureAssetResponse CSP Google Analytics endpoints", () => {
  it("allows exact X SDK/collector origins only on public HTML", () => {
    const policy = csp(secureAssetResponse(htmlResponse(), "/", "shell.online"));
    expect(policy.split("; ").find(s => s.startsWith("script-src"))).toContain("https://static.ads-twitter.com");
    for (const directive of ["img-src", "connect-src"]) {
      const sources = policy.split("; ").find(s => s.startsWith(directive));
      for (const host of ["analytics.twitter.com", "t.co", "ads-twitter.com", "ads-api.twitter.com"]) expect(sources).toContain(`https://${host}`);
    }
    for (const [path, host] of [["/docs/", "shell.online"], ["/cli/", "shell.online"], ["/s/abcdefghijklmnopqrstuvwxyz012345", "shell.online"], ["/", "app.shell.online"], ["/", "stats.shell.online"], ["/oauth/callback", "shell.online"]]) {
      const privatePolicy = csp(secureAssetResponse(htmlResponse(), path, host));
      expect(privatePolicy).not.toMatch(/twitter|t\.co|ads-twitter/);
    }
  });
  it("allows GA on public landing page (/) HTML on shell.online", () => {
    const res = secureAssetResponse(htmlResponse(), "/", "shell.online");
    const policy = csp(res);
    expect(policy).toContain("script-src 'self' https://www.googletagmanager.com");
    expect(policy).toContain("connect-src 'self' wss: ws: https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com");
    expect(policy).toContain("img-src 'self' data: https://www.google-analytics.com https://region1.google-analytics.com https://analytics.google.com");
  });

  it("allows GA on short documentation route HTML on shell.online", () => {
    const res = secureAssetResponse(htmlResponse(), "/security/", "shell.online");
    const policy = csp(res);
    expect(policy).toContain("script-src 'self' https://www.googletagmanager.com");
  });

  it("allows GA on versioned documentation route HTML on shell.online", () => {
    const res = secureAssetResponse(htmlResponse(), "/docs/v0.22.0/security/", "shell.online");
    const policy = csp(res);
    expect(policy).toContain("script-src 'self' https://www.googletagmanager.com");
  });

  it("does NOT allow GA on /docs/PRIVATE_TOKEN (not a valid kind)", () => {
    const res = secureAssetResponse(htmlResponse(), "/docs/PRIVATE_TOKEN", "shell.online");
    const policy = csp(res);
    expect(policy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  });

  it("does NOT allow GA on private session paths", () => {
    const res = secureAssetResponse(htmlResponse(), "/s/abcdefghijklmnopqrstuvwxyz012345/", "shell.online");
    const policy = csp(res);
    expect(policy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws: https://us.i.posthog.com; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  });

  it("does NOT allow GA on stats hostname", () => {
    const res = secureAssetResponse(htmlResponse(), "/", "stats.shell.online");
    const policy = csp(res);
    expect(policy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  });

  it("does NOT allow GA on app subdomain", () => {
    const res = secureAssetResponse(htmlResponse(), "/", "app.shell.online");
    const policy = csp(res);
    expect(policy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  });

  it("does NOT allow GA on other hosts", () => {
    const res = secureAssetResponse(htmlResponse(), "/", "shell.example.com");
    const policy = csp(res);
    expect(policy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  });

  it("does NOT allow GA on non-HTML responses even on public path", () => {
    const res = secureAssetResponse(jsonResponse(), "/", "shell.online");
    const policy = csp(res);
    expect(policy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  });

  it("does NOT allow GA on unknown paths", () => {
    const res = secureAssetResponse(htmlResponse(), "/game", "shell.online");
    const policy = csp(res);
    expect(policy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  });

  it("preserves existing security headers on public pages", () => {
    const res = secureAssetResponse(htmlResponse(), "/", "shell.online");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    const policy = csp(res);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it("does not add unsafe-inline to script-src or unsafe-eval", () => {
    const res = secureAssetResponse(htmlResponse(), "/", "shell.online");
    const policy = csp(res);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("does not use wildcard hosts", () => {
    const res = secureAssetResponse(htmlResponse(), "/", "shell.online");
    const policy = csp(res);
    expect(policy).not.toContain("*.google");
    expect(policy).not.toContain("https://*");
  });
});
