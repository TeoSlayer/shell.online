import { useEffect, useState } from "react";
import { X, DownloadSimple } from "@phosphor-icons/react";
import { Button } from "./Button";
import { Alert } from "./Alert";
import { downloadAuditCsv, fetchAudit, type AuditEvent, type SessionRecord } from "../lib/api";

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  input: "entered",
  interrupt: "interrupted",
  opened: "opened",
  handoff: "handed off",
};

/** Reads the audit log for one session, and exports it. */
export function AuditDrawer({
  session,
  onClose,
}: {
  session: SessionRecord;
  onClose(): void;
}) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    fetchAudit(session.id)
      .then((result) => {
        if (!cancelled) setEvents(result.events);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load the log.");
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  async function handleExport() {
    setExporting(true);
    setError("");
    try {
      const blob = await downloadAuditCsv(session.id);
      /* Object URL so the export carries the bearer token the API needs. */
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `audit-${session.name || session.command}-${session.id.slice(0, 8)}.csv`
        .replace(/[^A-Za-z0-9._-]+/g, "-");
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Audit log">
        <header className="sheet-head">
          <div>
            <h2>Audit log</h2>
            <p className="audit-subject">{session.name || session.command}</p>
          </div>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            <X size={17} weight="bold" />
          </button>
        </header>

        <div className="sheet-body">
          {error && <Alert tone="error">{error}</Alert>}

          {events === null ? (
            <div className="sessions-skeleton" aria-hidden="true">
              <span />
              <span />
            </div>
          ) : events.length === 0 ? (
            <div className="sessions-empty">
              <p>Nothing recorded yet.</p>
              <ol>
                <li>Open this session as a tab.</li>
                <li>Type a command, or a prompt for an agent.</li>
                <li>It appears here once submitted.</li>
              </ol>
            </div>
          ) : (
            <ol className="audit-list">
              {events.map((event) => (
                <li key={event.id} className="audit-entry" data-kind={event.kind}>
                  <span className="audit-when">
                    {new Date(event.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="audit-who">{event.actorEmail}</span>
                  <span className="audit-kind">{KIND_LABEL[event.kind]}</span>
                  <code className="audit-text">{event.text || "—"}</code>
                </li>
              ))}
            </ol>
          )}

          <div className="sheet-actions">
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              type="button"
              onClick={handleExport}
              busy={exporting}
              busyLabel="Exporting"
              disabled={!events || events.length === 0}
            >
              <DownloadSimple size={15} weight="bold" />
              Export CSV
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
