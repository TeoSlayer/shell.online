import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { X, Trash, Terminal as TerminalIcon, List, Plus, CaretRight, MagnifyingGlass, Rows, Columns } from "@phosphor-icons/react";
import { Link, useSearchParams } from "react-router-dom";
import { PersonChip } from "../components/Avatar";
import { PersonPicker } from "../components/PersonPicker";
import { findPerson } from "../lib/people";
import { kindForCommand } from "../lib/session-kinds";
import { canEdit, canHandOff, canRemove, canStop, matches } from "../lib/session-view";
import { NewSessionModal } from "../components/NewSessionModal";
import { SessionBoard } from "../components/SessionBoard";
import { SessionClipboard } from "../components/SessionClipboard";
import { SignedInModal } from "../components/SignedInModal";
import { AppShell } from "../components/AppShell";
import { Alert } from "../components/Alert";
import { TerminalPane } from "../terminal/TerminalPane";
import { EMPTY, reduce } from "../terminal/tabs";
import {
  assignSession,
  deleteSession,
  fetchDevices,
  fetchSessions,
  startSession,
  stopSession,
  type Device,
  type Member,
  type SessionRecord,
} from "../lib/api";
import { generatePassword, sealPassword } from "../lib/seal";
import { publicKey, sealForMembers } from "../lib/keypair";
import { fetchOrg, shareSessionKeys } from "../lib/api";
import { adoptOrigin, forget, passwordFor, rememberFor, rememberForOrigin } from "../lib/session-passwords";
import { elapsed } from "../lib/time";
import { usePageTitle } from "../lib/page-title";
import { wasJustLinked, withoutLinkedFlag } from "../lib/linked";

const POLL_MS = 4000;
/* Well inside the service's 15s agent-online window, so the state stays true. */
const DEVICE_POLL_MS = 5000;
/* Long enough for the agent to poll, launch, and for the session to publish. */
const AFTER_COMMAND_MS = 1500;

/*
 * Removes a session from the lists. Asks first, because it cannot be undone
 * and the row is the only place the session appears.
 *
 * It does not touch the machine. Whatever the session wrote is still there,
 * and the audit trail keeps the record of the removal.
 */
function RemoveSession({
  session,
  onRemove,
  busy,
}: {
  session: SessionRecord;
  onRemove: (session: SessionRecord) => void;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (confirming) {
    return (
      <button
        type="button"
        className="session-action is-destructive"
        onClick={() => onRemove(session)}
        disabled={busy}
      >
        {busy ? "Removing" : "Remove?"}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="session-copy"
      onClick={() => setConfirming(true)}
      disabled={busy}
      aria-label={`Remove ${session.name || session.command} from the list`}
      title="Remove from the list. The machine is not touched."
    >
      <Trash size={15} />
    </button>
  );
}

type ViewMode = "list" | "board";

const VIEW_KEY = "shell.online:sessions:view";

/* Remembered per browser. Which shape suits you is not worth re-choosing. */
function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

function writeViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* a private window simply forgets the choice */
  }
}

