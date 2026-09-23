import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  PaperPlaneTilt,
  PencilSimple,
  Stop as StopIcon,
  Terminal as TerminalIcon,
  Trash,
} from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Avatar, PeopleChip, PersonChip } from "../components/Avatar";
import { MultiPersonPicker } from "../components/PersonPicker";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { FeedbackLink } from "../feedback/FeedbackLink";
import { Booting } from "../components/Booting";
import { SessionClipboard } from "../components/SessionClipboard";
import { SessionAudience } from "../components/SessionAudience";
import { SessionAutomation } from "../components/SessionAutomation";
import {
  assignSession,
  deleteSession,
  fetchSession,
  postComment,
  renameSession,
  stopSession,
  updateSessionAutomation,
  type Comment,
  type Member,
  type SessionDetail,
} from "../lib/api";
import { splitMentions } from "../lib/mentions";
import { displayName, findPerson } from "../lib/people";
import { usePageTitle } from "../lib/page-title";
import { sessionTitle } from "../lib/session-title";
import {useSessionContents, withSessionContent} from "../lib/use-session-contents";
import {SessionSummaryText} from "../components/SessionSummaryText";
import { assigneeIds, canRemove, canRename, canStop } from "../lib/session-view";
import { ago, elapsed } from "../lib/time";
import { useVault } from "../vault/VaultProvider";
import { shareWith } from "../vault/share-with";
import { sessionEnded, sessionOnline, sessionStateLabel } from "../lib/session-liveness";

