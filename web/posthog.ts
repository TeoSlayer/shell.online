import { resolveDocumentationRoute } from "../shared/documentation";
import { RELEASE_VERSION } from "../shared/release";
import { sendPosthog, type PosthogCaptureContext } from "../shared/posthog";
import { campaignMedium, campaignSource, classifyReferrer, publicSource } from "../shared/public-attribution";
import { apiOperation, OPERATION_NAMES, type OperationOutcome } from "../shared/analytics-operations";

const COOKIE = "__Host-shell_ph";
const COOKIE_VALUE = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.(\d{13})$/;
let identity: { id: string; session: string; time: number } | undefined;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** PostHog's session aggregation requires a timestamp-bearing UUIDv7. */
export function analyticsSessionId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = now;
  for (let i = 5; i >= 0; i--) { bytes[i] = timestamp % 256; timestamp = Math.floor(timestamp / 256); }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function analyticsSource(url: URL, referrer: string): string {
  return publicSource(url, referrer);
}

export function analyticsRoute(url: URL): { surface: string; route: string; guide?: string } | null {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (url.hostname === "shell.online") {
    if (/^\/s\/[A-Za-z0-9_-]{32}\/?$/.test(url.pathname)) return { surface: "terminal", route: "terminal" };
    if (url.pathname === "/") return { surface: "landing", route: "landing" };
    const guide = resolveDocumentationRoute(url.pathname, RELEASE_VERSION);
    if (guide) return { surface: "docs", route: "docs", guide: guide.kind };
  }
  if (url.hostname === "app.shell.online") {
    const path = url.pathname.replace(/\/$/, "");
    if (/^\/sessions\/[^/]+$/.test(path)) return { surface: "app", route: "session" };
    if (/^\/join\/[^/]+$/.test(path)) return { surface: "app", route: "join" };
    if (path === "/cli/authorize") return { surface: "app", route: "cli_authorize" };
    if (["login", "signup", "reset", "feedback", "account", "sessions", "audit", "team", "terms", "privacy", "machines", "game"].includes(path.slice(1))) {
      return { surface: path === "/game" ? "game" : "app", route: path.slice(1) };
    }
  }
  return null; // Includes OAuth callbacks, statistics, localhost and unknown/self-hosted sites.
}

function permitted(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    return !nav.globalPrivacyControl && nav.doNotTrack !== "1" &&
      !document.cookie.split(";").some(c => /^(shell_analytics_consent=declined|shell_analytics_opt_out=1)$/.test(c.trim()));
  } catch { return false; }
}

function browserIdentity() {
  const now = Date.now();
  try {
    const value = document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const match = value?.match(COOKIE_VALUE);
    if (match) identity = { id: match[1], session: match[2], time: Number(match[3]) };
  } catch { /* Memory fallback, never localStorage. */ }
  identity ??= { id: crypto.randomUUID(), session: analyticsSessionId(now), time: now };
  const started = Number.parseInt(identity.session.replaceAll("-", "").slice(0, 12), 16);
  if (!UUID_V7.test(identity.session) || now - identity.time >= 30 * 60_000 || now < identity.time ||
      now < started || now - started >= 24 * 60 * 60_000) identity.session = analyticsSessionId(now);
  identity.time = now;
  try { document.cookie = `${COOKIE}=${identity.id}.${identity.session}.${now}; Path=/; Secure; SameSite=Lax`; } catch { /* Memory only. */ }
  return identity;
}

export function resetProductIdentity(): void {
  identity = undefined;
  try { document.cookie = `${COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`; } catch { /* no storage */ }
}

function browserContext(): PosthogCaptureContext {
  let userAgent: unknown, automated: unknown;
  // Browser privacy tools may make either property unavailable. Keep the event
  // unknown instead of losing it or pretending that absence proves automation.
  try { userAgent = navigator.userAgent; } catch { /* unavailable */ }
  try { automated = navigator.webdriver; } catch { /* unavailable */ }
  return { source: "browser", userAgent, automated };
}

function attribution(url: URL): Record<string, unknown> {
  // UTM values and referrers are classified locally; no raw campaigns, click IDs,
  // paths or account/query/fragment data go to the provider.
  return { source: publicSource(url, document.referrer), campaign_source: campaignSource(url),
    medium: campaignMedium(url), referrer_source: classifyReferrer(document.referrer, url.origin) };
}

export function trackProduct(event: string, input: Record<string, unknown> = {}): void {
  try {
    const url = new URL(window.location.href);
    const route = analyticsRoute(url);
    if (!route || !permitted()) return;
    const { id, session } = browserIdentity();
    void sendPosthog(event, id, { ...attribution(url), ...input, ...route, session_id: session }, browserContext());
  } catch { /* Includes unavailable browser globals in server-side tests. */ }
}

/** One result per attempt; telemetry must not observe arguments/results or change the operation.
 * Capture the starting route and anonymous identity. A completion after logout is discarded,
 * not attributed to the next account. No product operation IDs or Shell session IDs are transmitted.
 */
export function beginProductOperation(operation: string, event: "feature_result" | "api_request" = "feature_result", method?: string): (outcome: OperationOutcome) => void {
  if (!OPERATION_NAMES.has(operation)) return () => {};
  const started = performance.now();
  let finished = false;
  let emit = (_name: string, _input: Record<string, unknown>) => {};
  try {
    const url = new URL(window.location.href), route = analyticsRoute(url);
    if (route && permitted()) {
      const { id } = browserIdentity(), acquisition = attribution(url);
      emit = (name, input) => {
        try {
          if (!permitted()) return;
          const current = browserIdentity();
          if (current.id !== id) return;
          void sendPosthog(name, id, { ...acquisition, ...route, operation, method, ...input, session_id: current.session }, browserContext());
        } catch { /* No product impact. */ }
      };
    }
  } catch { /* Non-browser/test environment. */ }
  if (event === "feature_result") emit("feature_attempt", {});
  return (outcome) => {
    if (finished) return;
    finished = true;
    emit(event, { outcome, elapsed_ms: performance.now() - started });
  };
}

