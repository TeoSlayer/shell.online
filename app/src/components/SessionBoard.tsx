import { Terminal as TerminalIcon, Trash, Eye } from "@phosphor-icons/react";
import { PersonChip } from "./Avatar";
import { findPerson } from "../lib/people";
import { kindForCommand } from "../lib/session-kinds";
import { canRemove } from "../lib/session-view";
import { ago } from "../lib/time";
import type { Member, SessionRecord } from "../lib/api";
import { SessionClipboard } from "./SessionClipboard";

/**
 * The same sessions as three columns, one per thing you can do with them.
 *
 * The table answers "what is running"; this answers "what is mine to drive".
 * Which column a session sits in is the whole message, so the row inside it
 * carries less: no owner, because in a column of things you can write to, the
 * owner is not the question. The assignee is, because that is who is expected
 * to be at it.
 */

type Column = {
  key: "write" | "read" | "finished";
  title: string;
  hint: string;
  sessions: SessionRecord[];
};

function Card({
  session,
  now,
  members,
  you,
  action,
}: {
  session: SessionRecord;
  now: number;
  members: Member[];
  you: Member | null;
  action: React.ReactNode;
}) {
  const kind = kindForCommand(session.command);
  const assignee = findPerson(members, session.assigneeUid);

  return (
    <li className="board-card">
      <div className="board-card-head">
        <img className="board-card-icon" src={kind.icon} alt="" title={kind.title} />
        <span className="board-card-name">{session.name || session.command}</span>
        <SessionClipboard session={session} you={you} />
      </div>

      <p className="board-card-meta">
        {session.host}
        {session.closedAt
          ? ` · ran ${ago(session.startedAt, session.closedAt)}`
          : ` · up ${ago(session.startedAt, now)}`}
      </p>

      <div className="board-card-foot">
        {assignee ? (
          <PersonChip person={assignee} />
        ) : (
          <span className="board-card-unassigned">Unassigned</span>
        )}
        {action}
      </div>
    </li>
  );
}

export function SessionBoard({
  liveWrite,
  liveRead,
  finished,
  now,
  members,
  you,
  removing,
  onOpen,
  onRemove,
}: {
  liveWrite: SessionRecord[];
  liveRead: SessionRecord[];
  finished: SessionRecord[];
  now: number;
  members: Member[];
  you: Member | null;
  removing: string;
  onOpen: (session: SessionRecord) => void;
  onRemove: (session: SessionRecord) => void;
}) {
  const columns: Column[] = [
    {
      key: "write",
      title: "Write",
      hint: "Yours to drive",
      sessions: liveWrite,
    },
    {
      key: "read",
      title: "Read",
      hint: "Running, watch only",
      sessions: liveRead,
    },
    {
      key: "finished",
      title: "Finished",
      hint: "The process has exited",
      sessions: finished,
    },
  ];

  return (
    <div className="board">
      {columns.map((column) => (
        <section key={column.key} className="board-column" aria-label={column.title}>
          <header className="board-column-head">
            <h2>{column.title}</h2>
            <span className="board-count">{column.sessions.length}</span>
          </header>
          <p className="board-column-hint">{column.hint}</p>

          {column.sessions.length === 0 ? (
            <p className="board-empty">Nothing here.</p>
          ) : (
            <ul className="board-cards">
              {column.sessions.map((session) => (
                <Card
                  key={session.id}
                  session={session}
                  now={now}
                  members={members}
                  you={you}
                  action={
                    column.key === "finished" ? (
                      /*
                       * Gated the same way the table gates it. Offering the
                       * button to everyone and letting the service answer 403
                       * is a worse answer than not offering it.
                       */
                      canRemove(session, you) ? (
                        <button
                          type="button"
                          className="session-action"
                          onClick={() => onRemove(session)}
                          disabled={removing === session.id}
                        >
                          <Trash size={14} />
                          {removing === session.id ? "Removing" : "Delete"}
                        </button>
                      ) : null
                    ) : (
                      <button
                        type="button"
                        className="session-action is-primary"
                        onClick={() => onOpen(session)}
                      >
                        {column.key === "write" ? (
                          <>
                            <TerminalIcon size={14} weight="bold" />
                            Open
                          </>
                        ) : (
                          <>
                            <Eye size={14} />
                            Watch
                          </>
                        )}
                      </button>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
