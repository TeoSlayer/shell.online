// Deliberately finite buckets, never raw campaign values, click IDs or URLs.
const SOURCES: Record<string, string> = {
  hn: "hacker_news",
  hackernews: "hacker_news",
  hacker_news: "hacker_news",
  reddit: "reddit",
  x: "x",
  twitter: "x",
  github: "github",
  google: "google",
  newsletter: "newsletter",
  email: "newsletter",
  producthunt: "product_hunt",
  product_hunt: "product_hunt",
  linkedin: "linkedin",
  youtube: "youtube",
  discord: "discord",
  slack: "slack",
  mastodon: "mastodon",
  bluesky: "bluesky",
  podcast: "podcast",
};
const SOURCE_VALUES = new Set([
  ...Object.values(SOURCES),
  "direct",
  "internal",
  "app",
  "other",
]);
export function safeSource(value: unknown): string | null {
  return typeof value === "string" && SOURCE_VALUES.has(value) ? value : null;
}
export function campaignSource(url: URL): string | null {
  const raw = url.searchParams.get("utm_source") ?? url.searchParams.get("ref");
  if (raw) {
    const key = raw.toLowerCase();
    return Object.hasOwn(SOURCES, key) ? SOURCES[key] : null;
  }
  return url.searchParams.has("twclid") ? "x" : null;
}
export function campaignMedium(url: URL): string | null {
  const raw = url.searchParams.get("utm_medium")?.toLowerCase();
  if (raw && ["cpc", "ppc"].includes(raw)) return "cpc";
  if (raw && ["paid", "paid_social"].includes(raw)) return "paid_social";
  if (raw && ["social", "email", "referral", "organic"].includes(raw))
    return raw;
  return url.searchParams.has("twclid") ? "paid_social" : null;
}
export function classifyReferrer(
  referrer: string | null,
  requestOrigin: string,
): string {
  if (!referrer) return "direct";
  try {
    const url = new URL(referrer);
    if (url.origin === requestOrigin) return "internal";
    const host = url.hostname.toLowerCase();
    if (
      host === "app.shell.online" ||
      host === `app.${new URL(requestOrigin).hostname}`
    )
      return "app";
    if (host === "news.ycombinator.com") return "hacker_news";
    for (const [domain, source] of [
      ["github.com", "github"],
      ["reddit.com", "reddit"],
      ["x.com", "x"],
      ["twitter.com", "x"],
      ["t.co", "x"],
      ["google.com", "google"],
    ]) {
      if (host === domain || host.endsWith(`.${domain}`)) return source;
    }
    return "other";
  } catch {
    return "other";
  }
}
export function publicSource(url: URL, referrer: string | null): string {
  return campaignSource(url) ?? classifyReferrer(referrer, url.origin);
}

export const PUBLIC_CTA_TARGETS = new Set([
  "start_nav",
  "start_hero",
  "start_footer",
  "demo",
  "github_star",
  "signup_nav",
  "signup_hero",
  "signup_team",
  "signup_footer",
]);
export function isPublicEvent(event: unknown, target: unknown): boolean {
  return (
    typeof target === "string" &&
    ((event === "page_loaded" && ["landing", "docs"].includes(target)) ||
      (event === "cta_click" && PUBLIC_CTA_TARGETS.has(target)) ||
      (event === "copy" &&
        [
          "install",
          "run",
          "docs_command",
          "brew_install",
          "source_build",
          "skill",
        ].includes(target)))
  );
}
