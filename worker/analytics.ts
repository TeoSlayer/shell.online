import { resolveDocumentationRoute } from "../shared/documentation";
import type { UniqueSurface } from "../shared/stats";

export type AnalyticsEvent =
  | "page_view"
  | "copy"
  | "cta_click"
  | "installer_download"
  | "binary_download"
  | "skill_download"
  | "session_created"
  | "session_started"
  | "share_opened"
  | "viewer_connected"
  | "viewer_disconnected"
  | "collaboration_started"
  | "session_ended"
  | "stats_view";

export type DeviceClass = "mobile" | "tablet" | "desktop" | "bot" | "cli" | "unknown";

export interface AnalyticsDataset {
  writeDataPoint(point: {
    indexes: string[];
    blobs: string[];
    doubles: number[];
  }): void;
}

export interface AnalyticsContext {
  device?: DeviceClass;
  client?: string;
  referrer?: string;
  value?: number;
  auxiliary?: number;
  /**
   * A keyed hash standing in for the person behind the request, so the
   * private dashboard can count how many there were and how many came back.
   * Goes to the dashboard's own store only; see writeAnalytics, which never
   * sends it to Analytics Engine.
   */
  visitor?: string;
}

export interface AnalyticsRecord {
  event: AnalyticsEvent;
  target: string;
  device: DeviceClass;
  client: string;
  referrer: string;
  count: number;
  value: number;
  auxiliary: number;
}

/** What the landing page reports when one of its sign-up links is clicked. */
export const CTA_TARGETS: ReadonlySet<string> = new Set(["signup_nav", "signup_hero", "signup_team", "signup_footer"]);

/** What the landing page reports when a command or link is copied. */
export const COPY_TARGETS: ReadonlySet<string> = new Set(["install", "brew_install", "source_build", "run", "share", "skill"]);

/** A share page: /s/ and a session id. */
const SESSION_PATH = /^\/s\/[A-Za-z0-9_-]{32}\/?$/;

/** Shorter salts are guessable, and a guessable salt turns hashes back into addresses. */
export const MIN_VISITOR_SALT_LENGTH = 16;

/**
 * Analytics Engine fields are deliberately fixed and low-cardinality:
 *
 *   blob1 event, blob2 target, blob3 device, blob4 client, blob5 referrer
 *   double1 count, double2 value/duration, double3 auxiliary/peak viewers
 *
 * No session IDs, terminal contents, commands, URLs, IPs, raw user agents, or
 * visitor hashes are written to analytics.
 */
export function writeAnalytics(
  dataset: AnalyticsDataset,
  event: AnalyticsEvent,
  target: string,
  context: AnalyticsContext = {},
): void {
  const record = normalizeAnalyticsRecord(event, target, context);
  const index = `${record.event}:${record.target}`.slice(0, 96);

  try {
    dataset.writeDataPoint({
      indexes: [index],
      blobs: [
        record.event,
        record.target,
        record.device,
        record.client,
        record.referrer,
      ],
      doubles: [
        record.count,
        record.value,
        record.auxiliary,
      ],
    });
  } catch {
    // Product behavior must never depend on analytics availability.
  }
}

export function normalizeAnalyticsRecord(
  event: AnalyticsEvent,
  target: string,
  context: AnalyticsContext = {},
): AnalyticsRecord {
  return {
    event,
    target: cleanDimension(target, "unknown"),
    device: context.device ?? "unknown",
    client: cleanDimension(context.client, "unknown"),
    referrer: cleanDimension(context.referrer, "direct"),
    count: 1,
    value: finiteMetric(context.value),
    auxiliary: finiteMetric(context.auxiliary),
  };
}

export function requestAnalyticsContext(request: Request): AnalyticsContext {
  const userAgent = request.headers.get("User-Agent") ?? "";
  return {
    device: classifyDevice(userAgent, request.headers.get("Sec-CH-UA-Mobile")),
    client: classifyClient(userAgent),
    referrer: classifyReferrer(request.headers.get("Referer"), new URL(request.url).origin),
  };
}

export function hasVisitorSalt(salt: unknown): salt is string {
  return typeof salt === "string" && salt.length >= MIN_VISITOR_SALT_LENGTH;
}

/**
 * The hash that stands in for a visitor: SHA-256 over a secret, the address
 * and the browser family. The family is the user agent with its version
 * numbers removed, so a browser update does not make a new visitor. Without
 * the secret the hash cannot be turned back into an address, and the secret
 * never leaves the Worker. Twenty hex characters is eighty bits: enough to
 * keep visitors apart, small enough to keep by the thousand.
 */
