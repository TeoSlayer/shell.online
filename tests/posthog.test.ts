import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posthogPayload, sendPosthog, POSTHOG_ORIGIN } from "../shared/posthog";
import { analyticsRoute, analyticsSource, analyticsSessionId, observeProductPage, resetProductIdentity, trackAppAction, trackProduct, measureAuthentication, beginProductOperation, measureProductOperation, beginApiRequest } from "../web/posthog";

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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("PostHog explicit capture boundary", () => {
  it("captures actual feature attempts and one completion without inspecting work inputs or outputs", async () => {
    const value = { password: SECRET, output: SECRET };
    await expect(measureProductOperation("vault_unlock_password", async () => value)).resolves.toBe(value);
    expect(requests.map(r => r.data.event)).toEqual(["feature_attempt", "feature_result"]);
    expect(requests.at(-1)!.data.properties).toMatchObject({ operation: "vault_unlock_password", outcome: "ok" });
    expect(JSON.stringify(requests)).not.toContain(SECRET);
    const end = beginProductOperation("file_download"); end("cancelled"); end("ok");
    expect(requests.filter(r => r.data.properties.operation === "file_download").map(r => r.data.event)).toEqual(["feature_attempt", "feature_result"]);
    expect(requests.at(-1)!.data.properties.outcome).toBe("cancelled");
  });
  it("preserves exceptions, distinguishes aborts, and refuses arbitrary feature names", async () => {
    const failure = new Error(SECRET);
    await expect(measureProductOperation("vault_unlock_passkey", async () => { throw failure; })).rejects.toBe(failure);
    await expect(measureProductOperation("file_preview", async () => { throw new DOMException(SECRET, "AbortError"); })).rejects.toThrow(SECRET);
    expect(requests.filter(r => r.data.event === "feature_result").map(r => r.data.properties.outcome)).toEqual(["failed", "cancelled"]);
    const count = requests.length; beginProductOperation(SECRET)("ok");
    expect(requests).toHaveLength(count);
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });
  it("attributes pending operations to their starting route, but never the next account", () => {
    win.location.href = "https://app.shell.online/account";
    const end = beginProductOperation("vault_lock");
    win.location.href = "https://app.shell.online/team";
    end("ok");
    expect(requests.at(-1)!.data.properties.route).toBe("account");
    const pending = beginProductOperation("vault_unlock_password");
    resetProductIdentity(); const count = requests.length; pending("ok");
    expect(requests).toHaveLength(count);
  });
  it("measures reads and writes separately from user actions and honors opt-out mid-operation", () => {
    beginApiRequest(`/api/sessions/${SECRET}/content?token=${SECRET}`, "GET")("denied");
    expect(requests.at(-1)!.data).toMatchObject({ event: "api_request", properties: { operation: "session_content_read", method: "GET", outcome: "denied" } });
    const end = beginProductOperation("file_download"); const count = requests.length;
    vi.stubGlobal("navigator", { globalPrivacyControl: true }); end("ok");
    expect(requests).toHaveLength(count);
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });
  it("uses UUIDv7 sessions acceptable to PostHog, with capture timestamps in the session window", () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 100 }, () => analyticsSessionId(now)));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(now);
    }
    observeProductPage()();
    for (const { data } of requests) {
      const started = Number.parseInt(data.properties.$session_id.replaceAll("-", "").slice(0, 12), 16);
      expect(data.properties.$session_id[14]).toBe("7");
      expect(Date.parse(data.timestamp)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(data.timestamp)).toBeLessThan(started + 86_400_000);
    }
  });
  it("migrates old UUIDv4 session cookies without discarding the anonymous visitor", () => {
    cookies.set("__Host-shell_ph", `${ID}.${ID}.${Date.now()}`);
    trackProduct("landing_cta", { target: "start_hero" });
    expect(requests[0].data.distinct_id).toBe(ID);
    expect(requests[0].data.properties.$session_id).not.toBe(ID);
    expect(requests[0].data.properties.$session_id[14]).toBe("7");
  });
  it("rotates at the 24-hour maximum even with recent activity, including a surviving page observer", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const oldSession = analyticsSessionId(now - 86_400_000 + 1000);
    cookies.set("__Host-shell_ph", `${ID}.${oldSession}.${now}`);
    const end = observeProductPage();
    expect(requests[0].data.properties.$session_id).toBe(oldSession);
    vi.setSystemTime(now + 2000);
    end();
    const last = requests.at(-1)!.data;
    expect(last.distinct_id).toBe(ID);
    expect(last.properties.$session_id).not.toBe(oldSession);
    expect(last.properties.$session_id[14]).toBe("7");
  });
  it.each([CHROME, SAFARI, X_BROWSER, HEADLESS, "Googlebot/2.1 (+http://www.google.com/bot.html)"])("preserves browser user-agent metadata without rewriting bot tokens: %s", (userAgent) => {
    vi.stubGlobal("navigator", { userAgent, webdriver: false });
    trackProduct("landing_cta", { target: "start_hero", $user_agent: SECRET, capture_source: "server", instrumentation_version: 999 });
    const end = observeProductPage(); end();
    expect(requests.map(r => r.data.event).filter(e => e !== "page_engagement")).toEqual(["landing_cta", "$pageview", "$pageleave"]);
    for (const request of requests) expect(request.data.properties).toMatchObject({
      $user_agent: userAgent, user_agent_status: "present", capture_source: "browser",
      instrumentation_version: 3, browser_automation: false,
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
    expect(p).toMatchObject({ capture_source: "browser", instrumentation_version: 3, user_agent_status: "missing" });
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
    expect(payload?.properties).toMatchObject({ capture_source: "server", instrumentation_version: 3 });
    for (const key of ["$user_agent", "$raw_user_agent", "user_agent_status", "browser_automation"]) expect(payload?.properties).not.toHaveProperty(key);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });
  it("retains only known installer/platform and rejection categories on aggregate server events", () => {
    for (const target of ["posix", "powershell", "darwin-arm64", "linux-amd64", "session_full", "persistent_cli"]) {
      expect(posthogPayload("installer_download", ID, { surface: "relay", target })?.properties.target).toBe(target);
    }
    expect(posthogPayload("binary_download", ID, { target: `linux-${SECRET}` })?.properties.target).toBeUndefined();
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
    expect(requests.map(r => r.data.event)).toEqual(["$pageview", "page_engagement", "$pageleave"]);
    expect(requests[1].data.properties).toMatchObject({ active_ms: 2000, engagement_reason: "hidden", route: "landing", source: "x" });
    expect(requests[2].data.properties).toMatchObject({ active_ms: 2000, $prev_pageview_duration: 60, $prev_pageview_id: requests[0].data.properties.$pageview_id });
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
  it("uses native campaign/device properties and finite documentation paths, never raw UTM text", () => {
    win.location.href = `https://shell.online/docs/v0.23.0/agents/?utm_source=newsletter&utm_medium=email&utm_campaign=${SECRET}`;
    observeProductPage()();
    expect(requests[0].data.properties).toMatchObject({ guide: "agents", $pathname: "/agents", utm_source: "newsletter", utm_medium: "email", $referring_domain: "x.com", $browser: "Chrome", $os: "Mac OS X", $device_type: "Desktop" });
    expect(JSON.stringify(requests)).not.toContain(SECRET);
    expect(analyticsSource(new URL("https://shell.online/?utm_source=producthunt"), "")).toBe("product_hunt");
  });
  it("flushes foreground deltas on mobile hiding without duplicate pageviews or double-counted totals", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const end = observeProductPage();
    vi.mocked(performance.now).mockReturnValue(2000);
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
    vi.mocked(performance.now).mockReturnValue(62000);
    doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
    vi.mocked(performance.now).mockReturnValue(65000);
    end(); end();
    expect(requests.filter(r => r.data.event === "$pageview")).toHaveLength(1);
    expect(requests.filter(r => r.data.event === "page_engagement").map(r => r.data.properties.active_ms)).toEqual([2000, 3000]);
    expect(requests.find(r => r.data.event === "$pageleave")?.data.properties.active_ms).toBe(5000);
    expect(requests.some(r => r.data.event === "page_engaged")).toBe(false);
  });
  it("counts the 10-second milestone once, only after actual foreground time", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const end = observeProductPage();
    vi.mocked(performance.now).mockReturnValue(5000);
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_000);
    expect(requests.some(r => r.data.event === "page_engaged")).toBe(false);
    vi.mocked(performance.now).mockReturnValue(65000);
    doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
    vi.mocked(performance.now).mockReturnValue(70000); vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(60_000); end();
    expect(requests.filter(r => r.data.event === "page_engaged")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("restores tracking from bfcache exactly once per restore and disposes every listener", () => {
    const end = observeProductPage();
    const show = () => win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    for (let i = 0; i < 3; i++) { win.dispatchEvent(new Event("pagehide")); show(); }
    expect(requests.filter(r => r.data.event === "$pageview")).toHaveLength(4);
    expect(new Set(requests.filter(r => r.data.event === "$pageview").map(r => r.data.properties.$pageview_id)).size).toBe(4);
    end(); show();
    expect(requests.filter(r => r.data.event === "$pageview")).toHaveLength(4);
  });
  it("reports real authentication resolution without arguments, user objects, or thrown error contents", async () => {
    win.location.href = "https://app.shell.online/signup";
    const value = { email: SECRET, uid: SECRET };
    await expect(measureAuthentication("sign_up", "email", async () => value)).resolves.toBe(value);
    const error = new Error(SECRET);
    await expect(measureAuthentication("provider_sign_in", "google", async () => { throw error; })).rejects.toBe(error);
    expect(requests.map(r => [r.data.event, r.data.properties.outcome])).toEqual([
      ["auth_attempt", undefined], ["auth_result", "ok"], ["auth_attempt", undefined], ["auth_result", "failed"],
    ]);
    expect(requests.some(r => r.data.event === "account_created")).toBe(false);
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });
  it("classifies actual app device, command, invite, and failure routes without interpreting request contents", () => {
    win.location.href = "https://app.shell.online/sessions";
    trackAppAction(`/api/devices/${SECRET}`, "DELETE", true);
    trackAppAction("/api/commands", "POST", true);
    trackAppAction(`/api/org/invites/${SECRET}`, "DELETE", false, "http");
    expect(requests.map(r => r.data.properties.action)).toEqual(["machine_remove", "command_requested", "invite_remove"]);
    expect(requests[2].data.properties.failure).toBe("http");
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });
});
