/**
 * Coarse relative time, tuned for a list a person scans rather than reads.
 *
 * A missing or unparseable timestamp returns "unknown". Rendering NaN into a
 * device list is worse than admitting the value is not there.
 */
export function ago(timestamp: number | undefined | null, now: number): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Duration of a run, in the same register as `ago`. */
export function elapsed(from: number | undefined | null, to: number): string {
  if (typeof from !== "number" || !Number.isFinite(from)) return "unknown";
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
