import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Envelope, At, UserSwitch, Terminal, Check } from "@phosphor-icons/react";
import { Avatar } from "../components/Avatar";
import { fetchInbox, markNotifications, type Inbox as InboxView } from "../lib/api";
import { displayName, findPerson } from "../lib/people";
import { ago } from "../lib/time";

const POLL_MS = 20_000;

/**
 * Mentions and assignments.
 *
 * The two are shown differently on purpose. A mention is frequent and can wait;
 * an assignment means a session is now someone's responsibility and happens
 * rarely, so it is louder in the list and counted separately on the badge.
 */
export function Inbox() {
  const [view, setView] = useState<InboxView | null>(null);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const load = () =>
      void fetchInbox()
        .then(setView)
        .catch(() => undefined);
    load();
    const poll = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(poll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = view?.unread ?? 0;
  const assignments = view?.unreadAssignments ?? 0;

  async function follow(id: string, sessionId: string) {
    setOpen(false);
    try {
      setView(await markNotifications(id));
    } catch {
      /* Following the link matters more than marking it read. */
    }
    navigate(`/sessions/${sessionId}`);
  }

  return (
    <div className="inbox" ref={wrapper}>
      <button
        type="button"
        className="inbox-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
      >
        <Envelope size={18} />
        {unread > 0 && (
          /* An assignment turns the badge solid; mentions leave it quiet. */
          <span className={assignments > 0 ? "inbox-badge is-loud" : "inbox-badge"}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="inbox-pop" role="dialog" aria-label="Inbox">
          <header className="inbox-head">
            <h2>Inbox</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={async () => setView(await markNotifications())}
              >
                <Check size={13} weight="bold" />
                Mark all read
              </button>
            )}
          </header>

          {!view || view.notifications.length === 0 ? (
            <p className="inbox-empty">
              Nothing yet. Sessions your colleagues start, mentions in a
              comment, and anything assigned to you turn up here.
            </p>
          ) : (
            <ul className="inbox-list">
              {view.notifications.map((notification) => {
                /* A reply without a roster costs a name, not the page. */
                const actor = findPerson(view.members ?? [], notification.actorUid);
                const assigned = notification.kind === "assigned";
                const shared = notification.kind === "shared";
                return (
                  <li key={notification.id}>
                    <button
                      type="button"
                      className={[
                        "inbox-item",
                        assigned ? "is-assignment" : shared ? "is-shared" : "is-mention",
                        notification.readAt ? "" : "is-unread",
                      ].filter(Boolean).join(" ")}
                      onClick={() => follow(notification.id, notification.sessionId)}
                    >
                      <span className="inbox-icon">
                        {assigned ? (
                          <UserSwitch size={15} weight="bold" />
                        ) : shared ? (
                          <Terminal size={15} />
                        ) : (
                          <At size={15} />
                        )}
                      </span>
                      <span className="inbox-text">
                        <span className="inbox-title">
                          <Avatar person={actor} size="xs" />
                          {assigned ? (
                            <>
                              <b>{displayName(actor)}</b> assigned you a session
                            </>
                          ) : shared ? (
                            <>
                              <b>{displayName(actor)}</b> started a session
                            </>
                          ) : (
                            <>
                              <b>{displayName(actor)}</b> mentioned you
                            </>
                          )}
                        </span>
                        <span className="inbox-body">{notification.body}</span>
                        <time>{ago(notification.at, Date.now())}</time>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
