import { useState } from "react";
import type { Member, SessionAutomationConsent, SessionRecord } from "../lib/api";
import { automationConsent, canManageAutomation } from "../lib/session-automation";

const switches: { key: keyof SessionAutomationConsent; label: string; help: string }[] = [
  {
    key: "mcpTeamAccess",
    label: "Team agent access (MCP)",
    help: "Save permission for teammates’ agents. This does not create a connection or share the browser password. Typing needs a separate control grant.",
  },
  {
    key: "dailyBriefingEnabled",
    label: "Daily briefing",
    help: "Reuse an existing agent response as a title and summary, at most once a day. No extra prompt or model call. Requires a supported, updated host and your unlocked vault; other sessions are skipped.",
  },
  {
    key: "dailyBriefingTeamAccess",
    label: "Team briefing delivery (not available yet)",
    help: "Saves your preference for future team delivery. Briefings remain visible only to you in this version.",
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
        Only you, the session owner, can change these. Changes sync with the CLI.
        New sessions use your account default; this session keeps its own settings.
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
        {busy ? "Saving…" : saved ? "Saved. The CLI uses the same settings." : "Saving permission does not start an agent or an MCP connection."}
      </p>
      {error && <p className="audience-error" role="alert">{error}</p>}
    </section>
  );
}
