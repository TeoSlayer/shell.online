import { describe, expect, it } from "vitest";
import { ago, elapsed } from "./time";

const NOW = 1_700_000_000_000;
const minutes = (count: number) => count * 60_000;

describe("ago", () => {
  it("collapses anything recent to 'just now'", () => {
    expect(ago(NOW, NOW)).toBe("just now");
    expect(ago(NOW - 60_000, NOW)).toBe("just now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(ago(NOW - minutes(5), NOW)).toBe("5m ago");
    expect(ago(NOW - minutes(90), NOW)).toBe("1h ago");
    expect(ago(NOW - minutes(60 * 26), NOW)).toBe("yesterday");
    expect(ago(NOW - minutes(60 * 24 * 4), NOW)).toBe("4d ago");
  });

  it("never renders NaN for a missing or unusable timestamp", () => {
    /* A record written before lastSeenAt existed used to print "NaNd ago". */
    for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ago(value as number | undefined, NOW)).toBe("unknown");
    }
  });

  it("does not go negative for a clock skewed into the future", () => {
    expect(ago(NOW + minutes(10), NOW)).toBe("just now");
  });
});

describe("elapsed", () => {
  it("reports seconds, minutes, hours and days", () => {
    expect(elapsed(NOW - 30_000, NOW)).toBe("30s");
    expect(elapsed(NOW - minutes(5), NOW)).toBe("5m");
    expect(elapsed(NOW - minutes(75), NOW)).toBe("1h 15m");
    expect(elapsed(NOW - minutes(60 * 25), NOW)).toBe("1d 1h");
  });

  it("never renders NaN", () => {
    expect(elapsed(undefined as unknown as number, NOW)).toBe("unknown");
    expect(elapsed(Number.NaN, NOW)).toBe("unknown");
  });

  it("does not go negative", () => {
    expect(elapsed(NOW + 10_000, NOW)).toBe("0s");
  });
});
