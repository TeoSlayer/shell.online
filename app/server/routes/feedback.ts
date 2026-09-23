import type { Feedback, Store } from "../lib/store";
import { newId, type Membership } from "../lib/orgs";
import { feedbackMessage, type Mailer } from "../lib/mail";
import type { Outcome } from "./social";

export const MAX_FEEDBACK = 4000;
export const FEEDBACK_KINDS = ["problem", "idea", "question"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/* How much of the app's own bookkeeping one message may carry. */
const MAX_ROUTE = 200;
const MAX_VERSION = 40;
const MAX_USER_AGENT = 300;
const MAX_CONTEXT_ENTRIES = 8;
const MAX_CONTEXT_VALUE = 200;

/** What the browser sends: the message, and where in the app it was written. */
export interface FeedbackInput {
  kind: FeedbackKind;
  body: string;
  surface: string;
  route: string;
  appVersion: string;
  canReply: boolean;
  context: Record<string, string>;
}

function isKind(value: unknown): value is FeedbackKind {
  return typeof value === "string" && (FEEDBACK_KINDS as readonly string[]).includes(value);
}

/*
 * The route the message came from, path only. A query string can name a
 * session (?open=...) and a hash is where a share link keeps its key, so
 * neither is kept even when the client sends them.
 */
function readRoute(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.split(/[?#]/, 1)[0].trim();
  return path.startsWith("/") ? path.slice(0, MAX_ROUTE) : "";
}

/*
 * Small facts the surface attached: which kind of session was being started,
 * which machine, what the error said. Bounded in count and size, and keyed by
 * identifiers rather than free text, so the column stays a handful of labels
 * and never becomes a second message body.
 */
function readContext(value: unknown): Record<string, string> {
  const context: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return context;
  let kept = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= MAX_CONTEXT_ENTRIES) break;
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    context[key] = trimmed.slice(0, MAX_CONTEXT_VALUE);
    kept += 1;
  }
  return context;
}

export function readFeedback(body: unknown): Outcome<FeedbackInput> {
  const given = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!isKind(given.kind)) {
    return { ok: false, status: 400, error: "say whether this is a problem, an idea or a question" };
  }
  const text = typeof given.body === "string" ? given.body.trim() : "";
  if (!text) return { ok: false, status: 400, error: "write something first" };
  if (text.length > MAX_FEEDBACK) {
    return {
      ok: false,
      status: 400,
      error: `keep it under ${MAX_FEEDBACK} characters; you can send more than one`,
    };
  }
  /* The surface is an identifier the app chose, so anything else is "unknown" rather than kept. */
  const surface =
    typeof given.surface === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(given.surface)
      ? given.surface
      : "unknown";
  return {
    ok: true,
    value: {
      kind: given.kind,
      body: text,
      surface,
      route: readRoute(given.route),
      appVersion:
        typeof given.app_version === "string" ? given.app_version.trim().slice(0, MAX_VERSION) : "",
      canReply: given.can_reply === true,
      context: readContext(given.context),
    },
  };
}

/**
 * Keeps a message and, when an address is configured, forwards it.
 *
 * The row is the record; the email is a convenience for whoever reads them.
 * So the mail is best effort, like an invitation: a provider having a bad
 * afternoon must not turn a message somebody took the time to write into an
 * error they have to read.
 */
export async function submitFeedback(
  store: Store,
  mailer: Mailer,
  sender: Membership | null,
  body: unknown,
  userAgent: string,
  forwardTo: string | undefined,
  log: (message: string, error?: unknown) => void,
  now = Date.now(),
): Promise<Outcome<Feedback>> {
  const read = readFeedback(body);
  if (!read.ok) return read;
  const feedback: Feedback = {
    id: newId("fbk"),
    ...read.value,
    uid: sender?.uid ?? "",
    email: sender?.email ?? "",
    orgId: sender?.orgId,
    canReply: Boolean(sender?.email) && read.value.canReply,
    context: sender ? read.value.context : {},
    userAgent: userAgent.trim().slice(0, MAX_USER_AGENT),
    at: now,
  };
  await store.putFeedback(feedback);
  if (forwardTo) {
    try {
      await mailer.send(feedbackMessage(feedback, forwardTo));
    } catch (error) {
      log(`accounts: could not forward feedback ${feedback.id}`, error);
    }
  }
  return { ok: true, value: feedback };
}
