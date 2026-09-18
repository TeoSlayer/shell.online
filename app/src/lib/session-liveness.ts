import type { SessionRecord } from "./api";

/**
 * How long a machine may be away before its sessions are treated as over.
 *
 * The CLI's reconnect loop retries with a backoff capped at ten seconds, so a
 * host that still exists is back within seconds of its network. Ten minutes of
 * silence is therefore not a blip: the machine was rebooted, lost power, or
 * was put away. Long enough that a tunnel or a VPN reconnect never costs
 * somebody a live session; short enough that a rebooted laptop's sessions do
 * not sit in "Write" for the relay's twelve-hour retention.
 */
export const HOST_GONE_MS = 10 * 60_000;

/**
 * Whether the machine behind an open session has been away long enough to
 * call it gone.
 *
 * This is deliberately derived rather than stored. A host that comes back --
 * a laptop waking up, a network returning -- reconnects to the relay and the
 * session becomes live again on the next poll, which a written-down "finished"
 * could not undo. A persistent session is excluded because being away is its
 * whole point: it is waiting to be resumed, not lost.
 */
export function hostGone(
  session: Partial<Pick<SessionRecord, "relayStatus" | "hostLastSeenAt" | "persistent">>,
  now: number = Date.now(),
): boolean {
  if (session.relayStatus !== "disconnected") return false;
  if (session.persistent) return false;
  if (typeof session.hostLastSeenAt !== "number") return false;
  return now - session.hostLastSeenAt >= HOST_GONE_MS;
}

type LivenessFields = Partial<
  Pick<SessionRecord, "closedAt" | "relayStatus" | "hostLastSeenAt" | "persistent">
>;

/**
 * A relay 404/exited state is final, and so is a machine that stopped
 * answering long ago; disconnected remains reopenable until then.
 */
export function sessionEnded(session: LivenessFields, now: number = Date.now()): boolean {
  return (
    Boolean(session.closedAt) ||
    session.relayStatus === "exited" ||
    session.relayStatus === "missing" ||
    hostGone(session, now)
  );
}

/**
 * When an ended session ended, for "ran for" and "finished after".
 *
 * A machine that is gone never reported an exit, so there is no `closedAt` to
 * read: the last moment the relay held its host socket is the closest thing to
 * one. Reaching for `relayCheckedAt` instead -- the moment this poll happened
 * to look -- makes the run appear to grow by a minute every minute, which is
 * the one thing a finished session should never do.
 */
export function sessionEndedAt(session: LivenessFields & Pick<SessionRecord, "relayCheckedAt">, now: number = Date.now()): number {
  if (session.closedAt) return session.closedAt;
  if (hostGone(session, now)) return session.hostLastSeenAt ?? session.relayCheckedAt ?? now;
  return session.relayCheckedAt ?? now;
}

/** "Online" means the relay currently has the machine's host socket. */
export function sessionOnline(session: LivenessFields, now: number = Date.now()): boolean {
  if (sessionEnded(session, now)) return false;
  /* Compatibility with an API-only development server that has no relay configured. */
  return session.relayStatus === undefined || session.relayStatus === "connected";
}

export function sessionStateLabel(session: LivenessFields, now: number = Date.now()): string {
  if (session.closedAt || session.relayStatus === "exited") return "Finished";
  if (session.relayStatus === "missing") return "Unavailable";
  /*
   * Named for what happened rather than for what the process did, because
   * nobody reported an exit: the machine stopped answering and never came
   * back. Calling that "Finished" would claim the task completed.
   */
  if (hostGone(session, now)) return "Machine gone";
  if (session.relayStatus === "disconnected") return "Offline";
  if (session.relayStatus === "waiting") return "Starting";
  if (session.relayStatus === "unknown") return "Status unavailable";
  return "Online";
}

/**
 * Carries a known relay state across a poll that came back without one.
 *
 * The service checks a bounded number of sessions per request and answers
 * "unknown" for the rest, and its cache is per worker instance, so two polls
 * four seconds apart can disagree about a session that has not changed at all.
 * Rendering that directly is what made a card alternate between "Offline" and
 * "Status unavailable", and -- since one of those counts as ended and the
 * other does not -- jump between the Write and Finished columns.
 *
 * "unknown" means this service did not manage to look. It is never news, so it
 * never replaces something that was.
 */
export function keepKnownLiveness(
  previous: readonly SessionRecord[] | null,
  next: readonly SessionRecord[],
): SessionRecord[] {
  if (!previous?.length) return [...next];
  const before = new Map(previous.map((session) => [session.id, session]));
  return next.map((session) => {
    if (session.relayStatus !== "unknown") return session;
    const known = before.get(session.id);
    if (!known?.relayStatus || known.relayStatus === "unknown") return session;
    return {
      ...session,
      relayStatus: known.relayStatus,
      relayCheckedAt: known.relayCheckedAt,
      hostLastSeenAt: known.hostLastSeenAt,
    };
  });
}
