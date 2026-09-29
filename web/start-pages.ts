/**
 * Ad-specific versions of the /start/ page.
 *
 * Each ad links to /start/?utm_content=<page>. The wording for every page
 * lives in the payload of one PostHog feature flag, so a new page or a
 * wording change is an edit in PostHog, not a deploy:
 *
 *   flag key: start-landing-pages (released to everyone)
 *   payload:  {"pages": {"pocket": {"headline": "…", "subline": "…",
 *              "agent": "codex", "send": "…"}}}
 *
 * Every field is optional and falls back to the page's own text. Values are
 * only ever set as text, never as markup, and anything malformed is ignored.
 */
import { POSTHOG_ORIGIN, POSTHOG_TOKEN } from "../shared/posthog";
import { agentCommand } from "./landing-brands";

export const START_PAGES_FLAG = "start-landing-pages";
/** A page key: short, lower case, and never free text in analytics. */
export const PAGE_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LIMITS = { headline: 120, subline: 160, send: 48 } as const;

export interface StartPage {
  headline?: string;
  subline?: string;
  /** Step 2's command, e.g. "codex" for `shell codex`. */
  run?: string;
  send?: string;
}

/** The page key an ad asked for, or "" when it asked for none (or garbage). */
export function requestedPage(url: URL): string {
  const raw = (url.searchParams.get("utm_content") ?? "").trim().toLowerCase();
  return PAGE_KEY.test(raw) ? raw : "";
}

/** The page for `key` from a flag payload, validated field by field. */
export function pageFromPayload(payload: unknown, key: string): StartPage | null {
  if (!key || !PAGE_KEY.test(key)) return null;
  const parsed = typeof payload === "string" ? safeJson(payload) : payload;
  const pages = isRecord(parsed) && isRecord(parsed.pages) ? parsed.pages : null;
  const entry = pages && Object.hasOwn(pages, key) ? pages[key] : null;
  if (!isRecord(entry)) return null;
  const page: StartPage = {};
  for (const field of ["headline", "subline", "send"] as const) {
    const value = entry[field];
    if (typeof value === "string" && value.trim() && value.length <= LIMITS[field]) page[field] = value.trim();
  }
  if (typeof entry.agent === "string") {
    const command = agentCommand(entry.agent);
    if (command) page.run = command;
  }
  return page;
}

/** The payload of the pages flag from a `/flags?v=2` response, or null. */
export function payloadFromFlags(response: unknown): unknown {
  if (!isRecord(response) || !isRecord(response.flags)) return null;
  const flag = response.flags[START_PAGES_FLAG];
  if (!isRecord(flag) || flag.enabled !== true || !isRecord(flag.metadata)) return null;
  return flag.metadata.payload ?? null;
}

/**
 * Ask PostHog for the pages. A throwaway id, not the visitor's analytics id:
 * reading the page's wording must not identify or count anyone. Gives up
 * quickly so a blocked or slow request only means the default page.
 */
export async function loadPage(key: string, timeoutMs = 800): Promise<StartPage | null> {
  if (!key) return null;
  try {
    const response = await fetch(`${POSTHOG_ORIGIN}/flags/?v=2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: POSTHOG_TOKEN, distinct_id: crypto.randomUUID() }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return pageFromPayload(payloadFromFlags(await response.json()), key);
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
