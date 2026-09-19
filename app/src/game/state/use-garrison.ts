import { useEffect, useRef, useState } from "react";
import { fetchSessions, type SessionRecord } from "../../lib/api";
import { keepKnownLiveness } from "../../lib/session-liveness";
import { rosterFrom, type Roster } from "./sessions";
import { setRoster, type Sim } from "../world/sim";

/** The same interval the session list polls on, so the two agree. */
const POLL_MS = 4000;

export interface GarrisonState {
  /** True until the first answer arrives, so nothing flashes. */
  loading: boolean;
  /** Set when the service could not be reached, shown plainly rather than hidden. */
  error: string;
  /** True when the field is showing the stand-in roster. */
  demo: boolean;
  /** How many heroes and how many soldiers are on the field. */
  heroes: number;
  soldiers: number;
  /**
   * The team's own totals, when the service answered.
   *
   * Kept apart from the two above, which are whatever is being *shown* -- and
   * what is shown, for an account with nothing running, is the example team.
   *
   * The difference matters for exactly one thing and it is the important one:
   * whether to tell somebody their kingdom is short of sessions. Reading that
   * off the example would tell a person with nothing running that everything
   * is fine, which is the opposite of true and the opposite of useful. It is
   * `undefined` when the service could not be reached, because "we do not
   * know" and "you have nothing" are not the same answer and only one of them
   * is worth washing somebody's screen red over.
   */
  team?: { heroes: number; soldiers: number };
}

/**
 * Keeps the field in step with the team and its sessions.
 *
 * Polling rather than pushing, at the same interval the session list uses, so
 * the two never disagree for long about what is running.
 *
 * All the diffing that used to be here is gone. `setRoster` is idempotent: it
 * musters what is new, dismisses what has left, and leaves everybody else
 * exactly where they were standing. Two places deciding what had changed --
 * this hook and the simulation -- was two places that could disagree, and the
 * way that showed was wrights teleporting back to the gate every four seconds,
 * which looks like a rendering bug and is a data one.
 *
 * On a machine with no sign-in, or a team with nothing running, the field falls
 * back to a stand-in and the HUD says so. An empty map is the honest picture of
 * an account with no sessions, and it is also a terrible first impression: a
 * country with nobody in it and no way to tell whether that is the point.
 */
export function useGarrison(sim: Sim, standIn: Roster, yourClass: string): GarrisonState {
  const [state, setState] = useState<GarrisonState>({
    loading: true,
    error: "",
    demo: false,
    heroes: 0,
    soldiers: 0,
  });
  /* Read by the poll without restarting it when the stand-in is rebuilt. */
  const fallback = useRef(standIn);
  fallback.current = standIn;
  /* Read by the poll without restarting it when the player changes class. */
  const chosen = useRef(yourClass);
  chosen.current = yourClass;

  /*
   * What the last poll knew, so a poll that knew less cannot undo it.
   *
   * The service checks a bounded number of sessions per request and answers
   * "unknown" for the rest, and its cache is per worker, so two polls four
   * seconds apart disagree about sessions that have not changed. The session
   * list carries the known state across that gap; without doing the same here,
   * a soldier whose session had ended would be re-mustered by the next poll
   * that failed to look, march back to the Barrow on the one after, and count
   * as a finished session every time round.
   */
  const seen = useRef<SessionRecord[] | null>(null);

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const result = await fetchSessions();
        if (!live) return;
        const sessions = keepKnownLiveness(seen.current, result.sessions);
        seen.current = sessions;
        const roster = rosterFrom(sessions, result.members, result.you, chosen.current);
        const demo = roster.soldiers.length === 0;
        const shown = demo ? fallback.current : roster;
        setRoster(sim, shown);
        setState({
          loading: false,
          error: "",
          demo,
          team: { heroes: roster.heroTotal, soldiers: roster.soldierTotal },
          /*
           * The totals, not the number of figures drawn. The field is capped so
           * a large organisation cannot exhaust a browser; the read-out is not,
           * because the read-out is the whole point of the game.
           */
          heroes: shown.heroTotal,
          soldiers: shown.soldierTotal,
        });
      } catch (caught) {
        if (!live) return;
        /*
         * A failure here is not fatal to the game. The keep is still worth
         * looking at, and saying so beats an empty screen with no explanation.
         */
        setRoster(sim, fallback.current);
        setState({
          loading: false,
          error: caught instanceof Error ? caught.message : "The service did not answer.",
          demo: true,
          /* Unreachable is not "you have nothing standing". */
          team: undefined,
          heroes: fallback.current.heroTotal,
          soldiers: fallback.current.soldierTotal,
        });
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    /*
     * Once. `sim` is a ref's contents and never changes identity; re-running
     * this would restart the poll and re-muster the whole field.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
