import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  PaperPlaneTilt,
  Terminal as TerminalIcon,
} from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Avatar, PeopleChip, PersonChip } from "../components/Avatar";
import { MultiPersonPicker } from "../components/PersonPicker";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { Booting } from "../components/Booting";
import { SessionClipboard } from "../components/SessionClipboard";
import { SessionAudience } from "../components/SessionAudience";
import {
  assignSession,
  fetchSession,
  postComment,
  type Comment,
  type Member,
  type SessionDetail,
} from "../lib/api";
import { splitMentions } from "../lib/mentions";
import { displayName, findPerson } from "../lib/people";
import { usePageTitle } from "../lib/page-title";
import { assigneeIds } from "../lib/session-view";
import { ago, elapsed } from "../lib/time";

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
  usePageTitle("Session");
  const { sessionId = "" } = useParams();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const assignmentRevision = useRef(0);
  const assignmentQueue = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    try {
      setDetail(await fetchSession(sessionId));
      setError("");
    } catch (caught) {
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
        <div className="sessions-alert">
          <Alert tone="error">{error}</Alert>
        </div>
        <p className="page-dek">
          <Link to="/sessions">Back to sessions</Link>
        </p>
      </AppShell>
    );
  }
  if (!detail) return <Booting label="Loading the session" />;

  const { session, members, you, comments } = detail;
  const owner = findPerson(members, session.ownerUid);
  const selected = new Set(assigneeIds(session));
  const assignees = members.filter((member) => selected.has(member.uid));
  const live = !session.closedAt;
  const canAssign =
    session.ownerUid === you.uid || you.role === "owner" || you.role === "admin";

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
      title={session.name || session.command}
      aside={
        <Link className="session-action" to="/sessions">
          <ArrowLeft size={14} weight="bold" />
          All sessions
        </Link>
      }
    >
      <div className="detail">
        <section className="detail-main">
          <div className="detail-head">
            <span className={live ? "detail-status is-live" : "detail-status"}>
              {live ? "Running" : "Finished"}
            </span>
            <code className="detail-command">{session.command}</code>
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
          </div>

          <SessionAudience session={session} members={members} you={you} />

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
              <dt>{live ? "Running for" : "Ran for"}</dt>
              <dd>{elapsed(session.startedAt, session.closedAt ?? Date.now())}</dd>
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
