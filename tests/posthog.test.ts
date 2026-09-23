import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posthogPayload, sendPosthog, POSTHOG_ORIGIN } from "../shared/posthog";
import { analyticsRoute, analyticsSource, observeProductPage, resetProductIdentity, trackAppAction, trackProduct } from "../web/posthog";

const ID = "12345678-1234-4123-8123-123456789abc";
const SECRET = "SECRET_PASSWORD_TOKEN_TERMINAL_CONTENT";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const X_BROWSER = `${SAFARI} Twitter for iPhone/10.0`;
const HEADLESS = CHROME.replace("Chrome/", "HeadlessChrome/");
let requests: Array<Record<string, any>>;
let cookies: Map<string, string>;
let doc: EventTarget & { cookie: string; visibilityState: string; hasFocus: () => boolean; referrer: string };
let win: EventTarget & { location: { href: string } };

beforeEach(() => {
  requests = []; cookies = new Map();
  doc = Object.assign(new EventTarget(), { cookie: "", visibilityState: "visible", hasFocus: () => true, referrer: `https://t.co/${SECRET}` });
  Object.defineProperty(doc, "cookie", {
    get: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    set: (raw: string) => { const [k, v] = raw.split(";")[0].split("="); if (raw.includes("Max-Age=0")) cookies.delete(k); else cookies.set(k, v); },
  });
  win = Object.assign(new EventTarget(), { location: { href: `https://shell.online/?utm_source=x&twclid=${SECRET}#${SECRET}` } });
  vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { doNotTrack: "0", globalPrivacyControl: false, userAgent: CHROME, webdriver: false });
  vi.stubGlobal("localStorage", { getItem: () => { throw Error("must not read"); }, setItem: () => { throw Error("must not write"); } });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { requests.push({ url, ...init, data: JSON.parse(init.body) }); return new Response("1"); }));
  resetProductIdentity();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("PostHog explicit capture boundary", () => {
  it.each([CHROME, SAFARI, X_BROWSER, HEADLESS, "Googlebot/2.1 (+http://www.google.com/bot.html)"])("preserves browser user-agent metadata without rewriting bot tokens: %s", (userAgent) => {
    vi.stubGlobal("navigator", { userAgent, webdriver: false });
    trackProduct("landing_cta", { target: "start_hero", $user_agent: SECRET, capture_source: "server", instrumentation_version: 999 });
    const end = observeProductPage(); end();
    expect(requests.map(r => r.data.event)).toEqual(["landing_cta", "$pageview", "$pageleave"]);
    for (const request of requests) expect(request.data.properties).toMatchObject({
      $user_agent: userAgent, user_agent_status: "present", capture_source: "browser",
      instrumentation_version: 2, browser_automation: false,
    });
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });
  it("records explicit browser automation even if its user agent looks ordinary", () => {
    vi.stubGlobal("navigator", { userAgent: CHROME, webdriver: true });
    observeProductPage()();
    expect(requests[0].data.properties).toMatchObject({ $user_agent: CHROME, browser_automation: true });
  });
  it("keeps capture working when browser metadata getters are unavailable", () => {
    const nav = {};
    Object.defineProperties(nav, {
      userAgent: { get() { throw Error("blocked"); } },
      webdriver: { get() { throw Error("blocked"); } },
    });
    vi.stubGlobal("navigator", nav);
    observeProductPage()();
    expect(requests[0].data.properties).toMatchObject({ user_agent_status: "missing", capture_source: "browser" });
    expect(requests[0].data.properties).not.toHaveProperty("browser_automation");
  });
  it.each([undefined, "", "   "])("keeps a missing user agent unknown, rather than inventing a browser: %s", (userAgent) => {
    vi.stubGlobal("navigator", { userAgent });
    observeProductPage()();
    const p = requests[0].data.properties;
    expect(p).toMatchObject({ capture_source: "browser", instrumentation_version: 2, user_agent_status: "missing" });
    expect(p).not.toHaveProperty("$user_agent");
    expect(p).not.toHaveProperty("browser_automation");
  });
  it.each([123, {}, "x".repeat(1025), "Chrome\r\nSECRET", "Chrome\u0000SECRET"])("rejects invalid or unbounded user-agent metadata", (userAgent) => {
    vi.stubGlobal("navigator", { userAgent });
    observeProductPage()();
    expect(requests[0].data.properties).toMatchObject({ user_agent_status: "invalid" });
    expect(requests[0].data.properties).not.toHaveProperty("$user_agent");
  });
  it("distinguishes server milestones without forwarding headers or accepting browser context from event input", () => {
    const payload = posthogPayload("session_created", ID, {
      surface: "relay", capture_source: "browser", instrumentation_version: 999,
      $user_agent: SECRET, $raw_user_agent: SECRET, user_agent_status: "present", browser_automation: false,
    });
    expect(payload?.properties).toMatchObject({ capture_source: "server", instrumentation_version: 2 });
    for (const key of ["$user_agent", "$raw_user_agent", "user_agent_status", "browser_automation"]) expect(payload?.properties).not.toHaveProperty(key);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });
  it("never spreads sensitive properties or arbitrary event/identity strings", () => {
    const payload = posthogPayload("$pageview", ID, { surface: "terminal", route: "terminal", target: SECRET, source: SECRET, url: SECRET, content: SECRET, token: SECRET, $current_url: SECRET, $set: { email: SECRET } });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(payload?.properties.$current_url).toBe("https://shell.online/s/:session");
    expect(payload?.properties.$process_person_profile).toBe(false);
    expect(payload?.properties.$geoip_disable).toBe(true);
    expect(posthogPayload(SECRET, ID)).toBeNull();
    expect(posthogPayload("$pageview", SECRET)).toBeNull();
  });
  it("restricts private routes to templates and disables non-production origins/callbacks", () => {
    for (const url of ["http://shell.online/", "https://evil.shell.online/", "https://stats.shell.online/", "https://app.shell.online/auth/callback?code=SECRET", "https://shell.online:444/", "https://shell.online/unknown"]) expect(analyticsRoute(new URL(url))).toBeNull();
    expect(analyticsRoute(new URL(`https://app.shell.online/sessions/${SECRET}?token=${SECRET}`))).toEqual({ surface: "app", route: "session" });
    expect(analyticsRoute(new URL("https://app.shell.online/game"))).toEqual({ surface: "game", route: "game" });
  });
  it("uses a finite acquisition source, never a raw URL/campaign/click ID", () => {
    expect(analyticsSource(new URL(`https://shell.online/?twclid=${SECRET}`), "")).toBe("x");
    expect(analyticsSource(new URL("https://shell.online/"), `https://x.com.evil.test/${SECRET}`)).toBe("other");
  });
  it("captures foreground time once and keeps the previous route on SPA navigation", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const end = observeProductPage();
    vi.mocked(performance.now).mockReturnValue(2000);
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
    vi.mocked(performance.now).mockReturnValue(60000);
    win.location.href = `https://app.shell.online/sessions/${SECRET}`;
    end(); end(); win.dispatchEvent(new Event("pagehide"));
    expect(requests).toHaveLength(2);
    expect(requests[1].data.properties).toMatchObject({ active_ms: 2000, route: "landing", source: "x" });
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });
  it.each(["dnt", "gpc", "legacy", "optout"])("honors %s before creating identifiers or sending", (mode) => {
    if (mode === "dnt") vi.stubGlobal("navigator", { doNotTrack: "1" });
    if (mode === "gpc") vi.stubGlobal("navigator", { globalPrivacyControl: true });
    if (mode === "legacy") cookies.set("shell_analytics_consent", "declined");
    if (mode === "optout") cookies.set("shell_analytics_opt_out", "1");
    trackProduct("command_copy", { target: "install" }); observeProductPage()();
    expect(requests).toHaveLength(0); expect(cookies.has("__Host-shell_ph")).toBe(false);
  });
  it("keeps anonymous IDs within a visit and resets them across account changes", () => {
    trackProduct("command_copy", { target: "install" }); trackProduct("landing_cta", { target: "start_hero" });
    expect(requests[0].data.distinct_id).toBe(requests[1].data.distinct_id);
    resetProductIdentity(); trackProduct("signed_in");
    expect(requests[2].data.distinct_id).not.toBe(requests[0].data.distinct_id);
  });
  it("records only bounded mutation outcomes, never request paths or errors", () => {
    win.location.href = `https://app.shell.online/sessions/${SECRET}`;
    trackAppAction(`/api/sessions/${SECRET}/automation?key=${SECRET}`, "PATCH", true);
    trackAppAction(`/api/feedback?body=${SECRET}`, "POST", false);
    trackAppAction("/api/sessions", "GET", true);
    expect(requests).toHaveLength(2);
    expect(requests[0].data.properties).toMatchObject({ target: "automation", method: "PATCH", outcome: "ok", route: "session" });
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });
  it("does not forward cookies/referrer and swallows transport failure", async () => {
    await sendPosthog("$pageview", ID);
    expect(requests[0]).toMatchObject({ url: `${POSTHOG_ORIGIN}/i/v0/e/`, credentials: "omit", referrerPolicy: "no-referrer", keepalive: true });
    vi.mocked(fetch).mockRejectedValue(new Error(SECRET));
    await expect(sendPosthog("$pageview", ID)).resolves.toBeUndefined();
  });
});
