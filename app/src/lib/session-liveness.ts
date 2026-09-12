import type { SessionRecord } from "./api";

/** A relay 404/exited state is final; disconnected remains reopenable. */
export function sessionEnded(session: Pick<SessionRecord, "closedAt" | "relayStatus">): boolean {
  return Boolean(session.closedAt) || session.relayStatus === "exited" || session.relayStatus === "missing";
}

/** "Online" means the relay currently has the machine's host socket. */
export function sessionOnline(session: Pick<SessionRecord, "closedAt" | "relayStatus">): boolean {
  if (sessionEnded(session)) return false;
  /* Compatibility with an API-only development server that has no relay configured. */
  return session.relayStatus === undefined || session.relayStatus === "connected";
}

export function sessionStateLabel(session: Pick<SessionRecord, "closedAt" | "relayStatus">): string {
  if (session.closedAt || session.relayStatus === "exited") return "Finished";
  if (session.relayStatus === "missing") return "Unavailable";
  if (session.relayStatus === "disconnected") return "Offline";
  if (session.relayStatus === "waiting") return "Starting";
  if (session.relayStatus === "unknown") return "Status unavailable";
  return "Online";
}