function CommentBody({ body, members }: { body: string; members: Member[] }) {
  return (
    <p className="comment-body">
      {splitMentions(body, members).map((segment, index) =>
        segment.uid ? (
          <span key={index} className="mention">
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

function CommentRow({ comment, members }: { comment: Comment; members: Member[] }) {
  const author = findPerson(members, comment.authorUid);
  return (
    <li className="comment">
      <Avatar person={author} size="md" />
      <div className="comment-main">
        <span className="comment-head">
          <b>{displayName(author)}</b>
          <time dateTime={new Date(comment.at).toISOString()}>
            {ago(comment.at, Date.now())}
          </time>
        </span>
        <CommentBody body={comment.body} members={members} />
      </div>
    </li>
  );
}

export function Session() {
  const { sessionId = "" } = useParams();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [working, setWorking] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const assignmentRevision = useRef(0);
  const assignmentQueue = useRef<Promise<void>>(Promise.resolve());
  const detailGeneration = useRef(0);
  const automationSaving = useRef(false);
  const vault = useVault();
  const sessionContents = useSessionContents(detail ? [detail.session] : null);

  /* The tab carries the session's short title once it has loaded, not a bare word. */
  // Browser history can retain document titles; keep private suggestions in the page only.
  usePageTitle(detail ? sessionTitle(detail.session) : "Session");

  const load = useCallback(async () => {
    if (automationSaving.current) return;
    const generation = ++detailGeneration.current;
    try {
      const next = await fetchSession(sessionId);
      if (generation !== detailGeneration.current) return;
      setDetail(next);
      setError("");
    } catch (caught) {
      if (generation !== detailGeneration.current) return;
      setError(caught instanceof Error ? caught.message : "Could not load that session.");
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), 6000);
    return () => window.clearInterval(poll);
  }, [load]);

  if (error && !detail) {
    return (
      <AppShell title="Session">
        <div className="sessions-alert sessions-error">
          <Alert tone="error">
            <span>{error}</span>
            <span className="alert-actions">
              <button
                type="button"
                className="inline-retry"
                onClick={() => {
                  setError("");
                  void load();
                }}
              >
                Retry
              </button>
              <FeedbackLink surface="session-error" kind="problem" context={{ error }}>
                Report
              </FeedbackLink>
            </span>
          </Alert>
        </div>
        <p className="page-dek">
          <Link to="/sessions">Back to sessions</Link>
        </p>
      </AppShell>
    );
  }
  if (!detail) return <Booting label="Loading the session" />;

  const { members, you, comments } = detail;
  const session = withSessionContent(detail.session, sessionContents[detail.session.id]);
  const owner = findPerson(members, session.ownerUid);
  const selected = new Set(assigneeIds(session));
  const assignees = members.filter((member) => selected.has(member.uid));
  const live = !sessionEnded(session);
  const online = sessionOnline(session);
  const canAssign =
    session.ownerUid === you.uid || you.role === "owner" || you.role === "admin";

  /*
   * Stopping and removing belong here too.
   *
   * They were reachable from the list and not from the session's own page, so
   * opening a session to look at it meant going back to the list to act on it.
   * On a phone this page is the one you are on.
   */
  async function handleStop() {
    if (!detail?.session.deviceId) return;
    setWorking("stop");
    setError("");
    try {
      await stopSession(detail.session.deviceId, detail.session.id);
      /* The machine has to poll and report, so the row catches up shortly. */
      window.setTimeout(() => void load(), 1500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not stop that session.");
    } finally {
      setWorking("");
    }
  }

  async function handleRemove() {
    if (!detail) return;
    setWorking("remove");
    setError("");
    try {
      await deleteSession(detail.session.id);
      /* The page it was showing is gone, so there is nothing to stay on. */
      navigate("/sessions");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove that session.");
      setWorking("");
    }
  }

  function startRename() {
    if (!detail) return;
    setDraftName(detail.session.name ?? "");
    setRenaming(true);
  }

  /*
   * Saved as typed. A blank name clears it, and the session is shown by its
   * command again, which is what every session without one already does.
   */
  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    const name = draftName.trim();
    if (name === (detail.session.name ?? "")) {
      setRenaming(false);
      return;
    }
    setWorking("rename");
    setError("");
    try {
      const { session: updated } = await renameSession(detail.session.id, name);
      setDetail((current) => current ? { ...current, session: { ...current.session, name: updated.name } } : current);
      setRenaming(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename that session.");
    } finally {
      setWorking("");
    }
  }

  async function handleComment(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      await postComment(sessionId, body);
      setDraft("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post that.");
    } finally {
      setPosting(false);
    }
  }

  /** Inserts a mention at the caret, so picking a name is not typing it. */
  function mention(member: Member) {
    const handle = `@${displayName(member)} `;
    setDraft((current) => (current.endsWith(" ") || !current ? current : `${current} `) + handle);
    composer.current?.focus();
  }

  async function handleAssign(uids: string[]) {
    const revision = ++assignmentRevision.current;
    const previous = assigneeIds(session);
    setDetail((current) => current ? {
      ...current,
      session: { ...current.session, assigneeUid: uids[0], assigneeUids: uids },
    } : current);

    const request = assignmentQueue.current.catch(() => undefined).then(async () => {
      const { session: updated } = await assignSession(session.id, uids);
      if (assignmentRevision.current === revision) {
        setDetail((current) => current ? { ...current, session: updated } : current);
      }
    });
    assignmentQueue.current = request;
    try {
      await request;
      if (assignmentRevision.current === revision) setError("");
      /*
       * Whoever is made responsible can open it straight away. The owner
       * assigning from their own browser is the say-so, the same as sharing,
       * and only the owner holds the password to seal.
       */
      const added = uids.filter((uid) => !previous.includes(uid));
      if (session.ownerUid === you.uid && added.length > 0) {
        void shareWith(vault, you.uid, session, members.filter((member) => added.includes(member.uid)));
      }
    } catch (caught) {
      if (assignmentRevision.current === revision) {
        setDetail((current) => current ? {
          ...current,
          session: { ...current.session, assigneeUid: previous[0], assigneeUids: previous },
        } : current);
        setError(caught instanceof Error ? caught.message : "Could not update assignees.");
      }
    }
  }

  return (
    <AppShell
      title="Session"
      aside={
        <Link className="session-action topbar-compact-action" to="/sessions" aria-label="All sessions">
          <ArrowLeft size={14} weight="bold" />
          <span>All sessions</span>
        </Link>
      }
    >
      <div className="detail">
        <section className="detail-main">
          {renaming ? (
            <form className="detail-rename" onSubmit={handleRename}>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenaming(false);
                }}
                placeholder={session.command}
                maxLength={120}
                aria-label="Session name"
                autoFocus
              />
              <Button type="submit" busy={working === "rename"} busyLabel="Saving">
                Save
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="detail-title">
              {/*
                * The short title, not the command: an agent command runs to a
                * few hundred characters and used to be the page heading. The
                * full command is one disclosure below, and the full name (when
                * the title is capped) stays on the element for a pointer.
                */}
              <h2 className="detail-name" title={session.name?.trim() || session.command}>
                {sessionTitle(session)}
              </h2>
              {canRename(session, you) && (
                <button
                  type="button"
                  className="detail-name-edit"
                  onClick={startRename}
                  aria-label="Rename session"
                  title="Rename"
                >
                  <PencilSimple size={16} />
                </button>
              )}
            </div>
          )}

          {/*
            * A real summary, when the record has one, clamped to two lines.
            * Extracted content is a transient owner-vault projection, never a
            * plaintext field returned with the ordinary session listing.
            */}
          <div className="detail-summary">
            <SessionSummaryText session={session} compact={false} />
          </div>

          <div className="detail-head">
            <span className={online ? "detail-status is-live" : "detail-status"}>
              {sessionStateLabel(session)}
            </span>
            {/*
              * The raw command, behind a disclosure. It is the thing this page
              * used to shout: always visible, long enough to set the width of
              * the page. Closed by default it costs a word; open, it wraps.
              */}
            <details className="detail-command-details">
              <summary>Command</summary>
              <code className="detail-command-full">{session.command}</code>
            </details>
          </div>

          {error && <div className="sessions-alert"><Alert tone="error">{error}</Alert></div>}

          <div className="detail-actions">
            {live && (
              <Link className="session-action is-primary" to={`/sessions?open=${session.id}`}>
                <TerminalIcon size={15} weight="bold" />
                Open terminal
              </Link>
            )}
            {/*
              * The same menu the list has. A bare "Copy link" here meant the
              * password was reachable from one screen and not the other, which
              * on a phone is the screen you are actually on.
              */}
            <SessionClipboard session={session} you={you} />
            {canStop(session, you) && (
              <button
                type="button"
                className="session-action"
                onClick={() => void handleStop()}
                disabled={working === "stop"}
              >
                <StopIcon size={15} weight="bold" />
                {working === "stop" ? "Stopping" : "Stop"}
              </button>
            )}
            {canRemove(session, you) && (
              <button
                type="button"
                className="session-action"
                onClick={() => void handleRemove()}
                disabled={working === "remove"}
                title="Remove from the list. The machine is not touched."
              >
                <Trash size={15} />
                {working === "remove" ? "Removing" : "Remove"}
              </button>
            )}
          </div>

          <SessionAudience session={session} members={members} you={you} />

          <SessionAutomation key={session.id} session={session} you={you} onChange={async (changes) => {
            automationSaving.current = true;
            ++detailGeneration.current;
            try {
              const { session: updated } = await updateSessionAutomation(session.id, changes);
              setDetail((current) => current?.session.id === updated.id ? {
                ...current,
                session: {
                  ...current.session,
                  mcpTeamAccess: updated.mcpTeamAccess,
                  dailyBriefingEnabled: updated.dailyBriefingEnabled,
                  dailyBriefingTeamAccess: updated.dailyBriefingTeamAccess,
                },
              } : current);
            } finally {
              automationSaving.current = false;
              ++detailGeneration.current;
            }
          }} />

          <h2 className="detail-heading">Comments</h2>

          {comments.length === 0 ? (
            <p className="detail-empty">
              Nothing yet. Leave a note for whoever picks this up, and mention
              someone with @ to get their attention.
            </p>
          ) : (
            <ul className="comment-list">
              {comments.map((comment) => (
                <CommentRow key={comment.id} comment={comment} members={members} />
              ))}
            </ul>
          )}

          <form className="composer" onSubmit={handleComment}>
            <textarea
              ref={composer}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                /* Enter sends; Shift-Enter is a newline, as in a chat box. */
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleComment(event as unknown as FormEvent);
                }
              }}
              placeholder="Leave a comment. Use @ to mention someone."
              rows={3}
              aria-label="Comment"
            />
            <div className="composer-foot">
              <div className="composer-people">
                {members
                  .filter((member) => member.uid !== you.uid)
                  .slice(0, 6)
                  .map((member) => (
                    <button
                      key={member.uid}
                      type="button"
                      className="composer-mention"
                      onClick={() => mention(member)}
                      title={`Mention ${displayName(member)}`}
                    >
                      <Avatar person={member} size="xs" />
                    </button>
                  ))}
              </div>
              <Button type="submit" busy={posting} busyLabel="Posting" disabled={!draft.trim()}>
                <PaperPlaneTilt size={15} weight="bold" />
                Comment
              </Button>
            </div>
          </form>
        </section>

        <aside className="detail-side">
          <h2 className="detail-heading">Details</h2>
          <dl className="detail-rows">
            <div className="detail-row">
              <dt>Owner</dt>
              <dd><PersonChip person={owner} /></dd>
            </div>
            <div className="detail-row">
              <dt>Assignees</dt>
              <dd>
                {canAssign && live ? (
                  <MultiPersonPicker
                    people={members}
                    values={assigneeIds(session)}
                    label="Assignees"
                    onChange={(uids) => void handleAssign(uids)}
                  />
                ) : (
                  <PeopleChip people={assignees} />
                )}
              </dd>
            </div>
            <div className="detail-row">
              <dt>Machine</dt>
              <dd>{session.host || "unknown"}</dd>
            </div>
            <div className="detail-row">
              <dt>Started</dt>
              <dd>{new Date(session.startedAt).toLocaleString()}</dd>
            </div>
            <div className="detail-row">
              <dt>{live ? "Open for" : "Ran for"}</dt>
              <dd>{elapsed(session.startedAt, session.closedAt ?? session.relayCheckedAt ?? Date.now())}</dd>
            </div>
            {!live && session.exitCode !== undefined && (
              <div className="detail-row">
                <dt>Exit code</dt>
                <dd>{session.exitCode}</dd>
              </div>
            )}
            <div className="detail-row">
              <dt>Access</dt>
              <dd>
                {session.readOnly ? "View only" : "Interactive"}
                {session.encrypted ? " · encrypted" : ""}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </AppShell>
  );
}
