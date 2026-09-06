import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Copy, Check } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Alert } from "../components/Alert";
import { fetchSessions, type SessionRecord } from "../lib/api";
import { elapsed } from "../lib/time";

const POLL_MS = 4000;

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="session-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard is unavailable outside a secure context */
        }
      }}
      aria-label={copied ? "Link copied" : "Copy link"}
    >
      {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
    </button>
  );
}

export function Sessions() {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /* Keeps the poll from flashing an error over a list that is already good. */
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await fetchSessions();
      setSessions(result.sessions);
      setError("");
      loadedOnce.current = true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not load sessions.";
      if (!loadedOnce.current) setSessions([]);
      setError(message);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [load]);

  const live = sessions?.filter((session) => !session.closedAt) ?? [];
  const finished = sessions?.filter((session) => session.closedAt) ?? [];

  return (
    <AppShell
      title="Sessions"
      aside={
        live.length > 0 ? (
          <span className="topbar-count is-live">
            <i aria-hidden="true" />
            {live.length} running
          </span>
        ) : null
      }
    >
      <p className="page-dek">
        Every terminal shared from a linked machine appears here, and updates
        every few seconds.
      </p>

      {error && (
        <div className="sessions-alert">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {sessions === null ? (
        <div className="sessions-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : sessions.length === 0 ? (
        <div className="sessions-empty">
          <p>No sessions yet.</p>
          <ol>
            <li>
              Run <code>shell login</code> and approve this browser.
            </li>
            <li>
              Run <code>shell claude</code>, or any command you want to share.
            </li>
            <li>It appears here within a few seconds.</li>
          </ol>
        </div>
      ) : (
        <>
          {live.length > 0 && (
            <SessionGroup heading="Running" sessions={live} now={now} live />
          )}
          {finished.length > 0 && (
            <SessionGroup heading="Finished" sessions={finished} now={now} live={false} />
          )}
        </>
      )}

      {(sessions?.some((session) => session.encrypted && !session.closedAt) ?? false) && (
        <p className="sessions-note">
          Opening an encrypted session asks for its browser password. This page
          never sees it, which is what keeps the terminal end-to-end encrypted.
          Run <code>shell list</code> on the machine to read it.
        </p>
      )}

    </AppShell>
  );
}

function SessionGroup({
  heading,
  sessions,
  now,
  live,
}: {
  heading: string;
  sessions: SessionRecord[];
  now: number;
  live: boolean;
}) {
  return (
    <section className="sessions-group">
      <h2>{heading}</h2>
      <ul className="sessions-list">
        {sessions.map((session) => (
          <li key={session.id} className="session" data-live={live}>
            <div className="session-main">
              <code className="session-command">{session.command}</code>
              <span className="session-meta">
                {session.host || "unknown host"}
                {" · "}
                {live
                  ? `up ${elapsed(session.startedAt, now)}`
                  : `ran ${elapsed(session.startedAt, session.closedAt ?? now)}`}
                {session.readOnly ? " · view only" : ""}
                {session.encrypted ? " · encrypted" : ""}
                {!live && session.exitCode !== undefined
                  ? ` · exit ${session.exitCode}`
                  : ""}
              </span>
            </div>
            <div className="session-actions">
              <CopyLink url={session.shareUrl} />
              <a
                className="session-open"
                href={session.shareUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open
                <ArrowSquareOut size={13} weight="bold" />
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
