import { resolveDocumentationRoute } from "../shared/documentation";
import { RELEASE_VERSION } from "../shared/release";

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
  if (url.search !== "") return false;
  if (url.hash !== "") return false;
  return isPublicPath(url.pathname);
}

export function isGpcOrDnt(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return true;
  if (navigator.doNotTrack === "1") return true;
  return false;
}

function hasLegacyDecline(cookieString?: string): boolean {
  const source = cookieString ?? document.cookie;
  for (const part of source.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== LEGACY_CONSENT_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value === "declined";
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
  if (pathname === "/" || pathname === "") return "Share a Live Terminal in Any Browser | shell.online";
  if (resolveDocumentationRoute(pathname, RELEASE_VERSION)) return "Documentation | shell.online";
  return "shell.online";
}

export function gtagConfig(url: URL): Record<string, unknown> {
  return {
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

type GtagFn = (...args: unknown[]) => void;

export function initAnalytics(): void {
  if (gtagLoaded) return;
  const url = new URL(window.location.href);
  if (!isPublicAnalyticsUrl(url)) return;
  if (isGpcOrDnt()) return;
  if (hasGaDisableFlag()) return;
  try {
    if (hasLegacyDecline()) return;
  } catch {
    return;
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
