/** Public ingestion token, not an administration/personal API key. */
export const POSTHOG_TOKEN = "phc_Ct3RkLeqa674ydnWuzAwQBu5X9tXW2v7mJ3cvKKzp4hv";
export const POSTHOG_ORIGIN = "https://us.i.posthog.com";

const EVENTS = new Set([
  "$pageview", "$pageleave", "command_copy", "landing_cta", "terminal_connected",
  "report_opened", "app_action", "signed_in", "signed_out",
  "installer_download", "install_outcome", "binary_download", "skill_download",
  "session_created", "session_started", "session_ended", "viewer_connected",
  "viewer_disconnected", "viewer_rejected", "collaboration_started", "input_denied",
]);
const VALUES: Record<string, ReadonlySet<string>> = {
  surface: new Set(["landing", "docs", "terminal", "app", "game", "relay"]),
  route: new Set(["landing", "docs", "terminal", "login", "signup", "reset", "feedback", "account", "sessions", "session", "audit", "team", "join", "terms", "privacy", "machines", "game", "cli_authorize"]),
  target: new Set(["install", "brew_install", "source_build", "run", "docs_command", "share", "skill", "start_nav", "start_hero", "start_footer", "start_bottom", "demo", "github_star", "signup_nav", "signup_hero", "signup_team", "signup_footer", "github", "signup", "signin", "docs", "app", "feedback", "session", "machine", "team", "vault", "automation", "account", "command", "invite", "cli", "unknown"]),
  source: new Set(["x", "google", "github", "reddit", "hacker_news", "bing", "youtube", "linkedin", "facebook", "instagram", "direct", "internal", "other", "app", "newsletter", "product_hunt", "discord", "slack", "mastodon", "bluesky", "podcast"]),
  device: new Set(["mobile", "tablet", "desktop", "bot", "cli", "unknown"]),
  outcome: new Set(["ok", "failed", "denied", "unsupported_os", "unsupported_arch", "download_failed", "checksum_mismatch", "unknown"]),
  method: new Set(["POST", "PUT", "PATCH", "DELETE"]),
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Browser metadata is supplied by the transport, never by event properties. */
export type PosthogCaptureContext =
  | { source: "browser"; userAgent: unknown; automated: unknown }
  | { source: "server" };

/** Construct, never spread: even a malicious caller cannot attach arbitrary content. */
export function posthogPayload(event: string, id: string, input: Record<string, unknown> = {}, context: PosthogCaptureContext = { source: "server" }) {
  if (!EVENTS.has(event) || !UUID.test(id)) return null;
  const properties: Record<string, string | number | boolean> = {
    $process_person_profile: false, $geoip_disable: true, $ip: "", $lib: "shell-online",
    instrumentation_version: 2, capture_source: context.source,
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
  if (properties.route) {
    // Templates only. Never location.href, document.title, referrer or a real session ID.
    const host = properties.surface === "app" || properties.surface === "game" ? "app.shell.online" : "shell.online";
    const path = properties.route === "landing" ? "/" : properties.route === "terminal" ? "/s/:session" : properties.route === "session" ? "/sessions/:session" : `/${properties.route}`;
    properties.$current_url = `https://${host}${path}`;
    properties.$pathname = path;
    properties.$host = host;
  }
  return { api_key: POSTHOG_TOKEN, event, distinct_id: id, properties };
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
