import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Copy, Check, X, Terminal as TerminalIcon, List, Plus, ClockCounterClockwise } from "@phosphor-icons/react";
import { NewSessionModal } from "../components/NewSessionModal";
import { AuditDrawer } from "../components/AuditDrawer";
import { AppShell } from "../components/AppShell";
import { Alert } from "../components/Alert";
import { TerminalPane } from "../terminal/TerminalPane";
import { EMPTY, reduce } from "../terminal/tabs";
import {
  fetchDevices,
  fetchSessions,
  startSession,
  stopSession,
  assignSession,
  type Device,
  type Member,
  type SessionRecord,
} from "../lib/api";
import { generatePassword, sealPassword } from "../lib/seal";
import { adoptOrigin, rememberForOrigin } from "../lib/session-passwords";
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
  const [members, setMembers] = useState<Member[]>([]);
  const [you, setYou] = useState<Member | null>(null);
  const [auditing, setAuditing] = useState<SessionRecord | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await fetchSessions();
      /* A session that came from this browser inherits the password it chose. */
      for (const session of result.sessions) adoptOrigin(session.origin, session.id);
      setSessions(result.sessions);
      setMembers(result.members ?? []);
      setYou(result.you ?? null);
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

    /*
     * Choose the password here and seal it to the machine. The service relays
     * an envelope it cannot open, and this browser keeps the only other copy,
     * so a session started here opens without asking for something the person
     * who started it was never shown.
     */
    const device = devices.find((candidate) => candidate.id === input.deviceId);
    let sealed: { senderPublicKey: string; sealedPassword: string } | undefined;
    let password = "";
    if (device?.agentPublicKey) {
      password = generatePassword();
      sealed = await sealPassword(device.agentPublicKey, password);
    }

    const queued = await startSession({ ...input, ...sealed });
    if (password) rememberForOrigin(queued.command.id, password);
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

  async function handleAssign(session: SessionRecord, uid: string) {
    setError("");
    setNotice("");
    try {
      await assignSession(session.id, uid);
      const to = members.find((member) => member.uid === uid);
      setNotice(`${session.name || session.command} is now assigned to ${to?.email ?? "them"}.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not hand it off.");
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
      {state.tabs.length > 0 && (
        <div className="panes" hidden={showingList}>
          {state.tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              shareUrl={tab.shareUrl}
              active={state.activeId === tab.id}
            />
          ))}
        </div>
      )}

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
                members={members}
                you={you}
                onOpen={(session) => dispatch({ type: "open", session })}
                onKill={handleKill}
                onAssign={handleAssign}
                onAudit={setAuditing}
              />
            )}
            {finished.length > 0 && (
              <SessionGroup
                heading="Finished"
                sessions={finished}
                now={now}
                live={false}
                killing={killing}
                members={members}
                you={you}
                onOpen={(session) => dispatch({ type: "open", session })}
                onKill={handleKill}
                onAssign={handleAssign}
                onAudit={setAuditing}
              />
            )}
          </>
        )}
      </div>

      {auditing && (
        <AuditDrawer session={auditing} onClose={() => setAuditing(null)} />
      )}

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

/** Who owns a session and who it is assigned to, when that is worth saying. */
function describePeople(
  session: SessionRecord,
  members: Member[],
  you: Member | null,
): string {
  const nameOf = (uid?: string) => {
    if (!uid) return "";
    if (uid === you?.uid) return "you";
    const member = members.find((entry) => entry.uid === uid);
    return member?.name?.split(/\s+/)[0] || member?.email || "someone";
  };

  const owner = nameOf(session.ownerUid);
  const assignee = nameOf(session.assigneeUid);
  if (!owner) return "";
  if (assignee && assignee !== owner) return `${owner} → ${assignee} · `;
  return `${owner} · `;
}

function canHandOff(session: SessionRecord, you: Member | null): boolean {
  if (!you) return false;
  return session.ownerUid === you.uid || you.role === "owner" || you.role === "admin";
}

function SessionGroup({
  heading,
  sessions,
  now,
  live,
  killing,
  members,
  you,
  onOpen,
  onKill,
  onAssign,
  onAudit,
}: {
  heading: string;
  sessions: SessionRecord[];
  now: number;
  live: boolean;
  killing: string;
  members: Member[];
  you: Member | null;
  onOpen: (session: SessionRecord) => void;
  onKill: (session: SessionRecord) => void;
  onAssign: (session: SessionRecord, uid: string) => void;
  onAudit: (session: SessionRecord) => void;
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
                {describePeople(session, members, you)}
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
              <button
                type="button"
                className="session-copy"
                title="Audit log"
                aria-label={`Audit log for ${session.name || session.command}`}
                onClick={() => onAudit(session)}
              >
                <ClockCounterClockwise size={15} />
              </button>
              {live && members.length > 1 && canHandOff(session, you) && (
                <select
                  className="launcher-machine"
                  value={session.assigneeUid ?? ""}
                  onChange={(event) => onAssign(session, event.target.value)}
                  aria-label={`Assign ${session.name || session.command}`}
                  title="Hand this session to someone"
                >
                  {members.map((member) => (
                    <option key={member.uid} value={member.uid}>
                      {member.uid === you?.uid ? "me" : member.email}
                    </option>
                  ))}
                </select>
              )}
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
