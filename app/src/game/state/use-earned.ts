import { useEffect, useState } from "react";
import { request } from "../../lib/api";
import { NOTHING_EARNED, type Earned } from "./progress";

/**
 * What the account has actually earned, asked of the service.
 *
 * The one number in the game that matters is computed where it cannot be
 * argued with. `server/lib/game-stats.ts` counts the caller's own sessions --
 * how many finished, on how many days, from how many machines -- and this
 * fetches the answer. The browser does not add anything up, because a browser
 * that added this up could tell you it had earned whatever it liked.
 *
 * It fails soft, to nothing earned. A keep that will not open because the
 * service is unreachable is worse than a keep that opens at level one and
 * fills in a moment later.
 */

interface Wire {
  sessions?: number;
  days?: number;
  machines?: number;
  mended?: number;
  made?: number;
}

/** Narrowed on the way in, exactly as everything else crossing this line is. */
function toEarned(wire: Wire | undefined): Earned {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return {
    sessions: count(wire?.sessions),
    days: count(wire?.days),
    machines: count(wire?.machines),
    mended: count(wire?.mended),
    made: count(wire?.made),
  };
}

/**
 * Asked for once on arrival, and again on a slow beat.
 *
 * Slow because none of this moves quickly: a session has to finish before any
 * of these numbers change, and polling a ladder every second to watch it not
 * move is a request per second spent on nothing.
 */
const EVERY = 60_000;

export function useEarned(): { earned: Earned; known: boolean } {
  const [earned, setEarned] = useState<Earned>(NOTHING_EARNED);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let stopped = false;

    const ask = async () => {
      try {
        const reply = await request<{ stats?: Wire }>("/api/game/stats");
        if (stopped) return;
        setEarned(toEarned(reply.stats));
        setKnown(true);
      } catch {
        /* Unreachable is not zero; it is unknown, and the HUD says so. */
        if (!stopped) setKnown(false);
      }
    };

    void ask();
    const timer = window.setInterval(() => void ask(), EVERY);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return { earned, known };
}
