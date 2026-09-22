import { resolveDocumentationRoute } from "../shared/documentation";
import { RELEASE_VERSION } from "../shared/release";

const GA_ID = "G-101HMD03VD";
const CONSENT_COOKIE = "shell_analytics_consent";
const CONSENT_MAX_AGE = 31_536_000; // 1 year
const GA_COOKIE_PREFIX = "shell_public_ga";
const GA_COOKIE_MAX_AGE = 7_776_000; // 90 days
const PUBLIC_HOST = "shell.online";

export type ConsentChoice = "accepted" | "declined";

function isPublicPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  const route = resolveDocumentationRoute(pathname, RELEASE_VERSION);
  return route !== null;
}

export function isPublicAnalyticsUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.hostname !== PUBLIC_HOST) return false;
  if (url.port !== "") return false;
  if (url.search !== "") return false;
  if (url.hash !== "") return false;
  return isPublicPath(url.pathname);
}

export function readConsentCookie(cookieString?: string): ConsentChoice | null {
  const source = cookieString ?? document.cookie;
  for (const part of source.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== CONSENT_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value === "accepted" || value === "declined") return value;
    return null;
  }
  return null;
}

export function writeConsentCookie(choice: ConsentChoice): boolean {
  try {
    document.cookie = `${CONSENT_COOKIE}=${choice}; Path=/; Secure; SameSite=Lax; Max-Age=${CONSENT_MAX_AGE}`;
    return readConsentCookie() === choice;
  } catch {
    return false;
  }
}

