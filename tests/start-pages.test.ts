import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPage, pageFromPayload, payloadFromFlags, requestedPage, START_PAGES_FLAG } from "../web/start-pages";
import { POSTHOG_ORIGIN, POSTHOG_TOKEN, posthogPayload } from "../shared/posthog";

const payload = {
  pages: {
    pocket: { headline: "Your coding agent, in your pocket.", subline: "Free. No account needed.", agent: "codex", send: "Send to my laptop" },
    partial: { headline: "Just a headline." },
  },
};
const flags = (body: unknown, enabled = true) => ({ flags: { [START_PAGES_FLAG]: { key: START_PAGES_FLAG, enabled, metadata: { payload: body } } } });

afterEach(() => vi.unstubAllGlobals());

describe("which /start/ page an ad asked for", () => {
  it("reads a short page key from utm_content", () => {
    expect(requestedPage(new URL("https://shell.online/start/?utm_source=x&utm_content=Pocket"))).toBe("pocket");
    expect(requestedPage(new URL("https://shell.online/start/?utm_content=v2_codex-a"))).toBe("v2_codex-a");
  });
  it.each(["", "a b", "<script>", "x".repeat(33), "-leading", "caf%C3%A9"])("ignores %j", (value) => {
    expect(requestedPage(new URL(`https://shell.online/start/?utm_content=${value}`))).toBe("");
  });
  it("asks for nothing without utm_content", () => {
    expect(requestedPage(new URL("https://shell.online/start/"))).toBe("");
  });
});

describe("a page from the flag payload", () => {
  it("takes every valid field, and turns the agent into its shell command", () => {
    expect(pageFromPayload(payload, "pocket")).toEqual({
      headline: "Your coding agent, in your pocket.", subline: "Free. No account needed.", run: "shell codex", send: "Send to my laptop",
    });
  });
  it("accepts the payload as PostHog's JSON string", () => {
    expect(pageFromPayload(JSON.stringify(payload), "partial")).toEqual({ headline: "Just a headline." });
  });
  it("returns nothing for an unknown page, a bad key or a broken payload", () => {
    expect(pageFromPayload(payload, "missing")).toBeNull();
    expect(pageFromPayload(payload, "__proto__")).toBeNull();
    expect(pageFromPayload(payload, "")).toBeNull();
    expect(pageFromPayload("{not json", "pocket")).toBeNull();
    expect(pageFromPayload({ pages: [] }, "pocket")).toBeNull();
    expect(pageFromPayload(null, "pocket")).toBeNull();
  });
  it("drops fields that are too long, empty, the wrong type, or an unknown agent", () => {
    const page = pageFromPayload({ pages: { odd: { headline: "x".repeat(121), subline: "  ", send: 42, agent: "rm -rf /" } } }, "odd");
    expect(page).toEqual({});
  });
});

describe("reading the flag", () => {
  it("finds the payload only when the flag is on", () => {
    expect(payloadFromFlags(flags("{}"))).toBe("{}");
    expect(payloadFromFlags(flags("{}", false))).toBeNull();
    expect(payloadFromFlags({ flags: {} })).toBeNull();
    expect(payloadFromFlags("nonsense")).toBeNull();
  });

  it("asks PostHog with the public token and a throwaway id, never cookies", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(flags(JSON.stringify(payload)))));
    vi.stubGlobal("fetch", fetcher);
    expect(await loadPage("pocket")).toMatchObject({ headline: "Your coding agent, in your pocket." });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${POSTHOG_ORIGIN}/flags/?v=2`);
    expect(init.credentials).toBe("omit");
    const body = JSON.parse(String(init.body));
    expect(body.api_key).toBe(POSTHOG_TOKEN);
    expect(body.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
    await loadPage("pocket");
    const second = JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(second.distinct_id).not.toBe(body.distinct_id);
  });

  it("falls back to the default page when PostHog is slow, blocked or unhappy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("blocked"); }));
    expect(await loadPage("pocket")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await loadPage("pocket")).toBeNull();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await loadPage("")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("the page each event reports", () => {
  it("records a page key and nothing that looks like free text", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(posthogPayload("$pageview", id, { landing_variant: "pocket" })?.properties.landing_variant).toBe("pocket");
    expect(posthogPayload("$pageview", id, { landing_variant: "default" })?.properties.landing_variant).toBe("default");
    for (const bad of ["Pocket Page", "<b>", "x".repeat(33), 7]) {
      expect(posthogPayload("$pageview", id, { landing_variant: bad })?.properties).not.toHaveProperty("landing_variant");
    }
  });
});
