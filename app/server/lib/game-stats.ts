import { workFor } from "../../src/game/world/work";
import type { SessionRecord } from "./types";

/**
 * What a level is worth, counted from sessions the service already stores.
 *
 * This is tier one of the stats the game runs on, and it is the whole reason
 * the game is honest: every number below is a fact about work that happened,
 * counted here rather than reported by the browser. Before this existed the
 * experience bar was fed by the *simulation* — faults put down by figures on
 * the map — which meant a tab left open overnight levelled you up. That is the
 * opposite of what the game is for, and the comment at the top of
 * state/progress.ts had been claiming otherwise for some time.
 *
 * Nothing here reads a session's contents. Sessions are end-to-end encrypted
 * and the service could not read them if it wanted to; these are counts of
 * rows, and the names people gave their own sessions. Anything richer — pull
 * requests opened, lines changed, tokens spent — has to be gathered on the
 * machine where the plaintext already is, which is tier two and is announced
 * to the operator before it happens.
 *
 * It lives in `server/lib` and reaches into `src/game/world/work.ts` for the
 * one thing both sides must agree on. That module has no imports of its own
 * for exactly this reason: the field draws a wright walking to the garrison
 * its work belongs to, and this counts the same sessions, and two copies of
 * those patterns would drift until the map and the ladder disagreed.
 */
export interface GameStats {
  /** Sessions that ran and ended cleanly. */
  sessions: number;
  /** Distinct days on which anything at all was started. */
  days: number;
  /** Distinct machines that have answered the muster. */
  machines: number;
  /** Sessions that read as fixing something, and finished. */
  mended: number;
  /** Sessions that read as making something, and finished. */
  made: number;
  /** Every session on record, finished or not, for the roster line. */
  started: number;
}

export const NO_STATS: GameStats = {
  sessions: 0,
  days: 0,
  machines: 0,
  mended: 0,
  made: 0,
  started: 0,
};

/**
 * A session counts as finished when it closed without an error.
 *
 * A session still running has not earned anything yet -- that is the open loop
 * the field is drawing -- and one that ended badly is not work that reached
 * completion. An older record with no exit code at all is treated as finished
 * if it closed, because that is all the service knows about it and refusing to
 * count it would quietly rewrite somebody's history.
 */
function finished(session: SessionRecord): boolean {
  if (session.closedAt === undefined) return false;
  return session.exitCode === undefined || session.exitCode === 0;
}

/** The day a moment falls on, in UTC, as a key to count distinct ones. */
function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function deriveStats(sessions: SessionRecord[]): GameStats {
  const days = new Set<string>();
  const machines = new Set<string>();
  const stats: GameStats = { ...NO_STATS };

  for (const session of sessions) {
    stats.started += 1;
    if (Number.isFinite(session.startedAt)) days.add(dayOf(session.startedAt));
    if (session.host) machines.add(session.host);

    if (!finished(session)) continue;
    stats.sessions += 1;

    /*
     * The name if there is one, and the command if there is not -- which is
     * the same rule the session list uses to decide what to print, so the
     * garrison a session is counted towards is the garrison you can see it
     * walking to.
     */
    const work = workFor(session.name || session.command || "");
    if (work === "bug") stats.mended += 1;
    if (work === "feature") stats.made += 1;
  }

  stats.days = days.size;
  stats.machines = machines.size;
  return stats;
}
