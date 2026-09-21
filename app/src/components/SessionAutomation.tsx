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
    label: "Use existing responses for a daily briefing",
    help: "At most once a day, a supported host can save an encrypted title and excerpt from its explicitly resumed launch conversation. No new prompt or model call. This version delivers only to your unlocked vault; unsupported sessions are skipped.",
  },
  {
    key: "dailyBriefingTeamAccess",
    label: "Share briefings with the whole team",
    help: "A separate opt-in for future team delivery. This version keeps extracted titles and responses owner-only, even when this preference is saved.",
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
        Each session saves its own choice; new ones start from your account
        default (set in the shell CLI), so a session can sit on either side of it.
        Only you, the owner, can change these. Enabling passive briefings lets a
        compatible host publish existing material; it never starts an MCP connection or wakes an agent.
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
        {busy ? "Saving permission…" : saved ? "Permission saved. A compatible running host and an unlocked vault are needed to display content." : "Passive briefings require an updated compatible host. Team MCP connection and team briefing delivery are not enabled by saving these preferences."}
      </p>
      {error && <p className="audience-error" role="alert">{error}</p>}
    </section>
  );
}
