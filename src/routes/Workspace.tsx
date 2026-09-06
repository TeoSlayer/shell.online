import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Copy, Check, X, Terminal as TerminalIcon, List, Plus } from "@phosphor-icons/react";
import { NewSessionModal } from "../components/NewSessionModal";
import { AppShell } from "../components/AppShell";
import { Alert } from "../components/Alert";
import { TerminalPane } from "../terminal/TerminalPane";
import { EMPTY, reduce } from "../terminal/tabs";
import {
  fetchDevices,
  fetchSessions,
  startSession,
  stopSession,
  type Device,
  type SessionRecord,
} from "../lib/api";
import { elapsed } from "../lib/time";

const POLL_MS = 4000;
/* Well inside the service's 15s agent-online window, so the state stays true. */
const DEVICE_POLL_MS = 5000;
/* Long enough for the agent to poll, launch, and for the session to publish. */
const AFTER_COMMAND_MS = 1500;

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
      aria-label={copied ? "Link copied" : "Copy share link"}
      title="Copy the share link"
    >
      {copied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
    </button>
  );
}

export function Workspace() {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [machine, setMachine] = useState("");
  const [composing, setComposing] = useState(false);
  const [killing, setKilling] = useState("");
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

  /*
   * Machines are polled, not fetched once: whether an agent is listening is a
   * live fact, and a stale snapshot silently disables the Start button.
   */
  useEffect(() => {
    const loadDevices = () =>
      void fetchDevices()
        .then((result) => {
          setDevices(result.devices);
          setMachine((current) => current || result.devices[0]?.id || "");
        })
        .catch(() => setDevices([]));

    loadDevices();
    const poll = window.setInterval(loadDevices, DEVICE_POLL_MS);
    return () => window.clearInterval(poll);
  }, []);

  async function handleStart(input: { deviceId: string; command: string; name: string }) {
    setError("");
    setNotice("");
    await startSession(input.deviceId, input.command, input.name);
    /*
     * The machine has to poll, launch, and publish, so the row shows up a
     * moment later rather than on this response.
     */
    setNotice(`Starting ${input.name}. It appears here once the machine picks it up.`);
    window.setTimeout(() => void load(), AFTER_COMMAND_MS);
  }

  async function handleKill(session: SessionRecord) {
    const target = machine || devices[0]?.id;
    if (!target) return;
    setKilling(session.id);
    setError("");
    setNotice("");
    try {
      await stopSession(target, session.id);
      setNotice(`Stopping ${session.command}.`);
      window.setTimeout(() => void load(), AFTER_COMMAND_MS);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not stop that session.");
    } finally {
      setKilling("");
    }
  }

  const live = sessions?.filter((session) => !session.closedAt) ?? [];
  const finished = sessions?.filter((session) => session.closedAt) ?? [];
  const showingList = state.activeId === null;

  return (
    <AppShell
      title="Sessions"
      aside={
        <button type="button" className="new-session" onClick={() => setComposing(true)}>
          <Plus size={16} weight="bold" />
          Session
        </button>
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
            <span key={tab.id} className={state.activeId === tab.id ? "tab is-active" : "tab"}>
              <button
                type="button"
                role="tab"
                aria-selected={state.activeId === tab.id}
                className="tab-label"
                onClick={() => dispatch({ type: "select", id: tab.id })}
                title={tab.command}
              >
                <TerminalIcon size={15} />
                {tab.label}
              </button>
              <button
                type="button"
                className="tab-close"
                onClick={() => dispatch({ type: "close", id: tab.id })}
                aria-label={`Close ${tab.label}`}
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
        <TerminalPane key={tab.id} shareUrl={tab.shareUrl} active={state.activeId === tab.id} />
      ))}

      <div className="workspace-list" hidden={!showingList}>
        {notice && (
          <div className="sessions-alert">
            <Alert tone="success">{notice}</Alert>
          </div>
        )}
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
                Run <code>shell agent</code> on a linked machine.
              </li>
              <li>
                Press <b>+ Session</b> and pick what to run.
              </li>
              <li>It opens here as a tab you can type into.</li>
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
                killing={killing}
                onOpen={(session) => dispatch({ type: "open", session })}
                onKill={handleKill}
              />
            )}
            {finished.length > 0 && (
              <SessionGroup
                heading="Finished"
                sessions={finished}
                now={now}
                live={false}
                killing={killing}
                onOpen={(session) => dispatch({ type: "open", session })}
                onKill={handleKill}
              />
            )}
          </>
        )}
      </div>

      {composing && (
        <NewSessionModal
          devices={devices}
          onClose={() => setComposing(false)}
          onStart={handleStart}
        />
      )}
    </AppShell>
  );
}

function SessionGroup({
  heading,
  sessions,
  now,
  live,
  killing,
  onOpen,
  onKill,
}: {
  heading: string;
  sessions: SessionRecord[];
  now: number;
  live: boolean;
  killing: string;
  onOpen: (session: SessionRecord) => void;
  onKill: (session: SessionRecord) => void;
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
            {/* The whole row opens the session; the buttons are the same act. */}
            <button
              type="button"
              className="session-main session-open-row"
              onClick={() => live && onOpen(session)}
              disabled={!live}
              aria-label={live ? `Open ${session.command}` : undefined}
            >
              <span className="session-command">{session.name || session.command}</span>
              <span className="session-meta">
                {session.name && session.name !== session.command ? (
                  <>
                    {session.command}
                    {" · "}
                  </>
                ) : null}
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
              {live ? (
                <>
                  <button
                    type="button"
                    className="session-action is-primary"
                    onClick={() => onOpen(session)}
                  >
                    <TerminalIcon size={15} weight="bold" />
                    Open
                  </button>
                  <CopyLink url={session.shareUrl} />
                  <button
                    type="button"
                    className="session-action"
                    onClick={() => void onKill(session)}
                    disabled={killing === session.id}
                  >
                    {killing === session.id ? "Stopping" : "Stop"}
                  </button>
                </>
              ) : (
                <CopyLink url={session.shareUrl} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
