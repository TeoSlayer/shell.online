import type { SessionLiveness } from "./session-liveness";
import type { Store } from "./store";
import type { SessionRecord } from "./types";

/**
 * Writes down a session's end when the relay reports one and the machine did
 * not.
 *
 * `closedAt` is normally set by the CLI, which PATCHes the session as its
 * process exits. A machine that is rebooted or loses power never gets to do
 * that, so nothing ever closed those rows: they stayed in the browser's
 * "Write" column for as long as the relay kept them, and every poll spent one
 * of a small number of relay checks re-asking about a process that had been
 * gone for hours. With enough of them the checks ran out before reaching the
 * sessions that were actually running, and those fell back to "unknown".
 *
 * Only the two answers that cannot be taken back are acted on:
 *
 * - `missing`  the relay has no such session. It destroys the object when the
 *   session expires and never recreates it under the same id.
 * - `exited`   the process reported an exit before it went.
 *
 * A machine that is merely away is left alone. That is `hostGone` in
 * src/lib/session-liveness.ts, which is derived on the client precisely so a
 * laptop that wakes up and reconnects becomes live again by itself.
 *
 * A persistent session that is resumed re-registers, and registration is an
 * upsert that clears `closedAt`, so nothing here is a one-way door.
 */
export function relaySaysEnded(liveness: SessionLiveness | undefined): boolean {
  return liveness?.relayStatus === "missing" || liveness?.relayStatus === "exited";
}

/**
 * Closes the sessions the relay says are over, and returns the rows as they
 * now stand so the answer to this very request already shows them finished.
 *
 * Failures are swallowed on purpose: this is bookkeeping done on the way past
 * a read, and a list of sessions is worth more than the tidying up.
 */
export async function closeEndedSessions(
  store: Store,
  sessions: readonly SessionRecord[],
  states: ReadonlyMap<string, SessionLiveness>,
  log: (message: string, error?: unknown) => void,
  now = Date.now(),
): Promise<SessionRecord[]> {
  return await Promise.all(sessions.map(async (session) => {
    if (session.closedAt) return session;
    const liveness = states.get(session.id);
    if (!relaySaysEnded(liveness)) return session;
    /*
     * When the host socket was last open is the closest thing to a time of
     * death anybody has; the moment this service noticed is only ever later.
     */
    const closedAt = liveness?.hostLastSeenAt ?? liveness?.relayCheckedAt ?? now;
    try {
      await store.patchSession(session.uid, session.id, { closedAt });
    } catch (error) {
      log("could not close a session the relay reported as ended", error);
    }
    return { ...session, closedAt };
  }));
}
