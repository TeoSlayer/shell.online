/**
 * A token bucket per caller.
 *
 * A bucket holds `burst` tokens and refills at `perSecond`. That shape suits
 * this service: an agent polls steadily and must never be refused, while a
 * script guessing authorization codes hits a wall within a second. A fixed
 * window would let twice the limit through across a window boundary, and the
 * caller it would refuse is the well-behaved one that happened to start late.
 *
 * State is per instance. Two instances behind a load balancer therefore allow
 * up to twice the limit between them, which is the right trade for a limiter
 * whose job is to blunt abuse rather than to meter billing -- the alternative
 * is a round trip to shared storage on every request, including the ones the
 * limiter exists to keep cheap.
 */
export interface Decision {
  ok: boolean;
  /** How long the caller should wait, in milliseconds. Zero when allowed. */
  retryAfterMs: number;
}

export interface Bucket {
  burst: number;
  perSecond: number;
}

export interface RateLimiter {
  take(key: string, now?: number): Decision;
  /** Number of buckets held. Exposed so a test can prove they are released. */
  size(): number;
}

interface Entry {
  tokens: number;
  updatedAt: number;
}

/*
 * Buckets are dropped once they have refilled, since a full bucket is
 * indistinguishable from one that never existed. Sweeping on write keeps the
 * map proportional to callers currently in flight rather than to every caller
 * ever seen, without a timer that would hold the process open.
 */
const SWEEP_EVERY = 512;

export function rateLimiter(bucket: Bucket): RateLimiter {
  const entries = new Map<string, Entry>();
  let writes = 0;

  function sweep(now: number): void {
    const fullAfterMs = (bucket.burst / bucket.perSecond) * 1000;
    for (const [key, entry] of entries) {
      if (now - entry.updatedAt >= fullAfterMs) entries.delete(key);
    }
  }

  return {
    take(key: string, now = Date.now()): Decision {
      const entry = entries.get(key) ?? { tokens: bucket.burst, updatedAt: now };
      const refilled = ((now - entry.updatedAt) / 1000) * bucket.perSecond;
      const tokens = Math.min(bucket.burst, entry.tokens + refilled);

      if (tokens < 1) {
        /*
         * The entry is left as it was. Rewriting it would restart the clock on
         * every refusal, and a caller held at the limit keeps calling -- so the
         * refill would be computed from a hundred small steps whose rounding
         * never quite reaches a whole token, turning a brief burst into a
         * permanent ban.
         */
        return { ok: false, retryAfterMs: Math.ceil(((1 - tokens) / bucket.perSecond) * 1000) };
      }

      entries.set(key, { tokens: tokens - 1, updatedAt: now });
      writes += 1;
      if (writes % SWEEP_EVERY === 0) sweep(now);
      return { ok: true, retryAfterMs: 0 };
    },
    size: () => entries.size,
  };
}

/**
 * The address to hold responsible for a request.
 *
 * `X-Forwarded-For` is a request header like any other: anyone can send one.
 * It is read only when the deployment says it sits behind a proxy that
 * rewrites it, because trusting it otherwise would let a caller pick a new
 * identity per request and walk straight past the limiter.
 */
export function callerAddress(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socketAddress ?? "unknown";
}