export async function visitorKey(salt: string, address: string, userAgent: string): Promise<string> {
  const family = userAgent.replace(/\d+/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const bytes = new TextEncoder().encode(`${salt}\n${address}\n${family}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 10), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The visitor hash for a request, or nothing when the Worker has no salt or the edge sent no address. */
export async function requestVisitor(salt: unknown, request: Request): Promise<string | undefined> {
  if (!hasVisitorSalt(salt)) return undefined;
  const address = request.headers.get("CF-Connecting-IP");
  if (!address) return undefined;
  return visitorKey(salt, address, request.headers.get("User-Agent") ?? "");
}

/**
 * Which surface an event counts a person on, or null for events that do not
 * count people: a session ending is the same machine that started it, and a
 * viewer disconnecting is the same browser that connected.
 */
export function uniqueSurface(event: AnalyticsEvent, target: string): UniqueSurface | null {
  switch (event) {
    case "page_view":
      if (target === "session") return "viewer";
      if (target === "not_found" || target === "unknown_path") return null;
      return "site";
    case "copy":
    case "cta_click":
      return "site";
    case "installer_download":
    case "binary_download":
      return "install";
    case "session_created":
      return "cli";
    case "viewer_connected":
      return "viewer";
    default:
      return null;
  }
}

/**
 * What a document request counts as.
 *
 * Every documentation route, current or versioned, has its own target, so a
 * page added to the docs is counted the day it ships rather than falling
 * through. A 404 is "not_found". Anything else the site answered without
 * knowing the path is "unknown_path": the assets binding serves the landing
 * page for those, so they are not lost visitors but they are not the landing
 * page either, and the count says how often a link points somewhere the site
 * should answer properly.
 */
export function documentTarget(pathname: string, status: number, currentVersion: string): string {
  if (status === 404) return "not_found";
  if (pathname === "/") return "landing";
  const route = resolveDocumentationRoute(pathname, currentVersion);
  if (route) return route.kind === "docs" ? "docs" : `docs_${route.kind.replace(/-/g, "_")}`;
  if (SESSION_PATH.test(pathname)) return "session";
  return "unknown_path";
}

export function isDocumentNavigation(request: Request): boolean {
  if (request.method !== "GET") return false;
  if (request.headers.get("Sec-Fetch-Dest") === "document") return true;
  return request.headers.get("Accept")?.toLowerCase().includes("text/html") ?? false;
}

export function binaryDownloadTarget(pathname: string): string | null {
  const match = pathname.match(/^\/downloads\/shell-(darwin|windows|linux|freebsd|openbsd|netbsd|dragonfly|solaris)-([a-z0-9]+)(?:\.exe)?$/);
  return match ? `${match[1]}-${match[2]}` : null;
}

export function classifyDevice(userAgent: string, mobileHint: string | null = null): DeviceClass {
  const normalized = userAgent.toLowerCase();
  if (!normalized) return "unknown";
  if (/bot|crawler|spider|slurp|headless|preview/.test(normalized)) return "bot";
  if (/^shell\//.test(normalized) || /curl|wget/.test(normalized)) return "cli";
  if (mobileHint === "?1" || /iphone|ipod|android.+mobile|mobile.+android/.test(normalized)) {
    return "mobile";
  }
  if (/ipad|tablet|android/.test(normalized)) return "tablet";
  return "desktop";
}

export function classifyClient(userAgent: string): string {
  const shellVersion = userAgent.match(/\bshell\/(\d{1,3}\.\d{1,3}\.\d{1,3})\b/i)?.[1];
  if (shellVersion) return `shell/${shellVersion}`;
  if (/curl/i.test(userAgent)) return "curl";
  if (/wget/i.test(userAgent)) return "wget";
  if (/bot|crawler|spider|slurp|headless|preview/i.test(userAgent)) return "bot";
  return userAgent ? "web" : "unknown";
}

export function classifyReferrer(referrer: string | null, requestOrigin: string): string {
  if (!referrer) return "direct";

  try {
    const url = new URL(referrer);
    if (url.origin === requestOrigin) return "internal";
    const hostname = url.hostname.toLowerCase();
    if (hostname === "news.ycombinator.com") return "hacker_news";
    if (hostname === "github.com" || hostname.endsWith(".github.com")) return "github";
    if (hostname === "reddit.com" || hostname.endsWith(".reddit.com")) return "reddit";
    if (hostname === "x.com" || hostname === "twitter.com" || hostname.endsWith(".twitter.com")) {
      return "x";
    }
    if (hostname === "google.com" || hostname.endsWith(".google.com")) return "google";
    return "other";
  } catch {
    return "other";
  }
}

function cleanDimension(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._:/-]/g, "_").slice(0, 64);
  return cleaned || fallback;
}

function finiteMetric(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}
