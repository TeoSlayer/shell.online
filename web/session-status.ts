// Connection state is not task progress. A connected terminal may be idle.
export function sessionConnectionLabel(status: string, locked: boolean, latency: number | null): string {
  if (locked) return "Password needed";
  if (status === "connected") return latency === null ? "Connected" : `Connected · ${latency} ms`;
  if (status === "connecting") return "Connecting…";
  if (status === "waiting") return "Waiting for host";
  if (status === "full") return "Full · waiting";
  if (status === "exited") return "Session ended";
  if (status === "missing") return "Link unavailable";
  return "Reconnecting…";
}
