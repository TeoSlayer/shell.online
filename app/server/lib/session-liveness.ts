import type { SessionRecord } from "./types";

export type RelaySessionStatus = "waiting" | "connected" | "disconnected" | "exited";
export type SessionRelayState = RelaySessionStatus | "missing" | "unknown";

export interface SessionLiveness {
  relayStatus: SessionRelayState;
  /** Absent when a bounded batch has not reached this session yet. */
  relayCheckedAt?: number;
}

export interface SessionLivenessSource {
  one(sessionId: string): Promise<SessionLiveness>;
  many(sessions: readonly Pick<SessionRecord, "id" | "closedAt" | "startedAt">[]): Promise<Map<string, SessionLiveness>>;
}

interface CacheEntry extends SessionLiveness {
  relayCheckedAt: number;
  expiresAt: number;
}

interface LivenessOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  successTtlMs?: number;
  failureTtlMs?: number;
  maxChecksPerBatch?: number;
  maxChecksPerMinute?: number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{32}$/;
const STATUSES = new Set<RelaySessionStatus>(["waiting", "connected", "disconnected", "exited"]);

/**
 * Reads process liveness from one configured relay.
 *
 * The session's share URL is deliberately absent from this API. A registry row
 * is caller-supplied data and must never become a server-side fetch target;
 * every request below is rooted at the operator's RELAY_URL.
 */
export function relaySessionLiveness(relayUrl: string, options: LivenessOptions = {}): SessionLivenessSource {
  const configured = new URL(relayUrl);
  if (configured.protocol !== "https:" && configured.protocol !== "http:") {
    throw new Error("relay URL must use http or https");
  }
  const relayOrigin = configured.origin;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 2_500;
  const successTtlMs = options.successTtlMs ?? 30_000;
  const failureTtlMs = options.failureTtlMs ?? 5_000;
  /* A browser polls every four seconds and the relay allows 120 checks/minute. */
  const maxChecksPerBatch = options.maxChecksPerBatch ?? 2;
  const maxChecksPerMinute = options.maxChecksPerMinute ?? 30;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<SessionLiveness>>();
  const checks: number[] = [];

  function reserveCheck(at: number): boolean {
    while (checks.length > 0 && checks[0] <= at - 60_000) checks.shift();
    if (checks.length >= maxChecksPerMinute) return false;
    checks.push(at);
    return true;
  }

  async function query(sessionId: string): Promise<SessionLiveness> {
    const checkedAt = now();
    if (!SESSION_ID.test(sessionId)) return { relayStatus: "unknown", relayCheckedAt: checkedAt };

    const cached = cache.get(sessionId);
    if (cached && cached.expiresAt > checkedAt) {
      return { relayStatus: cached.relayStatus, relayCheckedAt: cached.relayCheckedAt };
    }
    const underway = inFlight.get(sessionId);
    if (underway) return underway;
    if (!reserveCheck(checkedAt)) return { relayStatus: "unknown" };

    const request = (async (): Promise<SessionLiveness> => {
      let relayStatus: SessionRelayState = "unknown";
      try {
        const response = await fetcher(
          new URL(`/api/sessions/${encodeURIComponent(sessionId)}`, relayOrigin),
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) },
        );
        if (response.status === 404) {
          relayStatus = "missing";
        } else if (response.ok) {
          const body = await response.json() as { exists?: unknown; status?: unknown };
          if (body.exists === false) relayStatus = "missing";
          else if (typeof body.status === "string" && STATUSES.has(body.status as RelaySessionStatus)) {
            relayStatus = body.status as RelaySessionStatus;
          }
        }
      } catch {
        /* An unreachable relay is not evidence that the process ended. */
      }
      const result = { relayStatus, relayCheckedAt: now() };
      const ttl = relayStatus === "connected" || relayStatus === "exited" || relayStatus === "missing"
        ? successTtlMs
        : failureTtlMs;
      cache.set(sessionId, {
        ...result,
        expiresAt: result.relayCheckedAt + ttl,
      });
      return result;
    })().finally(() => inFlight.delete(sessionId));
    inFlight.set(sessionId, request);
    return request;
  }

  return {
    one: query,
    async many(sessions) {
      const answer = new Map<string, SessionLiveness>();
      const open = sessions.filter((session) => !session.closedAt && SESSION_ID.test(session.id));
      const due = open
        .filter((session) => (cache.get(session.id)?.expiresAt ?? 0) <= now())
        .sort((left, right) => {
          const leftChecked = cache.get(left.id)?.relayCheckedAt ?? 0;
          const rightChecked = cache.get(right.id)?.relayCheckedAt ?? 0;
          return leftChecked - rightChecked || right.startedAt - left.startedAt;
        })
        .slice(0, Math.max(0, maxChecksPerBatch));
      await Promise.all(due.map((session) => query(session.id)));
      for (const session of open) {
        const entry = cache.get(session.id);
        answer.set(session.id, entry
          ? { relayStatus: entry.relayStatus, relayCheckedAt: entry.relayCheckedAt }
          : { relayStatus: "unknown" });
      }
      return answer;
    },
  };
}
