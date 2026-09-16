import { useEffect, useRef, useState } from "react";
import { fetchSessions } from "../../lib/api";
import { difference, garrisonFrom, type Muster } from "./sessions";
import { muster, type Sim } from "../world/sim";

/** The same interval the session list polls on, so the two agree. */
const POLL_MS = 4000;

export interface GarrisonState {
  /** True until the first answer arrives, so nothing flashes. */
  loading: boolean;
  /** Set when the service could not be reached, shown plainly rather than hidden. */
  error: string;
  /** True when the field is showing the stand-in garrison. */
  demo: boolean;
  count: number;
}

/**
 * Keeps the field in step with the account's real sessions.
 *
 * Polling rather than pushing, at the same interval the session list uses, so
 * the two never disagree for long about what is running.
 *
 * What it does *not* do is rebuild the world. Wrights already on the field
 * keep walking; new sessions march in through the gate and finished ones go
 * home. Replacing the garrison on every poll would teleport everybody back to
 * the gate every four seconds, which is the sort of thing that looks like a
 * rendering bug and is actually a data one.
 *
 * On a machine with no sign-in, or an account with nothing running, the field
 * falls back to the stand-in garrison and the HUD says so. An empty keep is
 * the honest picture of an account with no sessions, and it is also a terrible
 * first impression: a walled yard with nobody in it and no way to tell whether
 * that is the point or a fault.
 */
export function useGarrison(sim: Sim, demoGarrison: Muster[]): GarrisonState {
  const [state, setState] = useState<GarrisonState>({
    loading: true,
    error: "",
    demo: false,
    count: 0,
  });
  /* Whether the stand-in garrison is currently on the field. */
  const showingDemo = useRef(false);

  useEffect(() => {
    let live = true;

    const apply = (wanted: Muster[], demo: boolean) => {
      /*
       * Swapping between the real garrison and the stand-in clears the field
       * first. Diffing across that boundary would leave demo wrights standing
       * among real ones, which is worse than either.
       */
      const sessions = sim.actors.filter((actor) => actor.session !== undefined);
      if (demo !== showingDemo.current) {
        const ids = new Set(sessions.map((actor) => actor.id));
        sim.actors = sim.actors.filter((actor) => !ids.has(actor.id));
        showingDemo.current = demo;
      }
      const present = sim.actors.filter((actor) => actor.session !== undefined);
      const { arrived, left } = difference(present, wanted);
      const going = new Set(left);
      sim.actors = sim.actors.filter((actor) => !going.has(actor.id));
      for (const entry of arrived) muster(sim, entry);
    };

    const load = async () => {
      try {
        const result = await fetchSessions();
        if (!live) return;
        const wanted = garrisonFrom(result.sessions);
        const demo = wanted.length === 0;
        apply(demo ? demoGarrison : wanted, demo);
        setState({ loading: false, error: "", demo, count: wanted.length });
      } catch (caught) {
        if (!live) return;
        /*
         * A failure here is not fatal to the game. The keep is still worth
         * looking at, so the stand-in garrison takes the field and the HUD
         * carries the reason rather than a blank screen.
         */
        apply(demoGarrison, true);
        setState({
          loading: false,
          error: caught instanceof Error ? caught.message : "Could not reach shell.online.",
          demo: true,
          count: 0,
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
     * Once. The world is a ref held by the route and the stand-in garrison is
     * a constant; re-running this would restart the poll and re-muster
     * everybody.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
