import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posthogPayload, sendPosthog, POSTHOG_ORIGIN } from "../shared/posthog";
import { analyticsRoute, analyticsSource, observeProductPage, resetProductIdentity, trackAppAction, trackProduct } from "../web/posthog";

const ID = "12345678-1234-4123-8123-123456789abc";
const SECRET = "SECRET_PASSWORD_TOKEN_TERMINAL_CONTENT";
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
  vi.stubGlobal("navigator", { doNotTrack: "0", globalPrivacyControl: false });
  vi.stubGlobal("localStorage", { getItem: () => { throw Error("must not read"); }, setItem: () => { throw Error("must not write"); } });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { requests.push({ url, ...init, data: JSON.parse(init.body) }); return new Response("1"); }));
  resetProductIdentity();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("PostHog explicit capture boundary", () => {
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