export function clearConsentCookie(): void {
  try {
    document.cookie = `${CONSENT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
  } catch {
    // fail closed: if we cannot clear, we simply stay off
  }
}

export function isGpcOrDnt(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return true;
  if (navigator.doNotTrack === "1") return true;
  return false;
}

function canonicalPageLocation(url: URL): string {
  return `https://${PUBLIC_HOST}${url.pathname === "" ? "/" : url.pathname}`;
}

function pageTitleFor(pathname: string): string {
  if (pathname === "/" || pathname === "") return "Share a Live Terminal in Any Browser | shell.online";
  const route = resolveDocumentationRoute(pathname, RELEASE_VERSION);
  if (route) return "Documentation | shell.online";
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

function setGaDisabled(disabled: boolean): void {
  (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`] = disabled;
}

function removeGaCookies(): void {
  let cookieString: string;
  try {
    cookieString = document.cookie;
  } catch {
    return;
  }
  const names = new Set<string>();
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name.startsWith(GA_COOKIE_PREFIX)) {
      names.add(name);
    }
  }
  for (const name of names) {
    try {
      document.cookie = `${name}=; Path=/; Secure; Max-Age=0`;
    } catch {
      // best effort
    }
  }
}

let gtagLoaded = false;

type GtagFn = (...args: unknown[]) => void;

function gtagInstance(): GtagFn | null {
  const w = window as unknown as Record<string, unknown>;
  const fn = w.gtag;
  return typeof fn === "function" ? (fn as GtagFn) : null;
}

export function loadGtag(): void {
  if (gtagLoaded) return;
  const url = new URL(window.location.href);
  if (!isPublicAnalyticsUrl(url)) return;
  if (isGpcOrDnt()) return;
  let consent: ConsentChoice | null;
  try {
    consent = readConsentCookie();
  } catch {
    return;
  }
  if (consent !== "accepted") return;

  gtagLoaded = true;
  setGaDisabled(false);

  const w = window as unknown as Record<string, unknown>;
  const dataLayer = (w.dataLayer ??= []) as unknown[];

  // Define gtag once; every command goes through it so dataLayer holds
  // standard Arguments objects, not array literals.
  const gtag: GtagFn = function gtag() {
    dataLayer.push(arguments);
  };
  w.gtag = gtag;

  // Queue consent and config BEFORE the async script loads.
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "granted",
    functionality_storage: "granted",
    personalization_storage: "denied",
    security_storage: "granted",
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

export function withdrawAnalytics(): void {
  setGaDisabled(true);
  const gtag = gtagInstance();
  if (gtag && gtagLoaded) {
    gtag("consent", "update", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied",
      functionality_storage: "granted",
      personalization_storage: "denied",
      security_storage: "granted",
    });
  }
  writeConsentCookie("declined");
  removeGaCookies();
}

export function acceptAnalytics(): void {
  const url = new URL(window.location.href);
  if (!isPublicAnalyticsUrl(url)) return;
  if (isGpcOrDnt()) return;
  if (!writeConsentCookie("accepted")) return;
  setGaDisabled(false);
  if (gtagLoaded) {
    const gtag = gtagInstance();
    if (gtag) {
      gtag("consent", "update", {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "granted",
        functionality_storage: "granted",
        personalization_storage: "denied",
        security_storage: "granted",
      });
    }
  } else {
    loadGtag();
  }
}

export function initAnalytics(): void {
  const url = new URL(window.location.href);
  if (!isPublicAnalyticsUrl(url)) return;
  if (isGpcOrDnt()) return;

  let consent: ConsentChoice | null;
  try {
    consent = readConsentCookie();
  } catch {
    return;
  }

  if (consent === "accepted") {
    loadGtag();
    renderPreferencesControl();
    return;
  }
  if (consent === "declined") {
    renderPreferencesControl();
    return;
  }

  renderConsentBanner();
  renderPreferencesControl();
}

function renderPreferencesControl(): void {
  const existing = document.getElementById("analytics-preferences");
  if (existing) return;

  const link = document.createElement("button");
  link.id = "analytics-preferences";
  link.type = "button";
  link.textContent = "Analytics preferences";
  link.setAttribute("aria-label", "Change analytics preferences");
  link.style.cssText =
    "position:fixed;bottom:8px;right:8px;z-index:9998;padding:4px 10px;border-radius:4px;border:1px solid #d1d5db;background:#fff;color:#6b7280;font:11px/1.4 system-ui,sans-serif;cursor:pointer;opacity:.7";
  link.addEventListener("mouseenter", () => { link.style.opacity = "1"; });
  link.addEventListener("mouseleave", () => { link.style.opacity = ".7"; });
  link.addEventListener("click", () => showPreferences());
  document.body.appendChild(link);
}

function showPreferences(): void {
  const existing = document.getElementById("analytics-preferences-dialog");
  if (existing) { existing.remove(); return; }

  const dialog = document.createElement("div");
  dialog.id = "analytics-preferences-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Analytics preferences");
  dialog.style.cssText =
    "position:fixed;bottom:36px;right:8px;z-index:9999;padding:12px 16px;background:#fff;border:1px solid #d1d5db;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.1);display:flex;align-items:center;gap:10px;font:13px/1.4 system-ui,sans-serif;color:#374151";

  const text = document.createElement("span");
  text.textContent = "Analytics:";

  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = "Accept";
  accept.style.cssText = "padding:4px 12px;border-radius:4px;border:1px solid #2563eb;background:#2563eb;color:#fff;font:inherit;cursor:pointer";
  accept.addEventListener("click", () => {
    dialog.remove();
    acceptAnalytics();
  });

  const decline = document.createElement("button");
  decline.type = "button";
  decline.textContent = "Decline";
  decline.style.cssText = "padding:4px 12px;border-radius:4px;border:1px solid #6b7280;background:#fff;color:#374151;font:inherit;cursor:pointer";
  decline.addEventListener("click", () => {
    dialog.remove();
    withdrawAnalytics();
  });

  dialog.append(text, accept, decline);
  document.body.appendChild(dialog);
}

function renderConsentBanner(): void {
  const existing = document.getElementById("analytics-consent");
  if (existing) return;

  const banner = document.createElement("div");
  banner.id = "analytics-consent";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Analytics consent");
  banner.style.cssText =
    "position:fixed;bottom:0;left:0;right:0;z-index:9999;padding:12px 16px;background:#fff;border-top:1px solid #d1d5db;display:flex;align-items:center;gap:12px;font:13px/1.4 system-ui,sans-serif;color:#374151;box-shadow:0 -2px 8px rgba(0,0,0,.06)";

  const text = document.createElement("span");
  text.textContent = "We use Google Analytics on public pages to understand usage. No terminal or session data is sent.";
  text.style.flex = "1";

  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = "Accept analytics";
  accept.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;font:inherit;cursor:pointer";
  accept.addEventListener("click", () => {
    banner.remove();
    acceptAnalytics();
  });

  const decline = document.createElement("button");
  decline.type = "button";
  decline.textContent = "Decline";
  decline.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #6b7280;background:#fff;color:#374151;font:inherit;cursor:pointer";
  decline.addEventListener("click", () => {
    banner.remove();
    writeConsentCookie("declined");
  });

  banner.append(text, accept, decline);
  document.body.appendChild(banner);
}
