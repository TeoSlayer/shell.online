import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  campaignMedium,
  campaignSource,
  publicSource,
} from "../shared/public-attribution";
import { gtagConfig, isPublicAnalyticsUrl } from "../web/analytics";
import {
  AGENT_BRANDS,
  PLATFORM_BRANDS,
  agentCommand,
  agentPicker,
} from "../web/landing-brands";
import { landingMarkup } from "../web/landing-markup";
import { existsSync, readFileSync } from "node:fs";

describe("public attribution boundaries", () => {
  it("keeps X attribution while dropping raw labels and click identifiers", () => {
    const url = new URL(
      "https://shell.online/?utm_source=x&utm_medium=cpc&utm_campaign=PRIVATE_MARKER&utm_content=PRIVATE_MARKER&twclid=PRIVATE_MARKER#start",
    );
    expect(isPublicAnalyticsUrl(url)).toBe(true);
    const config = gtagConfig(url);
    expect(config.campaign_source).toBe("x");
    expect(config.campaign_medium).toBe("cpc");
    expect(config.page_location).toBe("https://shell.online/");
    expect(JSON.stringify(config)).not.toContain("PRIVATE_MARKER");
  });
  it("recognizes X's short-link referrer and click marker without storing either URL", () => {
    expect(
      publicSource(
        new URL("https://shell.online/"),
        "https://t.co/PRIVATE_MARKER",
      ),
    ).toBe("x");
    expect(
      campaignSource(new URL("https://shell.online/?twclid=PRIVATE_MARKER")),
    ).toBe("x");
    expect(
      campaignMedium(new URL("https://shell.online/?twclid=PRIVATE_MARKER")),
    ).toBe("paid_social");
  });
  it("does not turn arbitrary source values or prototype properties into dimensions", () => {
    for (const source of [
      "constructor",
      "__proto__",
      "x@secret",
      "PRIVATE_MARKER",
    ]) {
      const url = new URL(`https://shell.online/?utm_source=${source}`);
      expect(campaignSource(url)).toBeNull();
      expect(gtagConfig(url).campaign_source).toBe("(direct)");
    }
  });
  it("never enables GA for private routes, credentials, unknown params, or secret fragments", () => {
    for (const suffix of [
      "/s/abcdefghijklmnopqrstuvwxyz012345?utm_source=x",
      "/?password=secret",
      "/?utm_source=x#salt=secret",
      "/?audit=test",
    ]) {
      expect(
        isPublicAnalyticsUrl(new URL(`https://shell.online${suffix}`)),
      ).toBe(false);
    }
    expect(
      isPublicAnalyticsUrl(new URL("https://secret:secret@shell.online/")),
    ).toBe(false);
  });
});

describe("public event delivery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", {
      location: {
        href: "https://shell.online/?utm_source=x&utm_medium=cpc#start",
      },
    });
    vi.stubGlobal("document", {
      cookie: "",
      referrer: "https://t.co/PRIVATE_MARKER",
      createElement: () => ({}),
      head: { appendChild: vi.fn() },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it("reports one loaded event and one action per call to both destinations, without raw URL fields", async () => {
    const { initAnalytics, trackPublicEvent } = await import(
      "../web/analytics"
    );
    initAnalytics();
    initAnalytics();
    trackPublicEvent("copy", "install");
    trackPublicEvent("cta_click", "start_hero");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(5);
    const events = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === "/api/events").map(([, options]) => JSON.parse(String(options?.body)));
    expect(events).toEqual([
      { event: "page_loaded", target: "landing", source: "x" },
      { event: "copy", target: "install", source: "x" },
      { event: "cta_click", target: "start_hero", source: "x" },
    ]);
    const commands = (
      window as unknown as { dataLayer: IArguments[] }
    ).dataLayer.map((a) => Array.from(a));
    expect(commands.filter((a) => a[0] === "event").map((a) => a[1])).toEqual([
      "page_view",
      "command_copy",
      "landing_cta",
    ]);
    expect(JSON.stringify(commands)).not.toContain("PRIVATE_MARKER");
    const posthog = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://us.i.posthog.com/"));
    expect(posthog.map(([, options]) => JSON.parse(String(options?.body)).event)).toEqual(["command_copy", "landing_cta"]);
    expect(JSON.stringify(posthog)).not.toContain("PRIVATE_MARKER");
    trackPublicEvent("copy", "PRIVATE_MARKER");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("honors opt-out for both marketing event destinations", async () => {
    Object.defineProperty(document, "cookie", {
      value: "shell_analytics_consent=declined",
    });
    const { initAnalytics, trackPublicEvent } = await import(
      "../web/analytics"
    );
    initAnalytics();
    trackPublicEvent("copy", "install");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("landing content and brand assets", () => {
  it("gives every agent a real launch choice, including multi-word terminal commands", () => {
    const picker = agentPicker();
    const ids = AGENT_BRANDS.map(([, , command]) => command.split(" ")[0]);
    expect(new Set(ids).size).toBe(AGENT_BRANDS.length);
    for (const [, , command] of AGENT_BRANDS) {
      const id = command.split(" ")[0];
      expect(agentCommand(id)).toBe(`shell ${command}`);
      expect(picker).toContain(`data-agent="${id}"`);
      expect(picker).toContain(`<code>shell ${command}</code>`);
    }
    expect(agentCommand("muse")).toBe("shell muse");
    expect(agentCommand("cursor-agent")).toBe("shell cursor-agent");
    expect(agentCommand("goose")).toBe("shell goose session");
    expect(agentCommand("openclaw")).toBe("shell openclaw tui");
    expect(agentCommand("unknown")).toBeNull();
  });
  it("keeps custom commands local text and rejects missing or multiline values", () => {
    expect(agentCommand("other", "npm run dev")).toBe("shell npm run dev");
    expect(agentCommand("other", 'my-agent --model "remote model"')).toBe(
      'shell my-agent --model "remote model"',
    );
    for (const invalid of [
      "",
      "   ",
      "a".repeat(201),
      "codex\nwhoami",
      "\tcmd",
      "x\u0000",
    ]) {
      expect(agentCommand("other", invalid)).toBeNull();
    }
    expect(agentCommand("constructor")).toBeNull();
  });
  it("has exactly one target per CTA and no fabricated required account step", () => {
    const markup = landingMarkup();
    expect(markup).toContain("No account needed to try it.");
    for (const target of [
      "start_nav",
      "start_hero",
      "start_footer",
      "signup_team",
      "demo",
      "github_star",
    ]) {
      expect(markup.split(`data-cta="${target}"`)).toHaveLength(2);
    }
    expect(markup).not.toMatch(/<[^>]*data-cta=[^>]*data-cta=/);
    expect(markup.indexOf('class="setup-love"')).toBeGreaterThan(markup.indexOf("Keep your computer awake"));
    expect(markup).toContain('rel="noopener noreferrer" data-cta="github_star"');
  });
  it("ships all displayed brand assets locally and covers every published host OS", () => {
    for (const [, file] of [...AGENT_BRANDS, ...PLATFORM_BRANDS]) {
      expect(
        existsSync(new URL(`../public/brands/${file}`, import.meta.url)),
      ).toBe(true);
    }
    const targets = readFileSync(
      new URL("../scripts/release-targets.tsv", import.meta.url),
      "utf8",
    );
    const systems = new Set(
      targets
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split("\t")[1]),
    );
    expect(systems.size).toBe(PLATFORM_BRANDS.length);
    expect(AGENT_BRANDS.some(([name]) => name === "Muse Code")).toBe(true);
  });
});
