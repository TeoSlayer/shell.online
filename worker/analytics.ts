export type AnalyticsEvent =
  | "page_view"
  | "copy"
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

/**
 * Analytics Engine fields are deliberately fixed and low-cardinality:
 *
 *   blob1 event, blob2 target, blob3 device, blob4 client, blob5 referrer
 *   double1 count, double2 value/duration, double3 auxiliary/peak viewers
 *
 * No session IDs, terminal contents, commands, URLs, IPs, or raw user agents
 * are written to analytics.
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
