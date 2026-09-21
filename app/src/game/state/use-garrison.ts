import { useEffect, useRef, useState } from "react";
import { fetchSessions, request, type SessionRecord } from "../../lib/api";
import { useAuth } from "../../auth/AuthProvider";
import { readMcpFlows, type McpFlow } from "./mcp-flows";
import { keepKnownLiveness, sessionEnded } from "../../lib/session-liveness";
import { rosterFrom, type Roster } from "./sessions";
import { setRoster, type Sim } from "../world/sim";

/** The same interval the session list polls on, so the two agree. */
const POLL_MS = 4000;
/**
 * A request that has not answered in this long is treated as a failure. The
 * poll must never wedge on one hung connection: the field keeps its stand-in
 * and the panel is emptied by its own clock, not by a fetch that may never
 * return.
 */
const FETCH_TIMEOUT_MS = 10_000;

export interface GarrisonState {
  /** The account this answer belongs to. A view for another account carries no flows. */
  uid: string;
  flows: McpFlow[];
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

/** Test-tunable timing; production uses the constants above. */
export interface GarrisonTuning {
  pollMs?: number;
  fetchTimeoutMs?: number;
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
export function useGarrison(
  sim: Sim,
  standIn: Roster,
  yourClass: string,
  tuning: GarrisonTuning = {},
): GarrisonState {
  const uid = useAuth().user?.uid ?? "";
  const [state, setState] = useState<GarrisonState>(() => ({
    uid,
    loading: true,
    error: "",
    demo: false,
    heroes: 0,
    soldiers: 0,
    flows: [],
  }));
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

  const pollMs = tuning.pollMs ?? POLL_MS;
  const timeoutMs = tuning.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;

  useEffect(() => {
    let live = true;
    let pending = false;
    /*
     * A request that has not settled yet is not abandoned by starting another:
     * one hung connection must not become a pile of them.
     */
    let unsettled = 0;
    const abort = new AbortController();
    seen.current = null;
    setState(current => ({ ...current, uid, flows: [], loading: true }));

    const load = async () => {
      if (pending || unsettled > 0) return;
      pending = true;
      const controller = new AbortController();
      let timer = 0;
      const sessionsPromise = fetchSessions();
      const flowsPromise = request<{ flows: unknown }>("/api/game/mcp-flows", { signal: controller.signal })
        .catch(() => null);
      unsettled = 2;
      const settle = () => { unsettled = Math.max(0, unsettled - 1); };
      void sessionsPromise.then(settle, settle);
      void flowsPromise.then(settle, settle);
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            controller.abort();
            reject(new Error("The service did not answer in time."));
          }, timeoutMs);
        });
        /* The flow request takes the abort signal; the session list is raced, so the wait is bounded. */
        const [result, flowResult] = await Promise.race([
          Promise.all([sessionsPromise, flowsPromise]),
          timedOut,
        ]);
        if (!live) return;
        const sessions = keepKnownLiveness(seen.current, result.sessions);
        seen.current = sessions;
        const roster = rosterFrom(sessions, result.members, result.you, chosen.current);
        const demo = roster.soldiers.length === 0;
        const shown = demo ? fallback.current : roster;
        /*
         * Only a live session this account owns may be a target: a flow is
         * drawn as an arrow to a figure standing on this map, so anything the
         * map is not showing, or does not own, is not a place to point.
         */
        const allowed = new Set(
          sessions
            .filter((session) => (session.ownerUid ?? session.uid) === uid && !sessionEnded(session))
            .map((session) => session.id),
        );
        setRoster(sim, shown);
        setState({
          uid,
          loading: false,
          error: "",
          demo,
          flows: demo ? [] : readMcpFlows(flowResult?.flows, allowed, Date.now()),
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
          uid,
          loading: false,
          error: caught instanceof Error ? caught.message : "The service did not answer.",
          demo: true,
          flows: [],
          /* Unreachable is not "you have nothing standing". */
          team: undefined,
          heroes: fallback.current.heroTotal,
          soldiers: fallback.current.soldierTotal,
        });
      } finally {
        window.clearTimeout(timer);
        pending = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), pollMs);
    return () => {
      live = false;
      abort.abort();
      window.clearInterval(timer);
    };
    /*
     * Once per account. `sim` is a ref's contents and never changes identity;
     * re-running this would restart the poll and re-muster the whole field.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  /*
   * The account can change between a render and the effect that follows it.
   * Reading another account's observations, even for a frame, would be a leak;
   * so a view whose uid does not match this render's account has none.
   */
  if (state.uid !== uid) return { ...state, uid, loading: true, flows: [] };
  return state;
}
