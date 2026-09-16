import { AWARD, type Earned } from "../state/progress";
import { Mark, type MarkName } from "./Mark";

/**
 * The Barrow: what the finished sessions came to.
 *
 * Every soldier on the map is a session that is running. When one closes its
 * figure walks here and is taken off the field, and what it leaves behind is
 * the only thing in this game that makes a level: a count.
 *
 * So this screen is the ledger behind the experience bar, written out. It is
 * the honest answer to "where did that number come from", and the reason the
 * bar can be trusted at all -- a progress bar with no derivation behind it is a
 * progress bar you have to take on faith.
 */
export function Barrow({
  earned,
  counted,
  onBack,
}: {
  earned: Earned;
  /** False when the service did not answer. Unknown is not the same as none. */
  counted: boolean;
  onBack: () => void;
}) {
  const rows = [
    {
      mark: "finished" as MarkName,
      label: "Sessions run to the end",
      count: earned.sessions,
      each: AWARD.session,
      note: "Started, finished, and closed without an error.",
    },
    {
      mark: "elapsed" as MarkName,
      label: "Days anything was started",
      count: earned.days,
      each: AWARD.day,
      note: "Worth the most of any of these, and the only one nobody can farm.",
    },
    {
      mark: "machine" as MarkName,
      label: "Machines that answered",
      count: earned.machines,
      each: AWARD.machine,
      note: "Each outpost that has ever sent a wright.",
    },
    {
      mark: "company" as MarkName,
      label: "Faults mended",
      count: earned.mended,
      each: AWARD.mended,
      note: "Finished sessions whose name reads as fixing something.",
    },
    {
      mark: "made" as MarkName,
      label: "Things made",
      count: earned.made,
      each: AWARD.made,
      note: "Finished sessions whose name reads as building something.",
    },
  ];

  const total = rows.reduce((sum, row) => sum + row.count * row.each, 0);

  return (
    <div className="keep-barrow">
      <p className="keep-barrow-note">
        Every soldier on the field is a session that is running. When one ends,
        it walks to the Barrow. This is what they have left behind.
      </p>

      {!counted && (
        <p className="keep-barrow-unknown" role="status">
          The service did not answer, so none of this has been counted yet.
          Unknown is not the same as none.
        </p>
      )}

      <ul className="keep-barrow-rows">
        {rows.map((row) => (
          <li key={row.label} className="keep-barrow-row">
            <span className="keep-barrow-mark"><Mark name={row.mark} /></span>
            <span className="keep-barrow-text">
              <span className="keep-barrow-label">{row.label}</span>
              <span className="keep-barrow-detail">{row.note}</span>
            </span>
            <span className="keep-barrow-count">
              {row.count.toLocaleString()}
              {/* What each is worth, so the sum below can be checked by hand. */}
              <span className="keep-barrow-each">× {row.each}</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="keep-barrow-total">
        <span>Experience</span>
        <strong>{total.toLocaleString()}</strong>
      </p>

      <p className="keep-barrow-note">
        Nothing here can be earned by playing. Every figure above is something a
        session did, counted by the service from its own records — which is why
        walking your hero about the map changes none of it.
      </p>

      <button type="button" className="keep-button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