export function Workspace() {
  usePageTitle("Sessions");
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [composing, setComposing] = useState(false);
  const [killing, setKilling] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [removing, setRemoving] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [you, setYou] = useState<Member | null>(null);
  /*
   * `shell login` redirects here with ?linked=1 once the CLI has its code, so
   * the confirmation lands on the page the terminal's sessions appear on.
   */
  const [search, setSearch] = useSearchParams();
  const [justLinked, setJustLinked] = useState(() => wasJustLinked(search));
  const loadedOnce = useRef(false);
  /* Passwords waiting for their session to appear so they can be shared. */
  const pendingShares = useRef(new Map<string, string>());
  /* Who each session has already been shared with, so polling is not chatty. */
  const sharedWith = useRef(new Map<string, Set<string>>());

  /*
   * The parameter is dropped as soon as it is read, so a reload or a shared
   * link does not announce a sign-in that did not just happen.
   */
  useEffect(() => {
    if (!wasJustLinked(search)) return;
    setSearch(withoutLinkedFlag(search), { replace: true });
  }, [search, setSearch]);

  const load = useCallback(async () => {
    try {
      const result = await fetchSessions();
      /* A session that came from this browser inherits the password it chose. */
      for (const session of result.sessions) adoptOrigin(session.origin, session.id);
      setSessions(result.sessions);
      setMembers(result.members ?? []);
      setYou(result.you ?? null);
      await shareAnyPending(result.sessions, result.members ?? [], result.you ?? null);
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
   * Publishing this browser's key makes it a possible recipient of a session
   * password sealed by a colleague.
   */
  useEffect(() => {
    void publicKey()
      .then((key) => fetchOrg(undefined, key))
      .catch(() => undefined);
  }, []);

  /*
   * Machines are polled, not fetched once: whether a machine is reachable is a
   * live fact, and a stale snapshot silently disables the Start button.
   */
  useEffect(() => {
    const loadDevices = () =>
      void fetchDevices()
        .then((result) => {
          setDevices(result.devices);
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
    if (password) {
      rememberForOrigin(queued.command.id, password);
      /*
       * Colleagues can read this session, so the password is sealed to each of
       * them too. Held here until the session exists to attach it to.
       */
      pendingShares.current.set(queued.command.id, password);
    }
    /*
     * The machine has to poll, launch, and publish, so the row shows up a
     * moment later rather than on this response.
     */
    setNotice(`Starting ${input.name}. It appears here once the machine picks it up.`);
    window.setTimeout(() => void load(), AFTER_COMMAND_MS);
  }

  async function handleKill(session: SessionRecord) {
    const target = session.deviceId;
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

  /*
   * Removes the row, not the session's leavings on the machine that ran it.
   * The list is reloaded from the service rather than filtered here, so what
   * is on screen is what the service has.
   */
  async function handleRemove(session: SessionRecord) {
    setRemoving(session.id);
    setError("");
    setNotice("");
    try {
      await deleteSession(session.id);
      forget(session.id);
      dispatch({ type: "close", id: session.id });
      setNotice(`Removed ${session.name || session.command} from the list.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove that session.");
    } finally {
      setRemoving("");
    }
  }

  /*
   * Sessions started here have a password only this browser knows. Seal it to
   * every colleague so they can read the session too.
   *
   * Runs on each poll rather than once, because someone can join the
   * team after a session started, and should still be able to open it.
   */
  async function shareAnyPending(all: SessionRecord[], roster: Member[], me: Member | null) {
    const targets = roster.filter((member) => member.publicKey);
    if (targets.length === 0) return;

    for (const session of all) {
      if (session.closedAt) continue;

      /* Newly started here, still waiting for its session to appear. */
      const pending = session.origin ? pendingShares.current.get(session.origin) : undefined;
      if (pending) {
        pendingShares.current.delete(session.origin!);
        rememberFor(session.id, pending);
      }

      /* Only the owner holds the password, so only they can share it. */
      if (me && session.ownerUid !== me.uid) continue;
      const password = passwordFor(session.id);
      if (!password) continue;

      const missing = targets.filter(
        (member) => member.uid !== me?.uid && !sharedWith.current.get(session.id)?.has(member.uid),
      );
      if (missing.length === 0) continue;

      try {
        const shares = await sealForMembers(missing, password);
        await shareSessionKeys(
          session.id,
          shares.map((share) => ({
            uid: share.uid,
            sender_public_key: share.senderPublicKey,
            sealed: share.sealed,
          })),
        );
        const done = sharedWith.current.get(session.id) ?? new Set<string>();
        for (const share of shares) done.add(share.uid);
        sharedWith.current.set(session.id, done);
      } catch {
        /* Sharing is a convenience; the session still works for its owner. */
      }
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

  /*
   * Three groups, not two. Whether a session can be typed into is what
   * somebody scanning this list is deciding between, and it was buried in the
   * row: "Running" mixed sessions you can drive with sessions you can only
   * watch, and the difference showed only once a tab was open.
   */
  const matching = (sessions ?? []).filter((session) => matches(session, query));
  const liveWrite = matching.filter((session) => !session.closedAt && canEdit(session, you));
  const liveRead = matching.filter((session) => !session.closedAt && !canEdit(session, you));
  const finished = matching.filter((session) => session.closedAt);
  const openSession = (session: SessionRecord) =>
    dispatch({ type: "open", session, canType: canEdit(session, you) });
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
                {/*
                  The kind of thing running, as the row shows it. This was a
                  fixed terminal glyph, so opening a Claude Code session and
                  looking at its tab showed a terminal whatever was running.
                */}
                <img
                  className="tab-icon"
                  src={kindForCommand(tab.command).icon}
                  alt=""
                  title={kindForCommand(tab.command).title}
                />
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
          {state.tabs.map((tab) => {
            /*
             * Permission is read from the session list on every render, not
             * from the tab. Whether someone may type is a fact about the
             * session and the person, and it changes underneath an open tab:
             * a colleague who opened one to watch, and is then handed the
             * session, kept the answer taken when the tab was created and
             * stayed read-only until they closed and reopened it.
             *
             * The tab's own copy is the fallback for a session that has left
             * the list, where the last known answer is the best there is.
             */
            const current = sessions?.find((session) => session.id === tab.id);
            return (
              <TerminalPane
                key={tab.id}
                shareUrl={tab.shareUrl}
                active={state.activeId === tab.id}
                keyShare={current?.keyShare ?? tab.keyShare}
                canType={current ? canEdit(current, you) : tab.canType}
              />
            );
          })}
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
                Install shell on the machine you want to run on.
                <code className="empty-command">
                  curl -fsSL https://shell.online/install | sh
                </code>
              </li>
              <li>
                Sign that machine in, and allow browser-started sessions.
                <code className="empty-command">shell login</code>
              </li>
              <li>
                Press <b>+ Session</b> and pick what to run. It opens here as a
                tab you can type into.
              </li>
            </ol>
          </div>
        ) : (
          <>
            <div className="sessions-toolbar">
              <label className="sessions-search">
                <MagnifyingGlass size={15} />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name or command"
                  aria-label="Search sessions by name or command"
                />
              </label>

              <div className="view-toggle" role="group" aria-label="How to show sessions">
                <button
                  type="button"
                  className={view === "list" ? "view-option is-active" : "view-option"}
                  aria-pressed={view === "list"}
                  onClick={() => {
                    setView("list");
                    writeViewMode("list");
                  }}
                  title="List"
                >
                  <Rows size={15} />
                </button>
                <button
                  type="button"
                  className={view === "board" ? "view-option is-active" : "view-option"}
                  aria-pressed={view === "board"}
                  onClick={() => {
                    setView("board");
                    writeViewMode("board");
                  }}
                  title="Columns"
                >
                  <Columns size={15} />
                </button>
              </div>
            </div>

            {matching.length === 0 ? (
              <div className="sessions-empty">
                <p>Nothing matches that search.</p>
                <button type="button" className="session-action" onClick={() => setQuery("")}>
                  Clear it
                </button>
              </div>
            ) : view === "board" ? (
              <SessionBoard
                liveWrite={liveWrite}
                liveRead={liveRead}
                finished={finished}
                now={now}
                members={members}
                you={you}
                removing={removing}
                onOpen={openSession}
                onRemove={handleRemove}
              />
            ) : (
              <>
                {liveWrite.length > 0 && (
                  <SessionGroup
                    heading="Live write"
                    sessions={liveWrite}
                    now={now}
                    live
                    killing={killing}
                    removing={removing}
                    members={members}
                    you={you}
                    onOpen={openSession}
                    onKill={handleKill}
                    onRemove={handleRemove}
                    onAssign={handleAssign}
                  />
                )}
                {liveRead.length > 0 && (
                  <SessionGroup
                    heading="Live read"
                    sessions={liveRead}
                    now={now}
                    live
                    killing={killing}
                    removing={removing}
                    members={members}
                    you={you}
                    onOpen={openSession}
                    onKill={handleKill}
                    onRemove={handleRemove}
                    onAssign={handleAssign}
                  />
                )}
                {finished.length > 0 && (
                  <SessionGroup
                    heading="Finished"
                    sessions={finished}
                    now={now}
                    live={false}
                    killing={killing}
                    removing={removing}
                    members={members}
                    you={you}
                    onOpen={openSession}
                    onKill={handleKill}
                    onRemove={handleRemove}
                    onAssign={handleAssign}
                  />
                )}
              </>
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

      {justLinked && <SignedInModal onClose={() => setJustLinked(false)} />}
    </AppShell>
  );
}

function SessionGroup({
  heading,
  sessions,
  now,
  live,
  killing,
  removing,
  members,
  you,
  onOpen,
  onKill,
  onRemove,
  onAssign,
}: {
  heading: string;
  sessions: SessionRecord[];
  now: number;
  live: boolean;
  killing: string;
  removing: string;
  members: Member[];
  you: Member | null;
  onOpen: (session: SessionRecord) => void;
  onKill: (session: SessionRecord) => void;
  onRemove: (session: SessionRecord) => void;
  onAssign: (session: SessionRecord, uid: string) => void;
}) {
  /*
   * Which commands are shown in full. Collapsed by default: an agent command
   * runs to a few hundred characters, and one of them widens the whole table
   * and puts every other row behind a horizontal scrollbar.
   */
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCommand = (id: string) =>
    setShown((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="sessions-group">
      <h2>{heading}</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Owner</th>
            <th scope="col">Assignee</th>
            <th scope="col">Machine</th>
            <th scope="col">{live ? "Uptime" : "Ran for"}</th>
            <th scope="col" className="table-end">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => {
            const owner = findPerson(members, session.ownerUid);
            const assignee = findPerson(members, session.assigneeUid);
            return (
              <tr key={session.id} data-live={live}>
                <td>
                  <Link className="table-subject" to={`/sessions/${session.id}`}>
                    {/* The kind of thing running, in colour while it runs. */}
                    <img
                      className="table-icon"
                      src={kindForCommand(session.command).icon}
                      alt={kindForCommand(session.command).title}
                      title={kindForCommand(session.command).title}
                      data-live={live}
                    />
                    <span className="table-name">{session.name || session.command}</span>
                  </Link>
                  {/*
                    * Outside the link, because it is a button and a button
                    * inside an anchor is neither valid nor operable by
                    * keyboard.
                    */}
                  {session.name && session.name !== session.command && (
                    <>
                      <button
                        type="button"
                        className="table-command-toggle"
                        aria-expanded={shown.has(session.id)}
                        aria-controls={`command-${session.id}`}
                        onClick={() => toggleCommand(session.id)}
                      >
                        <CaretRight size={11} weight="bold" data-open={shown.has(session.id)} />
                        command
                      </button>
                      {shown.has(session.id) && (
                        /* Wraps rather than scrolls: a row should never be the
                           thing that makes the page scroll sideways. */
                        <code className="table-command" id={`command-${session.id}`}>
                          {session.command}
                        </code>
                      )}
                    </>
                  )}
                </td>
                <td className="table-person"><PersonChip person={owner} /></td>
                <td className="table-person">
                  {live && canHandOff(session, you) ? (
                    <PersonPicker
                      people={members}
                      value={session.assigneeUid}
                      label={`Assignee for ${session.name || session.command}`}
                      onChange={(uid) => onAssign(session, uid)}
                    />
                  ) : (
                    <PersonChip person={assignee} />
                  )}
                </td>
                <td className="table-quiet">{session.host || "unknown"}</td>
                <td className="table-quiet">
                  {live
                    ? elapsed(session.startedAt, now)
                    : elapsed(session.startedAt, session.closedAt ?? now)}
                  {!live && session.exitCode !== undefined && (
                    <span className="table-exit">exit {session.exitCode}</span>
                  )}
                </td>
                <td className="table-end">
                  <div className="session-actions">
                    {live ? (
                      <>
                        <button
                          type="button"
                          className="session-action is-primary"
                          onClick={() => onOpen(session)}
                        >
                          <TerminalIcon size={15} weight="bold" />
                          {canEdit(session, you) ? "Open" : "Watch"}
                        </button>
                        <SessionClipboard session={session} you={you} />
                        {canStop(session, you) && (
                          <button
                            type="button"
                            className="session-action"
                            onClick={() => void onKill(session)}
                            disabled={killing === session.id}
                          >
                            {killing === session.id ? "Stopping" : "Stop"}
                          </button>
                        )}
                        {canRemove(session, you) && (
                          <RemoveSession session={session} onRemove={onRemove} busy={removing === session.id} />
                        )}
                      </>
                    ) : (
                      <>
                        <SessionClipboard session={session} you={you} />
                        {canRemove(session, you) && (
                          <RemoveSession session={session} onRemove={onRemove} busy={removing === session.id} />
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
