import { useCallback, useEffect, useState } from "react";
import { request } from "../../lib/api";

/**
 * The gathering, from the browser's side.
 *
 * The browser asks for a run and reads the account of what runs have cost. It
 * does not collect anything and it could not: sessions are end-to-end
 * encrypted and the plaintext only exists on the machine the session is running
 * on. That is the whole reason this is shaped as it is -- the agent on that
 * machine gathers and reports numbers, and this reads the bill afterwards.
 */

export interface Run {
  id: string;
  device: string;
  ranAt: number;
  tokens: number;
  pullRequests: number;
  commits: number;
  insertions: number;
  deletions: number;
  error: string;
}

interface Wire {
  id?: string;
  device?: string;
  ran_at?: number;
  tokens?: number;
  pull_requests?: number;
  commits?: number;
  insertions?: number;
  deletions?: number;
  error?: string;
}

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

function toRun(wire: Wire): Run {
  return {
    id: typeof wire.id === "string" ? wire.id : "",
    device: typeof wire.device === "string" ? wire.device : "a machine",
    ranAt: number(wire.ran_at),
    tokens: number(wire.tokens),
    pullRequests: number(wire.pull_requests),
    commits: number(wire.commits),
    insertions: number(wire.insertions),
    deletions: number(wire.deletions),
    error: typeof wire.error === "string" ? wire.error : "",
  };
}

export type Asking = "idle" | "asking" | "asked" | "failed";

export function useGathering(on: boolean): {
  runs: Run[];
  asking: Asking;
  /** Why the last attempt failed, in the service's own words. */
  refusal: string;
  /** Which machines were asked, so the answer names places rather than a count. */
  asked: string[];
  gatherNow: () => void;
  refresh: () => void;
} {
  const [runs, setRuns] = useState<Run[]>([]);
  const [asking, setAsking] = useState<Asking>("idle");
  const [refusal, setRefusal] = useState("");
  const [asked, setAsked] = useState<string[]>([]);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const reply = await request<{ runs?: Wire[] }>("/api/game/runs");
        setRuns((reply.runs ?? []).map(toRun));
      } catch {
        /* An unreadable bill is not an empty one; leave what is already shown. */
      }
    })();
  }, []);

  /* Only once there is anything to read. Nothing has run before consent. */
  useEffect(() => {
    if (on) refresh();
  }, [on, refresh]);

  const gatherNow = useCallback(() => {
    setAsking("asking");
    setRefusal("");
    void (async () => {
      try {
        const reply = await request<{ asked?: string[] }>("/api/game/gather", { method: "POST" });
        setAsked(Array.isArray(reply.asked) ? reply.asked : []);
        setAsking("asked");
        /*
         * The machines were asked, not answered. A run takes as long as it
         * takes, and the bill appears when the agent reports; this looks again
         * shortly afterwards rather than claiming anything has finished.
         */
        window.setTimeout(refresh, 4000);
      } catch (error) {
        setRefusal(error instanceof Error ? error.message : "The service did not answer.");
        setAsking("failed");
      }
    })();
  }, [refresh]);

  return { runs, asking, refusal, asked, gatherNow, refresh };
}
