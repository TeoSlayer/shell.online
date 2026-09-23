import { DOCUMENTATION_KINDS } from "./documentation.js";

/** Public ingestion token, not an administration/personal API key. */
export const POSTHOG_TOKEN = "phc_Ct3RkLeqa674ydnWuzAwQBu5X9tXW2v7mJ3cvKKzp4hv";
export const POSTHOG_ORIGIN = "https://us.i.posthog.com";

const EVENTS = new Set([
  "$pageview", "$pageleave", "command_copy", "landing_cta", "terminal_connected",
  "report_opened", "app_action", "signed_in", "signed_out",
  "installer_download", "install_outcome", "binary_download", "skill_download",
  "session_created", "session_started", "session_ended", "viewer_connected",
  "viewer_disconnected", "viewer_rejected", "collaboration_started", "input_denied",
  "page_engaged", "page_engagement", "auth_attempt", "auth_result", "account_created",
]);
const VALUES: Record<string, ReadonlySet<string>> = {
  surface: new Set(["landing", "docs", "terminal", "app", "game", "relay"]),
  route: new Set(["landing", "docs", "terminal", "login", "signup", "reset", "feedback", "account", "sessions", "session", "audit", "team", "join", "terms", "privacy", "machines", "game", "cli_authorize"]),
  target: new Set(["install", "brew_install", "source_build", "run", "docs_command", "share", "skill", "start_nav", "start_hero", "start_footer", "start_bottom", "demo", "github_star", "signup_nav", "signup_hero", "signup_team", "signup_footer", "github", "signup", "signin", "docs", "app", "feedback", "session", "machine", "team", "vault", "automation", "account", "command", "invite", "cli", "unknown"]),
  source: new Set(["x", "google", "github", "reddit", "hacker_news", "bing", "youtube", "linkedin", "facebook", "instagram", "direct", "internal", "other", "app", "newsletter", "product_hunt", "discord", "slack", "mastodon", "bluesky", "podcast"]),
  device: new Set(["mobile", "tablet", "desktop", "bot", "cli", "unknown"]),
  outcome: new Set(["ok", "failed", "denied", "unsupported_os", "unsupported_arch", "download_failed", "checksum_mismatch", "unknown"]),
  method: new Set(["POST", "PUT", "PATCH", "DELETE"]),
  guide: new Set(DOCUMENTATION_KINDS),
  medium: new Set(["cpc", "paid_social", "social", "email", "referral", "organic"]),
  provider: new Set(["email", "google", "oidc"]),
  action: new Set(["sign_in", "sign_up", "provider_sign_in", "command_requested", "session_update", "session_remove", "session_access", "machine_update", "machine_remove", "vault_update", "invite_create", "invite_remove", "team_update", "feedback_submit", "account_remove", "cli_authorize", "automation_update"]),
  failure: new Set(["network", "response", "http", "signed_out"]),
  engagement_reason: new Set(["hidden", "navigation"]),
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERRERS: Record<string, string> = {
  x: "x.com", google: "google.com", github: "github.com", reddit: "reddit.com",
  hacker_news: "news.ycombinator.com", bing: "bing.com", youtube: "youtube.com",
  linkedin: "linkedin.com", facebook: "facebook.com", instagram: "instagram.com",
  product_hunt: "producthunt.com", app: "app.shell.online", internal: "shell.online",
};

/** Browser metadata is supplied by the transport, never by event properties. */
export type PosthogCaptureContext =
  | { source: "browser"; userAgent: unknown; automated: unknown }
  | { source: "server" };

/** Construct, never spread: even a malicious caller cannot attach arbitrary content. */
export function posthogPayload(event: string, id: string, input: Record<string, unknown> = {}, context: PosthogCaptureContext = { source: "server" }) {
  if (!EVENTS.has(event) || !UUID.test(id)) return null;
  const properties: Record<string, string | number | boolean> = {
    $process_person_profile: false, $geoip_disable: true, $ip: "", $lib: "shell-online",
    instrumentation_version: 3, capture_source: context.source,
  };
  if (context.source === "browser") {
    const ua = context.userAgent;
    // Preserve real browser/bot tokens for PostHog's classifier. Never substitute
    // a human-looking UA or truncate an oversized string into a different identity.
    if (ua === undefined || (typeof ua === "string" && !ua.trim())) {
      properties.user_agent_status = "missing";
    } else if (typeof ua === "string" && ua.length <= 1024 && /^[\x20-\x7e]+$/.test(ua)) {
      properties.$user_agent = ua.trim();
      properties.user_agent_status = "present";
      // Finite families only: the capture API does not run the JS SDK's info parser.
      properties.$browser = /Edg\//.test(ua) ? "Microsoft Edge" : /OPR\//.test(ua) ? "Opera" :
        /SamsungBrowser\//.test(ua) ? "Samsung Internet" : /(?:Firefox|FxiOS)\//.test(ua) ? "Firefox" :
        /(?:Chrome|CriOS)\//.test(ua) ? "Chrome" : /Version\/.+Safari\//.test(ua) ? "Safari" : "Unknown";
      properties.$os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" :
        /Windows/.test(ua) ? "Windows" : /Macintosh/.test(ua) ? "Mac OS X" : /Linux/.test(ua) ? "Linux" : "Unknown";
      properties.$device_type = /iPad|Tablet|Android(?!.*Mobile)/.test(ua) ? "Tablet" :
        /Mobile|iPhone|iPod/.test(ua) ? "Mobile" : /Windows|Macintosh|Linux|CrOS/.test(ua) ? "Desktop" : "Unknown";
    } else {
      properties.user_agent_status = "invalid";
    }
    if (typeof context.automated === "boolean") properties.browser_automation = context.automated;
  }
  for (const [key, allowed] of Object.entries(VALUES)) {
    if (typeof input[key] === "string" && allowed.has(input[key] as string)) properties[key] = input[key] as string;
  }
  if (typeof input.active_ms === "number" && Number.isFinite(input.active_ms)) {
    properties.active_ms = Math.max(0, Math.min(86_400_000, Math.round(input.active_ms)));
  }
  if (typeof input.session_id === "string" && UUID.test(input.session_id)) properties.$session_id = input.session_id;
  for (const [from, to] of [["pageview_id", "$pageview_id"], ["previous_pageview_id", "$prev_pageview_id"]]) {
    if (typeof input[from] === "string" && UUID.test(input[from])) properties[to] = input[from];
  }
  if (typeof input.duration_seconds === "number" && Number.isFinite(input.duration_seconds)) {
    properties.$prev_pageview_duration = Math.max(0, Math.min(86_400, input.duration_seconds));
  }
  if (typeof input.campaign_source === "string" && VALUES.source.has(input.campaign_source) &&
      !["direct", "internal", "app", "other"].includes(input.campaign_source)) properties.utm_source = input.campaign_source;
  if (properties.medium) properties.utm_medium = properties.medium;
  if (typeof input.referrer_source === "string" && Object.hasOwn(REFERRERS, input.referrer_source)) {
    properties.$referring_domain = REFERRERS[input.referrer_source];
    properties.$referrer = `https://${REFERRERS[input.referrer_source]}/`;
  }
  // Relay targets are fixed lifecycle/platform categories, never commands or IDs.
  if (context.source === "server" && typeof input.target === "string" &&
      (/^(darwin|windows|linux|freebsd|openbsd|netbsd|dragonfly|solaris)-(amd64|arm64|386|arm|armv[567]|ppc64le|ppc64|riscv64|s390x|mips|mipsle|mips64|mips64le|loong64)$/.test(input.target) ||
       ["posix", "powershell", "persistent_cli", "viewer", "remote_input", "read_only", "not_found", "expired", "session_full", "task_exit", "persistent_task_exit", "host_disconnect", "host_timeout"].includes(input.target))) properties.target = input.target;
  if (input.referrer_source === "direct") properties.$referring_domain = "$direct";
  if (properties.route) {
    // Templates only. Never location.href, document.title, referrer or a real session ID.
    const host = properties.surface === "app" || properties.surface === "game" ? "app.shell.online" : "shell.online";
    const path = properties.route === "landing" ? "/" : properties.route === "terminal" ? "/s/:session" : properties.route === "session" ? "/sessions/:session" :
      properties.route === "join" ? "/join/:invite" : properties.route === "cli_authorize" ? "/cli/authorize" :
      properties.route === "docs" && properties.guide ? (properties.guide === "docs" ? "/docs" : `/docs/${properties.guide}`) : `/${properties.route}`;
    properties.$current_url = `https://${host}${path}`;
    properties.$pathname = path;
    properties.$host = host;
    if (properties.$prev_pageview_id) properties.$prev_pageview_pathname = path;
  }
  return { api_key: POSTHOG_TOKEN, event, distinct_id: id, timestamp: new Date().toISOString(), properties };
}

/** Non-blocking callers own waitUntil. No retries, logs, request headers or IP forwarding. */
export async function sendPosthog(event: string, id: string, input: Record<string, unknown> = {}, context: PosthogCaptureContext = { source: "server" }): Promise<void> {
  const payload = posthogPayload(event, id, input, context);
  if (!payload) return;
  try {
    await fetch(`${POSTHOG_ORIGIN}/i/v0/e/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), credentials: "omit", referrerPolicy: "no-referrer",
      keepalive: true, signal: AbortSignal.timeout(3000),
    });
  } catch { /* Analytics must never change product behavior. */ }
}
