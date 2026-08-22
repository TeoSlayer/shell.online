import { describe, expect, it, vi } from "vitest";
import {
  binaryDownloadTarget,
  classifyClient,
  classifyDevice,
  classifyReferrer,
  isDocumentNavigation,
  normalizeAnalyticsRecord,
  requestAnalyticsContext,
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
    expect(binaryDownloadTarget("/downloads/shell-linux-amd64.sha256")).toBeNull();
  });
});
