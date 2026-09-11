import { Eye, Stop as StopIcon, Terminal as TerminalIcon, Trash } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { PeopleChip } from "./Avatar";
import { kindForCommand } from "../lib/session-kinds";
import { assigneeIds, canHandOff, canRemove, canStop } from "../lib/session-view";
import { MultiPersonPicker } from "./PersonPicker";
import { ago } from "../lib/time";
import type { Member, SessionRecord } from "../lib/api";
import { SessionClipboard } from "./SessionClipboard";
import { shouldOpenSurface } from "../lib/surface-navigation";

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
  onOpen,
  onAssign,
  onStop,
  stopping,
}: {
  session: SessionRecord;
  now: number;
  members: Member[];
  you: Member | null;
  action: React.ReactNode;
  onOpen: (session: SessionRecord) => void;
  onAssign: (session: SessionRecord, uids: string[]) => void;
  onStop: (session: SessionRecord) => void;
  stopping: string;
}) {
  const kind = kindForCommand(session.command);
  const selected = new Set(assigneeIds(session));
  const assignees = members.filter((member) => selected.has(member.uid));

  return (
    <li
      className="board-card"
      onClick={(event) => {
        if (shouldOpenSurface(event.target, event.defaultPrevented)) onOpen(session);
      }}
    >
      <div className="board-card-head">
        <img className="board-card-icon" src={kind.icon} alt="" title={kind.title} />
        {/*
         * The name is the card's link, and CSS stretches it over the whole
         * card so anywhere that is not a control opens the session. One
         * anchor, not a click handler on the li: a card you can only reach
         * with a mouse is a card a keyboard cannot reach at all, and nesting
         * the copy menu and the Open button inside an anchor would be
         * invalid markup as well as unusable.
         */}
        <Link className="board-card-name" to={`/sessions/${session.id}`}>
          {session.name || session.command}
        </Link>
        <SessionClipboard session={session} you={you} />
      </div>

      <p className="board-card-meta">
        {session.host}
        {session.closedAt
          ? ` · ran ${ago(session.startedAt, session.closedAt)}`
          : ` · up ${ago(session.startedAt, now)}`}
      </p>

      <div className="board-card-foot">
        {/*
          * Handing a session over is a thing you do to a card, not only to a
          * row. The board showed who it was assigned to and gave you no way to
          * change it, so the answer to "who should pick this up" was only
          * reachable by switching back to the table.
          */}
        {!session.closedAt && canHandOff(session, you) ? (
          <MultiPersonPicker
            people={members}
            values={assigneeIds(session)}
            label={`Assignees for ${session.name || session.command}`}
            onChange={(uids) => onAssign(session, uids)}
          />
        ) : (
          <PeopleChip people={assignees} />
        )}
        {/*
          * Stopping was reachable from the table and not from here, so the
          * board could show a session that was yours to stop and give you no
          * way to stop it.
          */}
        {canStop(session, you) && (
          <button
            type="button"
            className="session-action"
            onClick={() => void onStop(session)}
            disabled={stopping === session.id}
          >
            <StopIcon size={14} weight="bold" />
            {stopping === session.id ? "Stopping" : "Stop"}
          </button>
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
  onAssign,
  onStop,
  stopping,
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
  onAssign: (session: SessionRecord, uids: string[]) => void;
  onStop: (session: SessionRecord) => void;
  stopping: string;
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
                  onOpen={onOpen}
                  onAssign={onAssign}
                  onStop={onStop}
                  stopping={stopping}
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
