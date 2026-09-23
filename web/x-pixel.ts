import { hasAnalyticsOptOut, isGpcOrDnt, isPublicAnalyticsUrl } from "./analytics";

// Public advertiser ID, not the server-side Conversion API token.
export const X_PIXEL_ID = "rfilf";
const SCRIPT_URL = "https://static.ads-twitter.com/uwt.js";

type PixelQueue = ((...args: unknown[]) => void) & {
  exe?: (...args: unknown[]) => void;
  queue: IArguments[];
  version: string;
};

/** Base visit only. Install/copy conversions require separately configured event IDs. */
export function initXPixel(): void {
  try {
    const url = new URL(window.location.href);
    if (url.pathname !== "/" || !isPublicAnalyticsUrl(url) || isGpcOrDnt() || hasAnalyticsOptOut()) return;
    // The vendor extracts this value itself. Refuse malformed/unbounded click IDs.
    const clicks = url.searchParams.getAll("twclid");
    if (clicks.length > 1 || (clicks.length === 1 && !/^[A-Za-z0-9_-]{1,256}$/.test(clicks[0]))) return;
    const w = window as unknown as { twq?: PixelQueue };
    // Don't reconfigure a loaded tag, overwrite another queue, or double count.
    if (w.twq) return;
    const twq: PixelQueue = Object.assign(function (this: unknown) {
      if (twq.exe) twq.exe.apply(twq, Array.from(arguments));
      else twq.queue.push(arguments);
    }, { queue: [] as IArguments[], version: "1.1" });
    w.twq = twq;
    // Keep landing-page attribution, never the raw query/fragment or referrer.
    // The vendor replaces both location and a nonempty referrer with this URL.
    twq("set", { page_location: "https://shell.online/" });
    // Disable vendor defaults that capture button text, form fields, dataLayer
    // events and timed engagement. These switches are verified against uwt.js
    // by the real-script browser gate, not just a mocked queue.
    for (const feature of ["autoConfig", "autoAdvancedMatching", "dataLayerTracking", "autoDwellTracking"]) {
      twq("set", feature, "false", X_PIXEL_ID);
    }
    twq("config", X_PIXEL_ID);
    const script = document.createElement("script");
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.src = SCRIPT_URL;
    document.head.appendChild(script);
  } catch {
    // Privacy checks failing or an unavailable/blocked tag must not break use.
  }
}
