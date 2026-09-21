import { useState } from "react";
import type { Member, SessionAutomationConsent, SessionRecord } from "../lib/api";
import { automationConsent, canManageAutomation } from "../lib/session-automation";

const switches: { key: keyof SessionAutomationConsent; label: string; help: string }[] = [
  {
    key: "mcpTeamAccess",
    label: "Allow team-wide MCP access",
    help: "Opt this session into access by authenticated teammates. Terminal input still requires a separate control grant; the browser password is not shared by this switch.",
  },
  {
    key: "dailyBriefingEnabled",
    label: "Ask this agent for a daily briefing",
    help: "At most once a day, ask the existing running agent for a title and summary, only when its adapter can safely confirm it is idle. Unsupported or busy agents are skipped.",
  },
  {
    key: "dailyBriefingTeamAccess",
    label: "Share briefings with the whole team",
    help: "A separate opt-in to broaden the briefing audience. Leaving this off keeps briefings within the approved session content audience, not everyone who can see its listing.",
  },
];

/** Consent is intentionally distinct from connection readiness and live activity. */
export function SessionAutomation({ session, you, onChange }: {
  session: SessionRecord;
  you: Member | null;
  onChange: (changes: Partial<SessionAutomationConsent>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  if (!canManageAutomation(session, you)) return null;
  const consent = automationConsent(session);

  async function change(key: keyof SessionAutomationConsent, value: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await onChange({ [key]: value });
      setSaved(true);
    } catch {
      // An upstream exception can contain a URL or credential. Keep the display fixed.
      setError("Could not save this permission. Check the current setting and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="session-automation" aria-label="Agent permissions">
      <h2 className="detail-heading">Agent permissions</h2>
      <p className="detail-empty">
        Off by default. Only you, the session owner, can change these permissions.
        Saving permission does not mean an MCP connection or a briefing is running.
      </p>
      <fieldset disabled={busy} aria-busy={busy}>
        <legend className="visually-hidden">Owner consent</legend>
        {switches.map(({ key, label, help }) => (
          <label className="session-automation-switch" key={key}>
            <input type="checkbox" checked={consent[key]}
              onChange={(event) => void change(key, event.target.checked)} />
            <span><strong>{label}</strong><span className="session-automation-help">{help}</span></span>
          </label>
        ))}
      </fieldset>
      <p className="session-automation-status" role="status">
        {busy ? "Saving permission…" : saved ? "Permission saved. Connection and agent readiness are checked separately." : "Connection and briefing execution are not available in this build yet."}
      </p>
      {error && <p className="audience-error" role="alert">{error}</p>}
    </section>
  );
}
