import { kindForCommand } from "../../lib/session-kinds";
import type { SessionRecord } from "../../lib/api";
import { workFor, type Work } from "../world/work";

export { workFor };
export type { Work };

/**
 * Turning real sessions into a garrison.
 *
 * This is the seam where the game stops being a toy: the wrights on the field
 * are the sessions in the account, their class is the harness that session is
 * running, and what they are doing is read from what the session is called.
 *
 * `kindForCommand` is reused rather than reimplemented. It already knows that
 * `claude --resume abc` is Claude Code and that `npm run claude-thing` is not,
 * including how to see through the `sh -c` wrapper a browser-started session
 * arrives in. A second copy of that knowledge here would drift from it and the
 * game would start disagreeing with the session list about what things are.
 */

export interface Muster {
  id: string;
  name: string;
  kind: string;
  work: Work;
  /**
   * The facts the inspection panel shows when a wright is clicked.
   *
   * Carried through rather than looked up again later: by the time somebody
   * clicks a figure on the map, the session list may have been polled a dozen
   * times, and the answer should be about the session this wright *is*.
   */
  session: { id: string; startedAt: number; host: string; command: string };
}

/** Whether a session should be on the field at all. */
export function isOnTheField(session: SessionRecord): boolean {
  /* Finished sessions have gone home. The Chronicle remembers them. */
  return !session.closedAt;
}

/**
 * The garrison, from the session list.
 *
 * Sorted by when they started, so the field does not reshuffle every time the
 * list is polled and somebody's position jumps for no reason.
 */
export function garrisonFrom(sessions: SessionRecord[]): Muster[] {
  return sessions
    .filter(isOnTheField)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((session) => {
      const label = session.name || session.command;
      return {
        id: session.id,
        name: label,
        kind: kindForCommand(session.command).id,
        work: workFor(`${session.name ?? ""} ${session.command}`),
        session: {
          id: session.id,
          startedAt: session.startedAt,
          host: session.host,
          command: session.command,
        },
      };
    });
}

/**
 * What changed between one garrison and the next.
 *
 * The field is not rebuilt when the session list is polled; wrights that are
 * still there keep walking, new ones march in through the gate, and finished
 * ones leave. Rebuilding would teleport everybody to the gate every four
 * seconds, which is what the poll interval is.
 */
export function difference(
  present: { id: string }[],
  wanted: Muster[],
): { arrived: Muster[]; left: string[] } {
  const here = new Set(present.map((wright) => wright.id));
  const should = new Set(wanted.map((entry) => entry.id));
  return {
    arrived: wanted.filter((entry) => !here.has(entry.id)),
    left: present.filter((wright) => !should.has(wright.id)).map((wright) => wright.id),
  };
}
