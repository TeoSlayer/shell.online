import { resolveDocumentationRoute } from "../shared/documentation";
import { RELEASE_VERSION } from "../shared/release";
import { sendPosthog } from "../shared/posthog";

const COOKIE = "__Host-shell_ph";
const COOKIE_VALUE = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.(\d{13})$/;
let identity: { id: string; session: string; time: number } | undefined;

export function analyticsSource(url: URL, referrer: string): string {
  const source = url.searchParams.get("utm_source")?.toLowerCase();
  if (source && ["x", "twitter", "google", "github", "reddit", "linkedin", "youtube"].includes(source)) return source === "twitter" ? "x" : source;
  if (url.searchParams.has("twclid")) return "x";
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname;
    if (host === url.hostname) return "internal";
    for (const [domain, bucket] of [["t.co", "x"], ["x.com", "x"], ["twitter.com", "x"], ["google.com", "google"], ["github.com", "github"], ["reddit.com", "reddit"]]) {
      if (host === domain || host.endsWith(`.${domain}`)) return bucket;
    }
  } catch { /* Never preserve malformed referrers. */ }
  return "other";
}

export function analyticsRoute(url: URL): { surface: string; route: string } | null {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (url.hostname === "shell.online") {
    if (/^\/s\/[A-Za-z0-9_-]{32}\/?$/.test(url.pathname)) return { surface: "terminal", route: "terminal" };
    if (url.pathname === "/") return { surface: "landing", route: "landing" };
    if (resolveDocumentationRoute(url.pathname, RELEASE_VERSION)) return { surface: "docs", route: "docs" };
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
  identity ??= { id: crypto.randomUUID(), session: crypto.randomUUID(), time: now };
  if (now - identity.time > 30 * 60_000 || now < identity.time) identity.session = crypto.randomUUID();
  identity.time = now;
  try { document.cookie = `${COOKIE}=${identity.id}.${identity.session}.${now}; Path=/; Secure; SameSite=Lax`; } catch { /* Memory only. */ }
  return identity;
}

export function resetProductIdentity(): void {
  identity = undefined;
  try { document.cookie = `${COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`; } catch { /* no storage */ }
}

export function trackProduct(event: string, input: Record<string, unknown> = {}): void {
  try {
    const url = new URL(window.location.href);
    const route = analyticsRoute(url);
    if (!route || !permitted()) return;
    const { id, session } = browserIdentity();
    void sendPosthog(event, id, { source: route.surface === "landing" || route.surface === "docs" ? analyticsSource(url, document.referrer) : undefined, ...input, ...route, session_id: session });
  } catch { /* Includes unavailable browser globals in server-side tests. */ }
}

/** One page view per navigation, paired with actual foreground time; never timer pings. */
export function observeProductPage(): () => void {
  try { return observePage(); } catch { return () => {}; }
}

function observePage(): () => void {
  const url = new URL(window.location.href);
  const route = analyticsRoute(url);
  if (!route || !permitted()) return () => {};
  const { id, session } = browserIdentity();
  const emit = (event: string, input: Record<string, unknown> = {}) => {
    if (permitted()) void sendPosthog(event, id, { source: route.surface === "landing" || route.surface === "docs" ? analyticsSource(url, document.referrer) : undefined, ...input, ...route, session_id: session });
  };
  emit("$pageview");
  let active = 0, since = document.visibilityState === "visible" && document.hasFocus() ? performance.now() : null;
  let ended = false;
  const account = () => {
    const now = performance.now();
    if (since !== null) active += now - since;
    since = document.visibilityState === "visible" && document.hasFocus() ? now : null;
  };
  const finish = () => {
    if (ended) return;
    account(); ended = true;
    emit("$pageleave", { active_ms: active });
    document.removeEventListener("visibilitychange", account);
    window.removeEventListener("focus", account);
    window.removeEventListener("blur", account);
    window.removeEventListener("pagehide", finish);
  };
  document.addEventListener("visibilitychange", account);
  window.addEventListener("focus", account);
  window.addEventListener("blur", account);
  window.addEventListener("pagehide", finish);
  return finish;
}

/** Finite classification for successful/failed mutations, not API URLs, bodies or errors. */
export function trackAppAction(path: string, method: string, ok: boolean): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
  const pathname = path.split("?")[0];
  const target = /^\/api\/sessions\/[^/]+\/automation$/.test(pathname) ? "automation" :
    /^\/api\/sessions(?:\/|$)/.test(pathname) ? "session" :
    /^\/api\/machines(?:\/|$)/.test(pathname) ? "machine" :
    /^\/api\/vault(?:\/|$)/.test(pathname) ? "vault" :
    /^\/api\/org\/invites(?:\/|$)/.test(pathname) ? "invite" :
    /^\/api\/org(?:\/|$)/.test(pathname) ? "team" :
    pathname === "/api/feedback" ? "feedback" : pathname === "/api/account" ? "account" :
    pathname === "/api/cli/authorize" ? "cli" : null;
  if (target) trackProduct("app_action", { target, method, outcome: ok ? "ok" : "failed" });
}
