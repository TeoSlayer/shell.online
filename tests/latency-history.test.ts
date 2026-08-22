import { describe, expect, it } from "vitest";
import {
  appendLatencySample,
  buildLatencyPlot,
  MAX_LATENCY_SAMPLES,
  parseLatencyHistory,
  summarizeLatency,
} from "../web/latency-history";

describe("latency history", () => {
  it("loads only recent, valid cached samples", () => {
    const now = 2_000_000_000_000;
    const history = parseLatencyHistory(JSON.stringify([
      { at: now - 5_000, ms: 42 },
      { at: now - 1_000, ms: 28.4 },
      { at: now - 30 * 60 * 60 * 1_000, ms: 17 },
      { at: now, ms: -1 },
      { nope: true },
    ]), now);
    expect(history).toEqual([
      { at: now - 5_000, ms: 42 },
      { at: now - 1_000, ms: 28 },
    ]);
  });

  it("keeps a bounded rolling history", () => {
    let history = [] as Array<{ at: number; ms: number }>;
    for (let index = 0; index < MAX_LATENCY_SAMPLES + 5; index += 1) {
      history = appendLatencySample(history, { at: index, ms: index + 1 });
    }
    expect(history).toHaveLength(MAX_LATENCY_SAMPLES);
    expect(history[0].ms).toBe(6);
    expect(history.at(-1)?.ms).toBe(MAX_LATENCY_SAMPLES + 5);
  });

  it("builds live graph geometry and summary values", () => {
    const samples = [
      { at: 1, ms: 20 },
      { at: 2, ms: 80 },
      { at: 3, ms: 40 },
    ];
    const plot = buildLatencyPlot(samples);
    expect(plot.linePath).toMatch(/^M/);
    expect(plot.areaPath).toMatch(/Z$/);
    expect(plot.lastY).toBeGreaterThan(6);
    expect(plot.scaleMaximum).toBe(100);
    expect(summarizeLatency(samples)).toEqual({
      current: 40,
      minimum: 20,
      average: 47,
      maximum: 80,
    });
  });
});
