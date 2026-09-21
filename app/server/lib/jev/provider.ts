/**
 * The real, bounded TypeSafe adapter.
 *
 * Contract verified from the official docs (docs.typesafe.ai/api):
 *   POST https://api.typesafe.ai/v1/systemone  { state, model, questions }
 *   answers: noul (no confidence) | choice (choice/probabilities/confidence)
 *   errors: 401, 422, 429, 529.
 *
 * Nothing here logs, retries, follows a redirect, or holds a browser key. The
 * credential lives only in the deployment secret and is passed in by the
 * caller. Without it the adapter is not configured and every path is inert.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";

export interface JevLimits {
  maxStateChars: number;
  maxQuestions: number;
  timeoutMs: number;
  /** Hard ceiling on response bytes read from the provider, streaming included. */
  maxResponseBytes: number;
  /** Sliding-window request cap: at most maxRequests per windowMs. */
  maxRequests: number;
  windowMs: number;
  /** A hard ceiling on input characters accepted in one window (cost proxy). */
  maxInputCharsPerWindow: number;
  confidenceFloor: number;
}

export const JEV_LIMITS: JevLimits = {
  maxStateChars: 2_000,
  maxQuestions: 4,
  timeoutMs: 2_500,
  maxResponseBytes: 65_536,
  maxRequests: 6,
  windowMs: 60_000,
  maxInputCharsPerWindow: 8_000,
  confidenceFloor: 0.7,
};

export type JevAnswer =
  | { kind: "noul"; noul: number }
  | { kind: "choice"; choice: string; confidence: number };

export type JevResult =
  | { ok: true; model: string; answers: Record<string, JevAnswer>; usage: { input: number; output: number } | null }
  | { ok: false; reason: string };

export interface JevQuestion {
  type: "noul" | "choice";
  instructions: string;
  criteria?: Record<string, string> | string[];
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  /** Real transports stream; test seams may omit this and use json(). */
  body?: ReadableStream<Uint8Array> | null;
}>;

/**
 * Reads the whole response body under one byte cap, abortable by the same
 * deadline as the request itself. The reader is always cancelled, so a held or
 * oversized upstream body cannot keep the connection (or the caller) alive.
 */
async function readBoundedBody(
  response: { json: () => Promise<unknown>; body?: ReadableStream<Uint8Array> | null },
  cap: number,
  signal: AbortSignal,
): Promise<{ oversize: true } | { malformed: true } | { value: unknown }> {
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const onAbort = () => { void reader.cancel().catch(() => undefined); };
    const canListen = typeof signal.addEventListener === "function";
    if (signal.aborted) onAbort();
    else if (canListen) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > cap) return { oversize: true };
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      try {
        return { value: JSON.parse(text) as unknown };
      } catch {
        return { malformed: true };
      }
    } finally {
      if (canListen) signal.removeEventListener("abort", onAbort);
      try { await reader.cancel(); } catch { /* already closed or cancelled */ }
    }
  }
  /* Non-streaming seam: the parse still happens inside the caller's deadline. */
  try {
    return { value: await response.json() };
  } catch {
    return { malformed: true };
  }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const unit = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;

/**
 * Removes credential-shaped material from an excerpt before it can leave the
 * machine. This is minimization, not a guarantee: consent and the state bound
 * are what actually limit what is sent.
 */
export function redactExcerpt(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const replace = (pattern: RegExp, value: string) => value.replace(pattern, () => {
    redactions += 1;
    return "[redacted]";
  });
  let out = String(text ?? "");
  out = replace(/\b(?:bearer|authorization)\s+[A-Za-z0-9._~+/=-]{8,}/gi, out);
  out = replace(/\b(?:sk|key|token|secret)[_-][A-Za-z0-9._-]{8,}/gi, out);
  out = replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g, out);
  out = replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, out);
  return { text: out, redactions };
}

/** One choice question per call, always with an explicit unknown option. */
export function choiceQuestion(instructions: string, criteria: Record<string, string>): JevQuestion {
  return { type: "choice", instructions, criteria };
}

function validateAnswer(question: JevQuestion, answer: unknown): JevAnswer | null {
  if (!answer || typeof answer !== "object") return null;
  const record = answer as Record<string, unknown>;
  if (question.type === "noul") {
    if (record.type !== "noul" || !unit(record.noul)) return null;
    return { kind: "noul", noul: record.noul };
  }
  const options = Object.keys(question.criteria ?? {});
  if (record.type !== "choice" || typeof record.choice !== "string" || !options.includes(record.choice)) return null;
  const probabilities = record.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return null;
  let total = 0;
  for (const option of options) {
    const value = (probabilities as Record<string, unknown>)[option];
    if (!unit(value)) return null;
    total += value;
  }
  if (!finite(total) || Math.abs(total - 1) > 0.05) return null;
  if (!unit(record.confidence)) return null;
  return { kind: "choice", choice: record.choice, confidence: record.confidence };
}

