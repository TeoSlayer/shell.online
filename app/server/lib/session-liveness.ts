import type { SessionRecord } from "./types";

export type RelaySessionStatus = "waiting" | "connected" | "disconnected" | "exited";
export type SessionRelayState = RelaySessionStatus | "missing" | "unknown";

export interface SessionLiveness {
  relayStatus: SessionRelayState;
  /** Absent when a bounded batch has not reached this session yet. */
  relayCheckedAt?: number;
  /**
   * When the relay last had the machine's host socket, as the relay reports
   * it. This is what dates a disconnection, and so what separates a network
   * blip from a machine that was rebooted or lost power. Absent for a session
   * no host has ever reached, and from a relay too old to report it.
   */
  hostLastSeenAt?: number;
}

export interface SessionLivenessSource {
  one(sessionId: string): Promise<SessionLiveness>;
  many(sessions: readonly Pick<SessionRecord, "id" | "closedAt">[]): Promise<Map<string, SessionLiveness>>;
}

interface CacheEntry extends SessionLiveness {
  relayCheckedAt: number;
  expiresAt: number;
}

/** What a cached observation looks like to a caller: everything but its TTL. */
function reported(entry: CacheEntry): SessionLiveness {
  return {
    relayStatus: entry.relayStatus,
    relayCheckedAt: entry.relayCheckedAt,
    hostLastSeenAt: entry.hostLastSeenAt,
  };
}

interface LivenessOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  successTtlMs?: number;
  failureTtlMs?: number;
  maxChecksPerBatch?: number;
  maxChecksPerMinute?: number;
  /** Breaks ties between equally stale sessions. Injected so tests can fix it. */
  random?: () => number;
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
  /*
   * The per-minute figure is the one that protects the relay: it allows 120
   * checks a minute per address, shared with the websocket connects a viewer
   * needs, so this stays well under it and `reserveCheck` enforces it however
   * large a batch asks for.
   *
   * The per-batch figure is only about how much of the working set one request
   * may seed. It was two, which starved: three open sessions and a worker
   * instance that had never checked any of them meant one of the three was
   * reported as "unknown", and because the order was decided by a fixed
   * property of the session it was the same one every time, in every cold
   * instance, indefinitely. Eight covers an ordinary working set in the first
   * request, and the minute budget still bounds what a busy account can spend.
   */
  const maxChecksPerBatch = options.maxChecksPerBatch ?? 8;
  const maxChecksPerMinute = options.maxChecksPerMinute ?? 30;
  const random = options.random ?? Math.random;
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
    if (cached && cached.expiresAt > checkedAt) return reported(cached);
    const underway = inFlight.get(sessionId);
    if (underway) return underway;
    /* Out of budget: say what was last seen rather than forgetting it. */
    if (!reserveCheck(checkedAt)) return cached ? reported(cached) : { relayStatus: "unknown" };

    const request = (async (): Promise<SessionLiveness> => {
      let relayStatus: SessionRelayState = "unknown";
      let hostLastSeenAt: number | undefined;
      try {
        const response = await fetcher(
          new URL(`/api/sessions/${encodeURIComponent(sessionId)}`, relayOrigin),
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) },
        );
        if (response.status === 404) {
          relayStatus = "missing";
        } else if (response.ok) {
          const body = await response.json() as {
            exists?: unknown;
            status?: unknown;
            host_last_seen_at?: unknown;
          };
          if (body.exists === false) relayStatus = "missing";
          else if (typeof body.status === "string" && STATUSES.has(body.status as RelaySessionStatus)) {
            relayStatus = body.status as RelaySessionStatus;
            if (typeof body.host_last_seen_at === "number" && Number.isFinite(body.host_last_seen_at)) {
              hostLastSeenAt = body.host_last_seen_at;
            }
          }
        }
      } catch {
        /* An unreachable relay is not evidence that the process ended. */
      }
      /*
       * A failed check is a gap in this service's knowledge, not a change in
       * the session's. Overwriting a state we did have with "unknown" is what
       * made a card flip between "Offline" and "Status unavailable" every few
       * seconds while nothing about the session moved, so the last answer is
       * kept and simply re-aged.
       */
      if (relayStatus === "unknown") {
        const known = cache.get(sessionId);
        if (known && known.relayStatus !== "unknown") {
          cache.set(sessionId, { ...known, expiresAt: now() + failureTtlMs });
          return reported(known);
        }
      }
      const result = { relayStatus, relayCheckedAt: now(), hostLastSeenAt };
      /*
       * Only two answers are worth re-asking about quickly. "unknown" is not
       * an answer at all, and "waiting" is a session whose host is expected
       * within seconds.
       *
       * "disconnected" used to be in that group, on the reading that a
       * machine might come back at any moment. It cost six times the checks
       * of any other state, out of a budget of two per request -- so an
       * account with a few absent machines spent every check re-confirming
       * them and had none left for a session nobody had looked at yet, which
       * then read as "Status unavailable" indefinitely. It is a real answer,
       * it now carries the timestamp that makes it meaningful, and a host
       * that returns is worth finding out about within thirty seconds rather
       * than five.
       */
      const ttl = relayStatus === "unknown" || relayStatus === "waiting"
        ? failureTtlMs
        : successTtlMs;
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
      /*
       * Least recently checked first, and among sessions that are equally
       * stale -- which is all of them in an instance that has just started --
       * at random.
       *
       * Any fixed tiebreak is a session that is never chosen. Each request may
       * land on a different worker instance with an empty cache, so a rule
       * that prefers, say, the most recently started session picks the same
       * winners in every one of them, and whatever sorts last is never checked
       * by anybody. Randomising means a session that misses one request is
       * very unlikely to miss the next.
       */
      const due = open
        .filter((session) => (cache.get(session.id)?.expiresAt ?? 0) <= now())
        .map((session) => ({
          session,
          checkedAt: cache.get(session.id)?.relayCheckedAt ?? 0,
          tiebreak: random(),
        }))
        .sort((left, right) => left.checkedAt - right.checkedAt || left.tiebreak - right.tiebreak)
        .slice(0, Math.max(0, maxChecksPerBatch))
        .map((entry) => entry.session);
      await Promise.all(due.map((session) => query(session.id)));
      for (const session of open) {
        const entry = cache.get(session.id);
        answer.set(session.id, entry ? reported(entry) : { relayStatus: "unknown" });
      }
      return answer;
    },
  };
}
