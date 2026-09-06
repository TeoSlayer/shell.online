import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ArrowSquareOut, Copy, Check, X, Terminal as TerminalIcon, List } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Alert } from "../components/Alert";
import { TerminalPane } from "../terminal/TerminalPane";
import { EMPTY, reduce } from "../terminal/tabs";
import { fetchSessions, type SessionRecord } from "../lib/api";
import { elapsed } from "../lib/time";

const POLL_MS = 4000;

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="session-copy"
      onClick={async (event) => {
        event.stopPropagation();
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
      {copied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
    </button>
  );
}

export function Workspace() {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
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
  const showingList = state.activeId === null;

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
      {state.tabs.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Open terminals">
          <button
            type="button"
            role="tab"
            aria-selected={showingList}
            className={showingList ? "tab is-active" : "tab"}
            onClick={() => dispatch({ type: "select", id: null })}
          >
            <List size={15} />
            All sessions
          </button>

          {state.tabs.map((tab) => (
            <span
              key={tab.id}
              className={state.activeId === tab.id ? "tab is-active" : "tab"}
            >
              <button
                type="button"
                role="tab"
                aria-selected={state.activeId === tab.id}
                className="tab-label"
                onClick={() => dispatch({ type: "select", id: tab.id })}
                title={tab.command}
              >
                <TerminalIcon size={15} />
                {tab.command}
              </button>
              <button
                type="button"
                className="tab-close"
                onClick={() => dispatch({ type: "close", id: tab.id })}
                aria-label={`Close ${tab.command}`}
              >
                <X size={13} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/*
        Every open pane stays mounted. Hiding rather than unmounting is what
        makes switching tabs instant, and keeps each socket and its scrollback
        alive while another tab is in front.
      */}
      {state.tabs.map((tab) => (
        <TerminalPane
          key={tab.id}
          shareUrl={tab.shareUrl}
          active={state.activeId === tab.id}
        />
      ))}

      <div className="workspace-list" hidden={!showingList}>
        <p className="page-dek">
          Every terminal shared from a linked machine appears here. Click one to
          open it as a tab.
        </p>

        {error && <div className="sessions-alert"><Alert tone="error">{error}</Alert></div>}

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
              <SessionGroup
                heading="Running"
                sessions={live}
                now={now}
                live
                onOpen={(session) => dispatch({ type: "open", session })}
              />
            )}
            {finished.length > 0 && (
              <SessionGroup
                heading="Finished"
                sessions={finished}
                now={now}
                live={false}
                onOpen={(session) => dispatch({ type: "open", session })}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

function SessionGroup({
  heading,
  sessions,
  now,
  live,
  onOpen,
}: {
  heading: string;
  sessions: SessionRecord[];
  now: number;
  live: boolean;
  onOpen: (session: SessionRecord) => void;
}) {
  return (
    <section className="sessions-group">
      <h2>{heading}</h2>
      <ul className="sessions-list">
        {sessions.map((session) => (
          <li
            key={session.id}
            className={live ? "session is-openable" : "session"}
            data-live={live}
          >
            {/*
              The row is the button. A finished session has nothing to attach
              to, so only a running one opens.
            */}
            <button
              type="button"
              className="session-main session-open-row"
              onClick={() => live && onOpen(session)}
              disabled={!live}
              aria-label={live ? `Open ${session.command}` : undefined}
            >
              <span className="session-command">{session.command}</span>
              <span className="session-meta">
                {session.host || "unknown host"}
                {" · "}
                {live
                  ? `up ${elapsed(session.startedAt, now)}`
                  : `ran ${elapsed(session.startedAt, session.closedAt ?? now)}`}
                {session.readOnly ? " · view only" : ""}
                {session.encrypted ? " · encrypted" : ""}
                {!live && session.exitCode !== undefined ? ` · exit ${session.exitCode}` : ""}
              </span>
            </button>
            <div className="session-actions">
              <CopyLink url={session.shareUrl} />
              <a
                className="session-open"
                href={session.shareUrl}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => event.stopPropagation()}
                title="Open in a new tab, outside the app"
              >
                <ArrowSquareOut size={15} weight="bold" />
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
