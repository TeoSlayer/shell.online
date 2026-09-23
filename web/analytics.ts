import { resolveDocumentationRoute } from "../shared/documentation";
import { RELEASE_VERSION } from "../shared/release";
import { campaignMedium, isPublicEvent, publicSource } from "../shared/public-attribution";
import { trackProduct } from "./posthog";

const GA_ID = "G-101HMD03VD";
const LEGACY_CONSENT_COOKIE = "shell_analytics_consent";
const GA_COOKIE_PREFIX = "shell_public_ga";
const GA_COOKIE_MAX_AGE = 7_776_000; // 90 days
const PUBLIC_HOST = "shell.online";

function isPublicPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  return resolveDocumentationRoute(pathname, RELEASE_VERSION) !== null;
}

export function isPublicAnalyticsUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.hostname !== PUBLIC_HOST) return false;
  if (url.port !== "") return false;
  if (url.username || url.password) return false;
  const allowed = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id", "ref", "twclid"]);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) return false;
  // Only known navigation anchors. A credential-like fragment never enables GA.
  const docAnchor = resolveDocumentationRoute(url.pathname, RELEASE_VERSION) !== null &&
    (url.hash === "#guide-content" || /^#section-(?:[1-9]|[1-5]\d|6[0-4])$/.test(url.hash));
  if (url.hash && !docAnchor && !["#start", "#choose-agent", "#see-it", "#how", "#agents", "#use-cases", "#benefits", "#specs", "#faq"].includes(url.hash)) return false;
  return isPublicPath(url.pathname);
}

export function isGpcOrDnt(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return true;
  if (navigator.doNotTrack === "1") return true;
  return false;
}

export function hasAnalyticsOptOut(cookieString?: string): boolean {
  const source = cookieString ?? document.cookie;
  for (const part of source.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if ((name === LEGACY_CONSENT_COOKIE && value === "declined") ||
        (name === "shell_analytics_opt_out" && value === "1")) return true;
  }
  return false;
}

function hasGaDisableFlag(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return w[`ga-disable-${GA_ID}`] === true;
}

function canonicalPageLocation(url: URL): string {
  return `https://${PUBLIC_HOST}${url.pathname === "" ? "/" : url.pathname}`;
}

function pageTitleFor(pathname: string): string {
  if (pathname === "/" || pathname === "") return "Your terminal, anywhere | shell.online";
  const guide = resolveDocumentationRoute(pathname, RELEASE_VERSION);
  if (guide) return `${guide.kind === "docs" ? "Getting started" : guide.kind} | shell.online docs`;
  return "shell.online";
}

export function gtagConfig(url: URL): Record<string, unknown> {
  const source = publicSource(url, typeof document === "undefined" ? null : document.referrer);
  const medium = campaignMedium(url);
  return {
    campaign_source: source === "direct" || source === "internal" ? "(direct)" : source,
    campaign_medium: medium ?? (source === "direct" || source === "internal" ? "(none)" : "referral"),
    // Suppress automatic extraction of arbitrary UTM labels from the browser URL.
    campaign_name: "(not set)", campaign_id: "", campaign_content: "", campaign_term: "",
    cookie_domain: "none",
    cookie_prefix: GA_COOKIE_PREFIX,
    cookie_expires: GA_COOKIE_MAX_AGE,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    ignore_referrer: true,
    send_page_view: false,
    page_location: canonicalPageLocation(url),
    page_referrer: "",
    page_title: pageTitleFor(url.pathname),
  };
}

let gtagLoaded = false;
let publicLoaded = false;

type GtagFn = (...args: unknown[]) => void;

export function initAnalytics(): void {
  if (gtagLoaded) return;
  const url = new URL(window.location.href);
  if (!isPublicAnalyticsUrl(url)) return;
  if (isGpcOrDnt()) return;
  if (hasGaDisableFlag()) return;
  try {
    if (hasAnalyticsOptOut()) return;
  } catch {
    return;
  }

  if (!publicLoaded) {
    publicLoaded = true;
    sendPublicEvent("page_loaded", url.pathname === "/" ? "landing" : "docs", url);
  }

  gtagLoaded = true;

  const w = window as unknown as Record<string, unknown>;
  const dataLayer = (w.dataLayer ??= []) as unknown[];

  const gtag: GtagFn = function gtag() {
    dataLayer.push(arguments);
  };
  w.gtag = gtag;

  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  gtag("js", new Date());
  gtag("config", GA_ID, gtagConfig(url));
  gtag("event", "page_view");

  const script = document.createElement("script");
  script.async = true;
  script.referrerPolicy = "no-referrer";
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
}

function sendPublicEvent(event: string, target: string, url: URL): void {
  const source = publicSource(url, document.referrer);
  void fetch("/api/events", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, target, source }), credentials: "same-origin", keepalive: true,
  }).catch(() => {});
}

export function trackPublicEvent(event: string, target: string): void {
  const url = new URL(window.location.href);
  if (!isPublicAnalyticsUrl(url) || !isPublicEvent(event, target) || isGpcOrDnt() || hasGaDisableFlag()) return;
  try { if (hasAnalyticsOptOut()) return; } catch { return; }
  sendPublicEvent(event, target, url);
  trackProduct(event === "copy" ? "command_copy" : "landing_cta", { target, source: publicSource(url, document.referrer) });
  if (gtagLoaded) {
    const gtag = (window as unknown as { gtag: GtagFn }).gtag;
    gtag("event", event === "copy" ? "command_copy" : "landing_cta", { target, ...gtagConfig(url) });
  }
}
