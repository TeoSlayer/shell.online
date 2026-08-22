export interface LatencySample {
  at: number;
  ms: number;
}

export interface LatencySummary {
  current: number | null;
  minimum: number | null;
  average: number | null;
  maximum: number | null;
}

export interface LatencyPlot {
  linePath: string;
  areaPath: string;
  lastX: number;
  lastY: number;
  scaleMaximum: number;
}

export const MAX_LATENCY_SAMPLES = 72;
export const VISIBLE_LATENCY_SAMPLES = 48;
const LATENCY_HISTORY_MAX_AGE = 24 * 60 * 60 * 1_000;

export function parseLatencyHistory(
  serialized: string | null,
  now = Date.now(),
): LatencySample[] {
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((candidate): LatencySample[] => {
        if (typeof candidate !== "object" || candidate === null) return [];
        const at = Number((candidate as { at?: unknown }).at);
        const ms = Number((candidate as { ms?: unknown }).ms);
        if (
          !Number.isFinite(at) ||
          !Number.isFinite(ms) ||
          at < now - LATENCY_HISTORY_MAX_AGE ||
          at > now + 60_000 ||
          ms < 1 ||
          ms > 60_000
        ) return [];
        return [{ at: Math.round(at), ms: Math.round(ms) }];
      })
      .sort((left, right) => left.at - right.at)
      .slice(-MAX_LATENCY_SAMPLES);
  } catch {
    return [];
  }
}

export function appendLatencySample(
  history: readonly LatencySample[],
  sample: LatencySample,
): LatencySample[] {
  return [...history, { at: Math.round(sample.at), ms: Math.round(sample.ms) }]
    .slice(-MAX_LATENCY_SAMPLES);
}

export function summarizeLatency(samples: readonly LatencySample[]): LatencySummary {
  if (samples.length === 0) {
    return { current: null, minimum: null, average: null, maximum: null };
  }
  const values = samples.map((sample) => sample.ms);
  return {
    current: values.at(-1) ?? null,
    minimum: Math.min(...values),
    average: Math.round(values.reduce((total, value) => total + value, 0) / values.length),
    maximum: Math.max(...values),
  };
}

export function buildLatencyPlot(
  samples: readonly LatencySample[],
  width = 320,
  height = 92,
  padding = 6,
): LatencyPlot {
  const visible = samples.slice(-VISIBLE_LATENCY_SAMPLES);
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const maximum = visible.reduce((value, sample) => Math.max(value, sample.ms), 0);
  const scaleMaximum = Math.max(50, Math.ceil(maximum / 25) * 25);
  if (visible.length === 0) {
    return {
      linePath: "",
      areaPath: "",
      lastX: width - padding,
      lastY: height - padding,
      scaleMaximum,
    };
  }

  const step = innerWidth / Math.max(1, VISIBLE_LATENCY_SAMPLES - 1);
  const points = visible.map((sample, index) => {
    const slotsFromEnd = visible.length - 1 - index;
    const x = width - padding - slotsFromEnd * step;
    const normalized = Math.min(1, sample.ms / scaleMaximum);
    const y = height - padding - normalized * innerHeight;
    return { x, y };
  });
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const first = points[0];
  const last = points.at(-1) ?? first;
  const areaPath = `M${first.x.toFixed(2)} ${(height - padding).toFixed(2)} ` +
    `${linePath.replace(/^M/, "L")} L${last.x.toFixed(2)} ${(height - padding).toFixed(2)} Z`;
  return {
    linePath,
    areaPath,
    lastX: last.x,
    lastY: last.y,
    scaleMaximum,
  };
}
