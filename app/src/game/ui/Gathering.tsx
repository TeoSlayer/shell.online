import { useGathering } from "../state/gathering";
import { WORLD } from "../lore/world";

/**
 * The gathering: what it reads, what it costs, and how to stop it.
 *
 * This screen is written plainly and deliberately out of character. Everywhere
 * else the game calls tokens essence and machines outposts, because that is the
 * skin and the skin is the point. Here it does not, because somebody deciding
 * whether to let a program read their work is not playing along, and a consent
 * notice in fantasy voice is a consent notice designed not to be understood.
 *
 * Off until it is switched on, and one press turns it off again. The list below
 * is the bill: a total on its own is a number to be taken on trust, and a person
 * who has agreed to this is owed the itemised version.
 */
function when(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  const minutes = Math.round(ago / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Gathering({
  on,
  tokens,
  onAgree,
  onStop,
  onBack,
}: {
  on: boolean;
  /** The total in the vial, which is the sum of the runs below. */
  tokens: number;
  onAgree: () => void;
  onStop: () => void;
  onBack: () => void;
}) {
  const { runs, asking, refusal, asked, gatherNow } = useGathering(on);
  const now = Date.now();

  return (
    <div className="keep-gathering">
      <p className="keep-gathering-state" role="status">
        {on
          ? `Gathering is on. ${tokens.toLocaleString()} tokens spent so far.`
          : "Gathering is off. Nothing is being read."}
      </p>

      {/*
        * What is read and what is not, before the button rather than after it.
        * The second list is the one that matters, and it is second because it
        * is the reassurance: you cannot be reassured about a thing you have not
        * been told yet.
        */}
      <div className="keep-gathering-notice">
        <h3>What your machine would read</h3>
        <ul>
          <li>Git in the folder a session is running in: how many commits, and how many lines changed.</li>
          <li>How many pull requests you have open, if the GitHub CLI is installed.</li>
          <li>How many tokens your coding agent has spent, from its own local files.</li>
        </ul>

        <h3>What it never reads</h3>
        <ul>
          <li>Terminal output. Nothing that appears in a session is read, sent or stored.</li>
          <li>File contents, diffs, commit messages, branch names, prompts or replies.</li>
        </ul>

        <h3>Where it goes</h3>
        <p>
          Your machine does the reading and sends counts — numbers and nothing
          else. This service cannot read a session: they are encrypted end to
          end and it holds no key. That is why the reading happens on your
          machine rather than here.
        </p>

        <p className="keep-gathering-cost">
          Reading your agent's token totals costs nothing. Any run that spends
          tokens is listed below, to the token.
        </p>
      </div>

      <div className="keep-gathering-buttons">
        {on ? (
          <>
            <button type="button" className="keep-button" onClick={gatherNow} disabled={asking === "asking"}>
              {asking === "asking" ? "Asking…" : "Gather now"}
            </button>
            <button type="button" className="keep-button" onClick={onStop}>
              Stop gathering
            </button>
          </>
        ) : (
          <button type="button" className="keep-button" onClick={onAgree}>
            Turn gathering on
          </button>
        )}
      </div>

      {asking === "asked" && (
        <p className="keep-gathering-said" role="status">
          {asked.length > 0
            ? `Asked ${asked.join(", ")}. The bill appears when they answer.`
            : "Asked. The bill appears when a machine answers."}
        </p>
      )}
      {asking === "failed" && (
        <p className="keep-gathering-refusal" role="status">
          {refusal}
        </p>
      )}

      {on && (
        <>
          <h3 className="keep-gathering-heading">What it has cost</h3>
          {runs.length === 0 ? (
            <p className="keep-gathering-empty">
              Nothing has run yet. A machine has to be signed in with{" "}
              <code>shell agent</code> running for there to be anything to ask.
            </p>
          ) : (
            <ul className="keep-gathering-runs">
              {runs.map((run) => (
                <li key={run.id} className="keep-gathering-run">
                  <span className="keep-gathering-run-head">
                    <span className="keep-gathering-run-where">{run.device}</span>
                    <span className="keep-gathering-run-when">{when(run.ranAt, now)}</span>
                  </span>
                  {run.error ? (
                    /* A run that failed still happened, and still may have cost. */
                    <span className="keep-gathering-run-error">Failed: {run.error}</span>
                  ) : (
                    <span className="keep-gathering-run-found">
                      {run.pullRequests} open {run.pullRequests === 1 ? "PR" : "PRs"} ·{" "}
                      {run.commits} commits · +{run.insertions.toLocaleString()} −
                      {run.deletions.toLocaleString()}
                    </span>
                  )}
                  <span className="keep-gathering-run-cost">
                    {run.tokens.toLocaleString()} tokens
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="keep-gathering-foot">
            Those totals are what fills the {WORLD.essence.toLowerCase()} vial on the field.
          </p>
        </>
      )}

      <button type="button" className="keep-button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
