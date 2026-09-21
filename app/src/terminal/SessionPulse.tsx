import type { SessionPulse } from "./session-pulse";
import "./session-pulse.css";

const activityLabels: Record<SessionPulse["activity"], string> = {
  unobserved: "Not observed",
  output: "Output active",
  quiet: "Quiet",
};

const activityDescriptions: Record<SessionPulse["activity"], string> = {
  unobserved: "No live terminal output observed in this browser yet.",
  output: "Live terminal output was recently observed in this browser.",
  quiet: "No live terminal output was recently observed in this browser.",
};

export function sessionPulsePresentation(pulse: SessionPulse) {
  const label = activityLabels[pulse.activity];
  // Display only a fixed cue label, never text copied from terminal output.
  const allowedHints = pulse.hint?.kind === "attention"
    ? ["Context limit reported", "Input may be needed"]
    : pulse.hint?.kind === "result" ? ["Test result reported"] : [];
  const hint = pulse.hint && allowedHints.includes(pulse.hint.label) ? pulse.hint.label : null;
  const bytes = Number.isFinite(pulse.bytesSinceViewed)
    ? Math.max(0, Math.floor(pulse.bytesSinceViewed)) : 0;
  const unread = bytes > 0 ? "New output" : null;
  const description = [
    `${label}. ${activityDescriptions[pulse.activity]}`,
    "Output timing does not establish whether an agent is idle or finished.",
    hint ? `${hint}: a text pattern was observed; it does not confirm agent state.` : "",
    bytes > 0 ? `${bytes} bytes of new output since last viewed.` : "",
  ].filter(Boolean).join(" ");
  return { label, hint, unread, description };
}

/** Passive observed-output metadata. Intentionally has no live region or timer. */
export function SessionPulseBadge({ pulse, compact = false }: {
  pulse: SessionPulse;
  compact?: boolean;
}) {
  const { label, hint, unread, description } = sessionPulsePresentation(pulse);
  return (
    <span
      className={`session-pulse${compact ? " session-pulse--compact" : ""}`}
      data-activity={pulse.activity}
      role="img"
      aria-label={description}
      title={description}
    >
      <span className="session-pulse__dot" aria-hidden="true" />
      {!compact && <span className="session-pulse__label" aria-hidden="true">{label}</span>}
      {hint && <span className="session-pulse__hint" aria-hidden="true">{hint}</span>}
      {unread && (!compact || !hint) && <span className="session-pulse__unread" aria-hidden="true">{unread}</span>}
    </span>
  );
}
