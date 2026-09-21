import { useState } from "react";
import {
  ASSESSMENT_LABELS,
  assessmentLabelText,
  sourceAgeLabel,
  type AssessmentFeed,
} from "../state/assessments";

/**
 * Optional external analysis: the owner's consent and the advisory labels it
 * produces.
 *
 * This is the fourth, explicitly inferred layer. It cannot overwrite an
 * observed fact, it sends no input, and it names no action: the only thing a
 * person can do here is ask for an assessment of a session the feed has
 * already shown, or withdraw consent. When the deployment has no secret, or
 * consent is off, the panel says exactly that instead of pretending.
 *
 * The assessment request carries metadata only — bounded counts of observed
 * fl-ow outcomes, no pane text — and the label says so. A pane excerpt is
 * only ever sent from the pane itself, where the owner has already disclosed
 * it, never from here.
 */
export function AssessPanel({
  feed,
  targets,
  busy,
  error,
  now,
  onConsent,
  onAssess,
}: {
  feed: AssessmentFeed;
  targets: readonly { sessionId: string; flows: number }[];
  busy: boolean;
  error: string;
  now: number;
  onConsent: (enabled: boolean) => void;
  onAssess: (sessionId: string, observed: { flows: number }) => void;
}) {
  const [selected, setSelected] = useState("");
  const target = targets.find((entry) => entry.sessionId === selected) ?? targets[0];
  const available = feed.configured && feed.consent && Boolean(target) && !busy;

  let unavailable = "";
  if (!feed.configured) unavailable = "Assessment unavailable: no server-side analysis key is configured.";
  else if (!feed.consent) unavailable = "Assessment unavailable: external analysis is off for this account.";
  else if (!target) unavailable = "Assessment unavailable: no observed session to assess yet.";
  else if (busy) unavailable = "Assessment request in flight…";

  return (
    <details className="keep-assess" data-configured={feed.configured ? "true" : "false"}>
      <summary>
        <span className="keep-assess-title">External analysis</span>
        <span className="keep-assess-state" role="status">
          {feed.configured ? (feed.consent ? "on · inferred labels" : "off") : "unavailable"}
        </span>
      </summary>

      <label className="keep-assess-consent">
        <input
          type="checkbox"
          checked={feed.consent}
          onChange={(event) => onConsent(event.target.checked)}
        />
        <span>Allow external analysis of this account&apos;s selected sessions</span>
      </label>

      <div className="keep-assess-target">
        <select
          aria-label="Observed session to assess"
          value={target?.sessionId ?? ""}
          disabled={targets.length === 0}
          onChange={(event) => setSelected(event.target.value)}
        >
          {targets.length === 0 && <option value="">no observed session</option>}
          {targets.map((entry) => (
            <option key={entry.sessionId} value={entry.sessionId}>
              {entry.sessionId}
            </option>
          ))}
        </select>
        <button type="button" disabled={!available} onClick={() => target && onAssess(target.sessionId, { flows: target.flows })}>
          Request assessment
        </button>
      </div>

      <p className="keep-assess-note">
        Metadata only: bounded counts from observed requests, no pane text. Advisory model inference, never
        verified, never a completion claim, and it cannot send input or change an observed outcome.
      </p>
      {unavailable && <p className="keep-assess-unavailable">{unavailable}</p>}
      {error && <p className="keep-assess-error">{error}</p>}

      {feed.assessments.length > 0 && (
        <ul className="keep-assess-list">
          {feed.assessments.map((row) => (
            <li key={row.sessionId} data-session={row.sessionId}>
              <span className="keep-assess-session">{row.sessionId}</span>
              {ASSESSMENT_LABELS.filter((label) => row.labels.includes(label)).map((label) => (
                <span key={label} className="keep-assess-chip" data-label={label}>
                  {assessmentLabelText(label)}
                </span>
              ))}
              <span className="keep-assess-age">{sourceAgeLabel(row, now)}</span>
              <span className="keep-assess-inferred">inferred · not verified</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
