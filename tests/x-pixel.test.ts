import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

let scripts: Record<string, unknown>[];
function dom(href = "https://shell.online/", cookie = "") {
  scripts = [];
  const w = { location: { href }, twq: undefined as undefined | { queue: IArguments[] } };
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", { cookie, createElement: () => ({}), head: { appendChild: (s: Record<string, unknown>) => scripts.push(s) } });
  vi.stubGlobal("navigator", { doNotTrack: "0" });
  return w;
}
beforeEach(() => { vi.resetModules(); dom(); });
afterEach(() => vi.unstubAllGlobals());

describe("X base pixel", () => {
  it("configures one visit with privacy switches before config, no fabricated conversion", async () => {
    const w = dom();
    const { initXPixel } = await import("../web/x-pixel");
    initXPixel(); initXPixel();
    expect(scripts).toEqual([{ async: true, referrerPolicy: "no-referrer", src: "https://static.ads-twitter.com/uwt.js" }]);
    expect(w.twq?.queue.map(q => Array.from(q))).toEqual([
      ["set", { page_location: "https://shell.online/" }],
      ...["autoConfig", "autoAdvancedMatching", "dataLayerTracking", "autoDwellTracking"].map(f => ["set", f, "false", "rfilf"]),
      ["config", "rfilf"],
    ]);
  });
  it.each(["/"])("loads on public %s", async path => {
    dom(`https://shell.online${path}?utm_source=x&twclid=valid_click-123`);
    (await import("../web/x-pixel")).initXPixel();
    expect(scripts).toHaveLength(1);
  });
  it.each([
    "https://shell.online/s/abcdefghijklmnopqrstuvwxyz012345#salt=SECRET",
    "https://app.shell.online/", "https://stats.shell.online/", "http://shell.online/",
    "https://shell.online/docs/", "https://shell.online/cli/", "https://shell.online/docs/v0.23.0/security/",
    "http://localhost:5178/", "https://shell.online/oauth/callback", "https://shell.online/?password=SECRET",
    "https://shell.online/#salt=SECRET", "https://shell.online/?twclid=email%40example.test",
    "https://shell.online/?twclid=a&twclid=b", "https://shell.online/?twclid=",
    `https://shell.online/?twclid=${"a".repeat(257)}`,
  ])("never initializes for %s", async url => {
    const w = dom(url);
    (await import("../web/x-pixel")).initXPixel();
    expect(scripts).toHaveLength(0); expect(w.twq).toBeUndefined();
  });
  it.each(["shell_analytics_consent=declined", "shell_analytics_opt_out=1", "shell_analytics_consent=granted; shell_analytics_opt_out=1"])("honors %s", async cookie => {
    dom("https://shell.online/", cookie);
    (await import("../web/x-pixel")).initXPixel(); expect(scripts).toHaveLength(0);
  });
  it.each([{ doNotTrack: "1" }, { globalPrivacyControl: true }])("honors browser privacy %j", async nav => {
    vi.stubGlobal("navigator", nav);
    (await import("../web/x-pixel")).initXPixel(); expect(scripts).toHaveLength(0);
  });
  it("fails closed when cookie access fails", async () => {
    Object.defineProperty(document, "cookie", { get() { throw Error("blocked"); } });
    expect((await import("../web/x-pixel")).initXPixel).not.toThrow(); expect(scripts).toHaveLength(0);
  });
  it("does not replace an existing queue", async () => {
    const w = dom(); w.twq = { queue: [] }; const existing = w.twq;
    (await import("../web/x-pixel")).initXPixel();
    expect(w.twq).toBe(existing); expect(scripts).toHaveLength(0);
  });
  it("is wired only to the landing entry point", () => {
    expect(readFileSync("web/landing.ts", "utf8")).toContain("initXPixel();");
    expect(readFileSync("web/documentation-entry.ts", "utf8")).not.toContain("x-pixel");
    expect(readFileSync("web/main.ts", "utf8")).not.toContain("x-pixel");
    expect(readFileSync("app/src/components/ProductAnalytics.tsx", "utf8")).not.toContain("x-pixel");
  });
});
