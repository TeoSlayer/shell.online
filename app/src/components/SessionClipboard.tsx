import { useEffect, useRef, useState } from "react";
import { CaretDown, Copy, Check, Key, Link as LinkIcon, Lock, Terminal, Warning } from "@phosphor-icons/react";
import { Link, useNavigate } from "react-router-dom";
import type { Member, SessionRecord } from "../lib/api";
import { COPY_FAILED, useCopy } from "../lib/clipboard";
import { useSessionPassword } from "../vault/use-session-password";
import { passwordRequestsHref } from "../lib/password-requests";

/**
 * The one place a session can be copied from.
 *
 * Three things were reachable from a row and each said nothing about what it
 * handed over. A link that opens a terminal to anyone holding it, and a
 * password that does the same, are not the sort of thing to copy without being
 * told what you now have. Grouping them puts the warning where the decision is.
 */

type Item = "link" | "password" | "attach";

export function SessionClipboard({
  session,
  you,
}: {
  session: SessionRecord;
  you: Member | null;
}) {
  const [open, setOpen] = useState(false);
  /*
   * The password is unsealed ahead of the click, not inside it. Unsealing is
   * asynchronous, and on WebKit anything awaited between the tap and
   * navigator.clipboard.writeText spends the user gesture the write needs, so
   * copying the password failed on a phone every time while the link beside
   * it worked. Holding the decrypted value means the handler is synchronous.
   *
   * The service is not asked whether this person may copy it. A password never
   * reaches it in the clear: this browser either holds a copy or opens the one
   * sealed to this person's vault, and someone outside the team holds nothing
   * whatever the interface says.
   */
  const password = useSessionPassword(session) ?? null;
  const { copiedKey, failedKey, copy } = useCopy<Item>();
  const wrapper = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  /* The attach command runs on the machine that owns the process. */
  const isOwner = Boolean(you && session.ownerUid === you.uid);
  const attachCommand = `shell attach ${session.id.slice(0, 10)}`;
  /*
   * Teammates asking for the password, waiting on the owner. Counted on the
   * button itself, so it is seen without opening anything.
   */
  const asking = isOwner && session.encrypted ? session.passwordRequestsPending ?? 0 : 0;

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

  const anyCopied = copiedKey !== null;

  return (
    <div className="clip" ref={wrapper}>
      <button
        type="button"
        className="session-copy"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Share session or copy access details"
        title="Share session or copy access details"
      >
        {anyCopied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
        <span>Share</span>
        {asking > 0 && (
          <span
            className="clip-badge"
            aria-label={`${asking} password request${asking === 1 ? "" : "s"} waiting`}
            title={`${asking} password request${asking === 1 ? "" : "s"} waiting`}
          >
            {asking > 99 ? "99+" : asking}
          </span>
        )}
        {/* Says it opens something, rather than leaving it to be discovered. */}
        <CaretDown size={10} weight="bold" className="clip-caret" data-open={open} />
      </button>

      {open && (
        <>
          {/*
           * The sheet's backdrop on a phone, and nothing at all on a pointer.
           * It has to be a real element rather than a painted scrim: a tap
           * meant to dismiss the sheet would otherwise land on whatever
           * button happened to be underneath it.
           */}
          <div className="clip-scrim" onClick={() => setOpen(false)} />
          <div className="clip-pop" role="menu">
            <button
              type="button"
              role="menuitem"
              className="clip-item"
              onClick={() => void copy(session.shareUrl, "link")}
            >
              <LinkIcon size={16} />
              <span className="clip-text">
                <b>{copiedKey === "link" ? "Link copied" : "Copy link"}</b>
                <em>{session.encrypted ? "Send the password separately. Anyone with both can open this session." : "Anyone with this link can open this session."}</em>
              </span>
            </button>

            {password && (
              <button
                type="button"
                role="menuitem"
                className="clip-item"
                onClick={() => void copy(password, "password")}
              >
                <Lock size={16} />
                <span className="clip-text">
                  <b>{copiedKey === "password" ? "Password copied" : "Copy password"}</b>
                  <em>Give it only to people you want to let into this session.</em>
                </span>
              </button>
            )}

            {session.encrypted && !password && (
              <p className="clip-help">Password not available in this browser. <Link to="/account">Unlock your vault</Link>, or ask the session owner.</p>
            )}

            {isOwner && session.encrypted && (
              <button
                type="button"
                role="menuitem"
                className="clip-item"
                onClick={() => {
                  setOpen(false);
                  navigate(passwordRequestsHref(session.id));
                }}
              >
                <Key size={16} />
                <span className="clip-text">
                  <b>
                    Password requests
                    <span className="clip-count" data-waiting={asking > 0}>{asking}</span>
                  </b>
                  <em>
                    {asking > 0
                      ? "Teammates are waiting for you to accept or decline."
                      : "Nobody is waiting. Teammates can ask from the password prompt."}
                  </em>
                </span>
              </button>
            )}

            {isOwner && (
              <button
                type="button"
                role="menuitem"
                className="clip-item"
                onClick={() => void copy(attachCommand, "attach")}
              >
                <Terminal size={16} />
                <span className="clip-text">
                  <b>{copiedKey === "attach" ? "Command copied" : "Copy attach command"}</b>
                  <em>Run on the original computer. Ctrl-X, then D leaves it running.</em>
                </span>
              </button>
            )}

            {/*
              A refused clipboard is said out loud rather than swallowed. It used
              to leave the menu looking exactly as it had a moment earlier, which
              reads as a copy that worked.
            */}
            {failedKey && (
              <p className="clip-failed" role="status">
                <Warning size={14} weight="fill" />
                {COPY_FAILED}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
