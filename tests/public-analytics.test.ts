import { describe, expect, it } from "vitest";
import {
  isPublicAnalyticsUrl,
  gtagConfig,
  isGpcOrDnt,
} from "../web/analytics";

describe("isPublicAnalyticsUrl", () => {
  it("accepts https://shell.online/", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/"))).toBe(true);
  });

  it("accepts https://shell.online with no path", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online"))).toBe(true);
  });

  it("accepts short documentation routes", () => {
    for (const kind of ["docs", "app", "cli", "platforms", "mobile", "refstream", "reliability", "security", "e2ee", "docker", "self-hosting"]) {
      expect(isPublicAnalyticsUrl(new URL(`https://shell.online/${kind}/`))).toBe(true);
    }
  });

  it("accepts versioned documentation routes", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/docs/v0.22.0/"))).toBe(true);
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/docs/v0.22.0/security/"))).toBe(true);
  });
  it("accepts only bounded section anchors on actual documentation routes", () => {
    for (const path of ["/docs/#section-1", "/agents/#section-9", "/cli/#guide-content"]) {
      expect(isPublicAnalyticsUrl(new URL(`https://shell.online${path}`))).toBe(true);
    }
    for (const path of ["/#section-1", "/s/private#section-1", "/docs/#section-1&token=private", "/docs/#section-999", "/docs/#salt=private"]) {
      expect(isPublicAnalyticsUrl(new URL(`https://shell.online${path}`))).toBe(false);
    }
  });

  it("rejects /docs/PRIVATE_TOKEN (not a valid kind)", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/docs/PRIVATE_TOKEN"))).toBe(false);
  });

  it("rejects /docs/ with unknown subpage", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/docs/v0.22.0/unknown/"))).toBe(false);
  });

  it("rejects http (not https)", () => {
    expect(isPublicAnalyticsUrl(new URL("http://shell.online/"))).toBe(false);
  });

  it("rejects app.shell.online", () => {
    expect(isPublicAnalyticsUrl(new URL("https://app.shell.online/"))).toBe(false);
  });

  it("rejects stats.shell.online", () => {
    expect(isPublicAnalyticsUrl(new URL("https://stats.shell.online/"))).toBe(false);
  });

  it("rejects localhost", () => {
    expect(isPublicAnalyticsUrl(new URL("https://localhost/"))).toBe(false);
  });

  it("rejects 127.0.0.1", () => {
    expect(isPublicAnalyticsUrl(new URL("https://127.0.0.1/"))).toBe(false);
  });

  it("rejects staging subdomain", () => {
    expect(isPublicAnalyticsUrl(new URL("https://staging.shell.online/"))).toBe(false);
  });

  it("rejects non-standard port", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online:8080/"))).toBe(false);
  });

  it("rejects session routes /s/<id>", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/s/abcdefghijklmnopqrstuvwxyz012345/"))).toBe(false);
  });

  it("rejects /stats path", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/stats"))).toBe(false);
  });

  it("rejects unknown paths", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/game"))).toBe(false);
  });

  it("accepts recognized campaign parameters without passing their raw values onward", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/?ref=google"))).toBe(true);
  });

  it("rejects URLs with secret query params", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/docs/?token=abc123"))).toBe(false);
  });

  it("rejects URLs with fragments", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/#key=abc"))).toBe(false);
  });

  it("rejects URLs with credential-bearing fragments", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.online/docs/#e2ee=secret"))).toBe(false);
  });

  it("rejects self-hosted domain", () => {
    expect(isPublicAnalyticsUrl(new URL("https://shell.example.com/"))).toBe(false);
  });

  it("rejects subdomain of shell.online that is not exact", () => {
    expect(isPublicAnalyticsUrl(new URL("https://www.shell.online/"))).toBe(false);
  });
});

describe("isGpcOrDnt", () => {
  it("returns false when neither is set", () => {
    const origDnt = navigator.doNotTrack;
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "doNotTrack", { value: null, configurable: true });
    expect(isGpcOrDnt()).toBe(false);
    Object.defineProperty(navigator, "doNotTrack", { value: origDnt, configurable: true });
  });

  it("returns true when GPC is set", () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    expect(isGpcOrDnt()).toBe(true);
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true });
  });

  it("returns true when DNT is '1'", () => {
    const origDnt = navigator.doNotTrack;
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    expect(isGpcOrDnt()).toBe(true);
    Object.defineProperty(navigator, "doNotTrack", { value: origDnt, configurable: true });
  });
});

describe("gtagConfig", () => {
  const url = new URL("https://shell.online/");

  it("sets cookie_domain to string 'none'", () => {
    expect(gtagConfig(url).cookie_domain).toBe("none");
  });

  it("uses prefixed cookies with 90-day expiry", () => {
    expect(gtagConfig(url).cookie_prefix).toBe("shell_public_ga");
    expect(gtagConfig(url).cookie_expires).toBe(7_776_000);
  });

  it("denies google signals", () => {
    expect(gtagConfig(url).allow_google_signals).toBe(false);
  });

  it("denies ad personalization", () => {
    expect(gtagConfig(url).allow_ad_personalization_signals).toBe(false);
  });

  it("sets ignore_referrer to true", () => {
    expect(gtagConfig(url).ignore_referrer).toBe(true);
  });

  it("sets send_page_view to false (explicit page_view sent separately)", () => {
    expect(gtagConfig(url).send_page_view).toBe(false);
  });

  it("uses blank page_referrer", () => {
    expect(gtagConfig(url).page_referrer).toBe("");
  });

  it("uses fixed public page title for landing", () => {
    expect(gtagConfig(url).page_title).toBe("Your terminal, anywhere | shell.online");
  });

  it("uses fixed public page title for docs", () => {
    const docsUrl = new URL("https://shell.online/security/");
    expect(gtagConfig(docsUrl).page_title).toBe("security | shell.online docs");
  });

  it("uses canonical page_location for landing", () => {
    expect(gtagConfig(url).page_location).toBe("https://shell.online/");
  });

  it("uses canonical page_location for docs", () => {
    const docsUrl = new URL("https://shell.online/security/");
    expect(gtagConfig(docsUrl).page_location).toBe("https://shell.online/security/");
  });

  it("does not include dynamic session fields", () => {
    const config = gtagConfig(url);
    const keys = Object.keys(config);
    expect(keys).not.toContain("session_id");
    expect(keys).not.toContain("user_id");
    expect(keys).not.toContain("search");
    expect(keys).not.toContain("terminal");
  });
});
