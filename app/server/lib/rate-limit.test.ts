import { describe, expect, it } from "vitest";
import { callerAddress, rateLimiter } from "./rate-limit";

describe("rateLimiter", () => {
  it("allows a burst and then refuses", () => {
    const limiter = rateLimiter({ burst: 3, perSecond: 1 });
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("a", 0).ok).toBe(false);
  });

  it("says how long to wait", () => {
    const limiter = rateLimiter({ burst: 1, perSecond: 2 });
    limiter.take("a", 0);
    /* Half a token per 250ms, so a whole one is 500ms away. */
    expect(limiter.take("a", 0).retryAfterMs).toBe(500);
    expect(limiter.take("a", 250).retryAfterMs).toBe(250);
  });

  it("refills over time without exceeding the burst", () => {
    const limiter = rateLimiter({ burst: 2, perSecond: 1 });
    limiter.take("a", 0);
    limiter.take("a", 0);
    expect(limiter.take("a", 999).ok).toBe(false);
    expect(limiter.take("a", 1000).ok).toBe(true);
    /* Ten seconds of idling still only buys back the burst. */
    limiter.take("a", 11_000);
    limiter.take("a", 11_000);
    expect(limiter.take("a", 11_000).ok).toBe(false);
  });

  /*
   * A caller held at the limit keeps calling. If each refusal restarted the
   * clock, the tokens would never come back and a brief burst would become a
   * permanent ban.
   */
  it("does not push the refill further away each time it refuses", () => {
    const limiter = rateLimiter({ burst: 1, perSecond: 1 });
    limiter.take("a", 0);
    for (let at = 100; at < 1000; at += 100) expect(limiter.take("a", at).ok).toBe(false);
    expect(limiter.take("a", 1000).ok).toBe(true);
  });

  it("keeps one caller's budget away from another's", () => {
    const limiter = rateLimiter({ burst: 1, perSecond: 1 });
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("a", 0).ok).toBe(false);
    expect(limiter.take("b", 0).ok).toBe(true);
  });

  it("sustains a steady poller indefinitely", () => {
    /* An agent polls every two seconds; it must never be refused. */
    const limiter = rateLimiter({ burst: 10, perSecond: 1 });
    for (let at = 0; at < 600_000; at += 2000) {
      expect(limiter.take("agent", at).ok).toBe(true);
    }
  });

  it("releases buckets for callers that have gone quiet", () => {
    const limiter = rateLimiter({ burst: 1, perSecond: 100 });
    for (let index = 0; index < 600; index += 1) limiter.take(`caller-${index}`, index);
    /* The sweep runs on write, so the map holds far fewer than 600 by now. */
    expect(limiter.size()).toBeLessThan(600);
  });
});

describe("callerAddress", () => {
  it("uses the socket address when no proxy is trusted", () => {
    expect(callerAddress({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.1", false)).toBe("10.0.0.1");
  });

  it("reads the first hop when a proxy is trusted", () => {
    expect(callerAddress({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" }, "10.0.0.1", true)).toBe("1.2.3.4");
  });

  it("falls back to the socket when the header is absent or empty", () => {
    expect(callerAddress({}, "10.0.0.1", true)).toBe("10.0.0.1");
    expect(callerAddress({ "x-forwarded-for": "  " }, "10.0.0.1", true)).toBe("10.0.0.1");
  });

  it("has something to key on even with no address at all", () => {
    expect(callerAddress({}, undefined, false)).toBe("unknown");
  });
});
