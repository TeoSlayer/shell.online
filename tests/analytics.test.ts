import { describe, expect, it, vi } from "vitest";
import {
  binaryDownloadTarget,
  campaignSource,
  classifyClient,
  classifyDevice,
  classifyReferrer,
  documentTarget,
  hasVisitorSalt,
  installReportOutcome,
  isDocumentNavigation,
  machineKey,
  normalizeAnalyticsRecord,
  requestAnalyticsContext,
  requestVisitor,
  uniqueSurface,
  visitorKey,
  writeAnalytics,
} from "../worker/analytics";

describe("analytics", () => {
  it("writes a stable, privacy-limited Analytics Engine schema", () => {
    const writeDataPoint = vi.fn();

    writeAnalytics(
      { writeDataPoint },
      "session_ended",
      "task_exit",
      {
        device: "mobile",
        client: "shell/0.3.4",
        referrer: "hacker_news",
        value: 12.5,
        auxiliary: 3,
      },
    );

    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["session_ended:task_exit"],
      blobs: ["session_ended", "task_exit", "mobile", "shell/0.3.4", "hacker_news"],
      doubles: [1, 12.5, 3],
    });
  });

  it("normalizes the same aggregate record used by the private dashboard", () => {
    expect(normalizeAnalyticsRecord("copy", "Share Link!", {
      device: "desktop",
      client: "Web Browser (raw details removed)",
      referrer: "Hacker News",
      value: Number.NaN,
      auxiliary: 2,
    })).toEqual({
      event: "copy",
      target: "share_link_",
      device: "desktop",
      client: "web_browser__raw_details_removed_",
      referrer: "hacker_news",
      count: 1,
      value: 0,
      auxiliary: 2,
    });
  });

  it("reduces user agents and referrers to coarse categories", () => {
    expect(classifyDevice("shell/0.3.4")).toBe("cli");
    expect(classifyClient("shell/0.3.4")).toBe("shell/0.3.4");
    expect(classifyDevice("Mozilla/5.0 (iPhone; Mobile)")).toBe("mobile");
    expect(classifyDevice("Mozilla/5.0 (iPad) AppleWebKit")).toBe("tablet");
    expect(classifyReferrer("https://news.ycombinator.com/item?id=1", "https://shell.online"))
      .toBe("hacker_news");
    expect(classifyReferrer("https://shell.online/s/example", "https://shell.online"))
      .toBe("internal");
    expect(classifyReferrer("https://example.com/private/path", "https://shell.online"))
      .toBe("other");
    expect(classifyReferrer("https://app.shell.online/sessions", "https://shell.online")).toBe("app");
    expect(classifyReferrer("https://app.example.test/", "https://example.test")).toBe("app");
  });

  it("takes a named campaign over a hidden referrer, and only a named one", () => {
    expect(campaignSource(new URL("https://shell.online/?utm_source=hn&utm_medium=post"))).toBe("hacker_news");
    expect(campaignSource(new URL("https://shell.online/?ref=producthunt"))).toBe("product_hunt");
    expect(campaignSource(new URL("https://shell.online/?utm_source=<script>"))).toBeNull();
    expect(campaignSource(new URL("https://shell.online/?utm_source=my-private-tracker-42"))).toBeNull();
    expect(campaignSource(new URL("https://shell.online/"))).toBeNull();
    const hidden = new Request("https://shell.online/?utm_source=newsletter", { headers: { "User-Agent": "Mozilla/5.0" } });
    expect(requestAnalyticsContext(hidden).referrer).toBe("newsletter");
    const shown = new Request("https://shell.online/?utm_source=newsletter", {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://github.com/TeoSlayer/shell.online" },
    });
    expect(requestAnalyticsContext(shown).referrer).toBe("github");
  });

  it("classifies request context without retaining raw headers", () => {
    const request = new Request("https://shell.online/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; Mobile) secret-build",
        Referer: "https://news.ycombinator.com/item?id=123",
      },
    });

    expect(requestAnalyticsContext(request)).toEqual({
      device: "mobile",
      client: "web",
      referrer: "hacker_news",
    });
  });

  it("recognizes document views and release binaries only", () => {
    expect(isDocumentNavigation(new Request("https://shell.online/", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    }))).toBe(true);
    expect(isDocumentNavigation(new Request("https://shell.online/assets/app.js"))).toBe(false);
    expect(binaryDownloadTarget("/downloads/shell-darwin-arm64")).toBe("darwin-arm64");
    expect(binaryDownloadTarget("/downloads/shell-windows-amd64.exe")).toBe("windows-amd64");
    expect(binaryDownloadTarget("/downloads/shell-linux-armv7")).toBe("linux-armv7");
    expect(binaryDownloadTarget("/downloads/shell-linux-mips64le")).toBe("linux-mips64le");
    expect(binaryDownloadTarget("/downloads/shell-linux-amd64.sha256")).toBeNull();
  });

  it("names every documentation page, and keeps unknown paths apart from 404s", () => {
    expect(documentTarget("/", 200, "0.15.1")).toBe("landing");
    expect(documentTarget("/docs/", 200, "0.15.1")).toBe("docs");
    expect(documentTarget("/app/", 200, "0.15.1")).toBe("docs_app");
    expect(documentTarget("/cli/", 200, "0.15.1")).toBe("docs_cli");
    expect(documentTarget("/refstream/", 200, "0.15.1")).toBe("docs_refstream");
    expect(documentTarget("/self-hosting/", 200, "0.15.1")).toBe("docs_self_hosting");
    expect(documentTarget("/docs/v0.15.1/app/", 200, "0.15.1")).toBe("docs_app");
    expect(documentTarget("/docs/v0.15.1/", 200, "0.15.1")).toBe("docs");
    expect(documentTarget("/s/abcdefghijklmnopqrstuvwxyz012345", 200, "0.15.1")).toBe("session");
    expect(documentTarget("/docs/contributing/", 200, "0.15.1")).toBe("unknown_path");
    expect(documentTarget("/docs/contributing/", 404, "0.15.1")).toBe("not_found");
  });

  it("counts people on the surfaces where a person is behind the event", () => {
    expect(uniqueSurface("page_view", "landing")).toBe("site");
    expect(uniqueSurface("page_view", "docs_app")).toBe("site");
    expect(uniqueSurface("page_view", "session")).toBe("viewer");
    expect(uniqueSurface("page_view", "unknown_path")).toBeNull();
    expect(uniqueSurface("cta_click", "signup_hero")).toBe("site");
    expect(uniqueSurface("binary_download", "darwin-arm64")).toBe("install");
    expect(uniqueSurface("session_created", "cli")).toBe("cli");
    expect(uniqueSurface("viewer_connected", "viewer")).toBe("viewer");
    expect(uniqueSurface("session_ended", "task_exit")).toBeNull();
    expect(uniqueSurface("viewer_disconnected", "viewer")).toBeNull();
  });

  it("hashes a visitor so the address cannot be read back and a browser update is the same person", async () => {
    const salt = "a-salt-long-enough-to-count";
    const one = await visitorKey(salt, "203.0.113.7", "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36");
    expect(one).toMatch(/^[a-f0-9]{20}$/);
    expect(one).not.toContain("203");
    await expect(visitorKey(salt, "203.0.113.7", "Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537.36")).resolves.toBe(one);
    await expect(visitorKey(salt, "203.0.113.8", "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36")).resolves.not.toBe(one);
    await expect(visitorKey("another-salt-of-some-length", "203.0.113.7", "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36")).resolves.not.toBe(one);
  });

  it("counts nobody without a salt worth the name, without an address, or behind a crawler", async () => {
    const request = new Request("https://shell.online/", {
      headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "curl/8.4.0" },
    });
    expect(hasVisitorSalt(undefined)).toBe(false);
    expect(hasVisitorSalt("short")).toBe(false);
    await expect(requestVisitor(undefined, request)).resolves.toBeUndefined();
    await expect(requestVisitor("short", request)).resolves.toBeUndefined();
    await expect(requestVisitor("a-salt-long-enough-to-count", new Request("https://shell.online/"))).resolves.toBeUndefined();
    await expect(requestVisitor("a-salt-long-enough-to-count", request)).resolves.toMatch(/^[a-f0-9]{20}$/);
    const crawler = new Request("https://shell.online/", {
      headers: {
        "CF-Connecting-IP": "203.0.113.9",
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    await expect(requestVisitor("a-salt-long-enough-to-count", crawler)).resolves.toBeUndefined();
  });

  it("takes an install report's outcome only from the list the scripts send", () => {
    expect(installReportOutcome(new URL("https://shell.online/install/report?outcome=ok&platform=shell-darwin-arm64"))).toBe("ok");
    expect(installReportOutcome(new URL("https://shell.online/install/report?outcome=checksum_mismatch"))).toBe("checksum_mismatch");
    expect(installReportOutcome(new URL("https://shell.online/install/report?outcome=rm%20-rf"))).toBeNull();
    expect(installReportOutcome(new URL("https://shell.online/install/report?outcome=OK"))).toBeNull();
    expect(installReportOutcome(new URL("https://shell.online/install/report"))).toBeNull();
  });

  it("keys a machine by address alone, so the installer and the CLI on it are one machine", async () => {
    const salt = "a-salt-long-enough-to-count";
    const installer = new Request("https://shell.online/install", {
      headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "curl/8.4.0" },
    });
    const cli = new Request("https://shell.online/api/sessions", {
      headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "shell/0.15.1" },
    });
    const machine = await requestVisitor(salt, installer, "machine");
    expect(machine).toMatch(/^[a-f0-9]{20}$/);
    await expect(requestVisitor(salt, cli, "machine")).resolves.toBe(machine);
    /* A browser at the same address is not that machine, and its key is not made from the same bytes. */
    await expect(requestVisitor(salt, installer)).resolves.not.toBe(machine);
    await expect(machineKey(salt, "203.0.113.7")).resolves.toBe(machine);
    await expect(machineKey(salt, "203.0.113.8")).resolves.not.toBe(machine);
  });
});