export interface JevProviderOptions {
  /** From deployment secret management only; null/empty means not configured. */
  apiKey?: string | null;
  fetchImpl?: FetchLike;
  now?: () => number;
  limits?: Partial<JevLimits>;
  /** Test seam for a scheduler; defaults to real timers. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export function createJevProvider(options: JevProviderOptions = {}) {
  const limits: JevLimits = { ...JEV_LIMITS, ...options.limits };
  const apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : null;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const now = options.now ?? (() => Date.now());
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const usage: { at: number; chars: number }[] = [];
  let inFlight = 0;

  function trimWindow(at: number) {
    const cutoff = at - limits.windowMs;
    while (usage.length > 0 && usage[0].at < cutoff) usage.shift();
  }

  async function assess({ state, questions }: { state: string; questions: Record<string, JevQuestion> }): Promise<JevResult> {
    if (!apiKey || !fetchImpl) return { ok: false, reason: "not_configured" };
    if (typeof state !== "string" || state.length === 0 || state.length > limits.maxStateChars) {
      return { ok: false, reason: "state_out_of_bounds" };
    }
    const ids = Object.keys(questions ?? {});
    if (ids.length === 0 || ids.length > limits.maxQuestions) return { ok: false, reason: "questions_out_of_bounds" };
    if (inFlight >= 1) return { ok: false, reason: "busy" };
    const at = now();
    trimWindow(at);
    const chars = usage.reduce((sum, entry) => sum + entry.chars, 0);
    if (usage.length >= limits.maxRequests || chars + state.length > limits.maxInputCharsPerWindow) {
      return { ok: false, reason: "rate_capped" };
    }
    inFlight += 1;
    usage.push({ at, chars: state.length });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = new AbortController();
    const transport: { body: ReadableStream<Uint8Array> | null } = { body: null };
    try {
      const timeout = new Promise<{ kind: "timedOut" }>((resolve) => {
        timer = setTimeoutImpl(() => {
          abort.abort();
          resolve({ kind: "timedOut" });
        }, limits.timeoutMs);
      });
      /*
       * One deadline covers the request, the streamed body and the parse: the
       * racing task reads and decodes inside the same timeout, and a held or
       * oversized body aborts the upstream request and cancels its reader.
       */
      const settled = await Promise.race([
        (async () => {
          try {
            const response = await fetchImpl(JEV_ENDPOINT, {
              method: "POST",
              // Workers supports manual/follow, not redirect: "error". Refuse
              // every 3xx below without forwarding the provider credential.
              redirect: "manual",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({ state, model: JEV_MODEL, questions }),
              signal: abort.signal,
            });
            transport.body = response.body ?? null;
            const status = response.status;
            if (status >= 300 && status < 400) return { kind: "reason" as const, reason: "redirect_refused" };
            if (status === 401) return { kind: "reason" as const, reason: "unauthorized" };
            if (status === 422) return { kind: "reason" as const, reason: "invalid_request" };
            if (status === 429) return { kind: "reason" as const, reason: "rate_limited" };
            if (status === 529) return { kind: "reason" as const, reason: "overloaded" };
            if (status !== 200) return { kind: "reason" as const, reason: "provider_error" };
            const read = await readBoundedBody(response, limits.maxResponseBytes, abort.signal);
            if ("oversize" in read) {
              abort.abort();
              return { kind: "reason" as const, reason: "oversize" };
            }
            if ("malformed" in read) return { kind: "reason" as const, reason: "malformed" };
            return { kind: "body" as const, body: read.value };
          } catch {
            return { kind: "reason" as const, reason: "provider_error" };
          }
        })(),
        timeout,
      ]);
      if (settled.kind === "timedOut") return { ok: false, reason: "timeout" };
      if (settled.kind === "reason") return { ok: false, reason: settled.reason };
      const body: unknown = settled.body;
      if (!body || typeof body !== "object") return { ok: false, reason: "malformed" };
      const payload = body as { model?: unknown; answers?: unknown; usage?: unknown };
      if (typeof payload.model !== "string" || !payload.answers || typeof payload.answers !== "object") {
        return { ok: false, reason: "malformed" };
      }
      const answerMap = payload.answers as Record<string, unknown>;
      const answers: Record<string, JevAnswer> = {};
      for (const id of ids) {
        const valid = validateAnswer(questions[id], answerMap[id]);
        if (valid) answers[id] = valid;
      }
      const rawUsage = payload.usage as { input_tokens?: unknown; output_tokens?: unknown } | null | undefined;
      const measured =
        rawUsage && finite(rawUsage.input_tokens) && finite(rawUsage.output_tokens)
          ? { input: rawUsage.input_tokens, output: rawUsage.output_tokens }
          : null;
      return { ok: true, model: payload.model, answers, usage: measured };
    } finally {
      if (timer !== null) clearTimeoutImpl(timer);
      abort.abort();
      // Error statuses do not need parsing, but their bodies still need closing.
      // Do not await an uncooperative upstream cancellation after our deadline.
      if (transport.body) void transport.body.cancel().catch(() => undefined);
      inFlight -= 1;
    }
  }

  return {
    configured: apiKey !== null && fetchImpl !== undefined,
    assess,
    stats: () => ({ requestsInWindow: usage.length, inputCharsInWindow: usage.reduce((sum, entry) => sum + entry.chars, 0) }),
  };
}