export async function measureProductOperation<T>(operation: string, work: () => Promise<T>): Promise<T> {
  const finish = beginProductOperation(operation);
  try {
    const result = await work(); finish("ok"); return result;
  } catch (error) {
    finish(error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed");
    throw error;
  }
}

export function beginApiRequest(path: string, method: string): (outcome: OperationOutcome) => void {
  const operation = apiOperation(path, method);
  return operation ? beginProductOperation(operation, "api_request", method) : () => {};
}

/** One page view per navigation. One real 10s foreground milestone, no polling pings. */
export function observeProductPage(): () => void {
  try {
    let end = observePage();
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) { end(); end = observePage(); }
    };
    window.addEventListener("pageshow", restore);
    return () => { window.removeEventListener("pageshow", restore); end(); };
  } catch { return () => {}; }
}

function observePage(): () => void {
  const url = new URL(window.location.href);
  const route = analyticsRoute(url);
  if (!route || !permitted()) return () => {};
  const { id } = browserIdentity();
  const pageview = crypto.randomUUID();
  const acquisition = attribution(url);
  const started = performance.now();
  const emit = (event: string, input: Record<string, unknown> = {}) => {
    if (!permitted()) return;
    const current = browserIdentity();
    // Never stitch a surviving observer to a different signed-in identity. Long-
    // lived tabs still rotate idle/24-hour sessions before their next event.
    if (current.id === id) void sendPosthog(event, id, { ...acquisition, ...input, ...route, session_id: current.session, pageview_id: pageview }, browserContext());
  };
  emit("$pageview");
  let active = 0, since = document.visibilityState === "visible" && document.hasFocus() ? performance.now() : null;
  let ended = false, reported = 0, engaged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    if (!ended && !engaged && since !== null) timer = setTimeout(account, Math.max(1, 10_000 - active));
  };
  const flush = (reason: "hidden" | "navigation") => {
    const delta = Math.round(active) - reported;
    if (delta > 0) { emit("page_engagement", { active_ms: delta, engagement_reason: reason }); reported += delta; }
  };
  const account = () => {
    if (ended) return;
    const now = performance.now();
    if (since !== null) active += Math.max(0, now - since);
    since = document.visibilityState === "visible" && document.hasFocus() ? now : null;
    if (active >= 10_000 && !engaged) { engaged = true; emit("page_engaged"); }
    if (document.visibilityState === "hidden") flush("hidden");
    schedule();
  };
  const finish = () => {
    if (ended) return;
    account(); ended = true;
    clearTimeout(timer);
    flush("navigation");
    emit("$pageleave", { active_ms: active, previous_pageview_id: pageview, duration_seconds: (performance.now() - started) / 1000 });
    document.removeEventListener("visibilitychange", account);
    window.removeEventListener("focus", account);
    window.removeEventListener("blur", account);
    window.removeEventListener("pagehide", finish);
  };
  document.addEventListener("visibilitychange", account);
  window.addEventListener("focus", account);
  window.addEventListener("blur", account);
  window.addEventListener("pagehide", finish);
  schedule();
  return finish;
}

/** Finite classification for successful/failed mutations, not API URLs, bodies or errors. */
export function trackAppAction(path: string, method: string, ok: boolean, failure?: "network" | "response" | "http" | "signed_out"): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
  const pathname = path.split("?")[0];
  const target = /^\/api\/sessions\/[^/]+\/automation$/.test(pathname) ? "automation" :
    /^\/api\/sessions(?:\/|$)/.test(pathname) ? "session" :
    /^\/api\/(?:machines|devices)(?:\/|$)/.test(pathname) ? "machine" :
    /^\/api\/vault(?:\/|$)/.test(pathname) ? "vault" :
    /^\/api\/org\/invites(?:\/|$)/.test(pathname) ? "invite" :
    /^\/api\/org(?:\/|$)/.test(pathname) ? "team" :
    pathname === "/api/feedback" ? "feedback" : pathname === "/api/account" ? "account" :
    pathname === "/api/cli/authorize" ? "cli" : pathname === "/api/commands" ? "command" : null;
  const action = target === "automation" ? "automation_update" : target === "cli" ? "cli_authorize" :
    target === "command" ? "command_requested" : target === "feedback" ? "feedback_submit" :
    target === "account" ? "account_remove" : target === "vault" ? "vault_update" : target === "team" ? "team_update" :
    target === "invite" ? (method === "DELETE" ? "invite_remove" : "invite_create") :
    target === "machine" ? (method === "DELETE" ? "machine_remove" : "machine_update") :
    target === "session" ? (method === "DELETE" ? "session_remove" : /\/(?:share|access|assignee)$/.test(pathname) ? "session_access" : "session_update") : undefined;
  if (target) trackProduct("app_action", { target, action, method, outcome: ok ? "ok" : "failed", failure: ok ? undefined : failure });
}

/** Call-through measurement: no arguments, results or thrown error contents captured. */
export async function measureAuthentication<T>(
  action: "sign_in" | "sign_up" | "provider_sign_in" | "password_reset", provider: "email" | "google" | "oidc", work: () => Promise<T>,
): Promise<T> {
  trackProduct("auth_attempt", { action, provider });
  try {
    const result = await work();
    trackProduct("auth_result", { action, provider, outcome: "ok" });
    return result;
  } catch (error) {
    trackProduct("auth_result", { action, provider, outcome: "failed" });
    throw error;
  }
}
