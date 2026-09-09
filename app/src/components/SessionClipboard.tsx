import { useEffect, useRef, useState } from "react";
import { CaretDown, Copy, Check, Link as LinkIcon, Lock, Terminal } from "@phosphor-icons/react";
import type { Member, SessionRecord } from "../lib/api";
import { passwordFor } from "../lib/session-passwords";
import { openSealed } from "../lib/keypair";

/**
 * The one place a session can be copied from.
 *
 * Three things were reachable from a row and each said nothing about what it
 * handed over. A link that opens a terminal to anyone holding it, and a
 * password that does the same, are not the sort of thing to copy without being
 * told what you now have. Grouping them puts the warning where the decision is.
 */

type Item = "link" | "password" | "attach";

/*
 * Where the password comes from, and why the service is not in the list.
 *
 * A session password never reaches the service in the clear. This browser
 * either chose it, or holds a copy a colleague sealed to this browser's public
 * key. So the answer to "may this person copy it" is not a permission the
 * service grants: they either hold a copy or they do not, and someone outside
 * the team holds nothing whatever the interface says.
 */
async function readPassword(session: SessionRecord): Promise<string | null> {
  const own = passwordFor(session.id);
  if (own) return own;
  const share = session.keyShare;
  if (!share) return null;
  return openSealed(share.senderPublicKey, share.sealed);
}

export function SessionClipboard({
  session,
  you,
}: {
  session: SessionRecord;
  you: Member | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<Item | "">("");
  const [hasPassword, setHasPassword] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  /* The attach command runs on the machine that owns the process. */
  const isOwner = Boolean(you && session.ownerUid === you.uid);
  const attachCommand = `shell attach ${session.id.slice(0, 10)}`;

  /*
   * Depends on the sealed material, not on the session object.
   *
   * The list is re-fetched every few seconds and hands every row a new object
   * each time, so this ran an ECDH derivation per session per poll to answer a
   * question whose inputs had not changed. On a phone with several sessions
   * open that is most of what the page was doing.
   */
  const sealed = session.keyShare
    ? `${session.keyShare.senderPublicKey}:${session.keyShare.sealed}`
    : "";
  useEffect(() => {
    let live = true;
    void readPassword(session).then((password) => {
      if (live) setHasPassword(Boolean(password));
    });
    return () => {
      live = false;
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- see above */
  }, [session.id, sealed]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function copy(item: Item, value: string | null) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(item);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      /* clipboard is unavailable outside a secure context */
    }
  }

  return (
    <div className="clip" ref={wrapper}>
      <button
        type="button"
        className="session-copy"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Copy from this session"
        title="Copy from this session"
      >
        {copied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
        {/* Says it opens something, rather than leaving it to be discovered. */}
        <CaretDown size={10} weight="bold" className="clip-caret" data-open={open} />
      </button>

      {open && (
        <div className="clip-pop" role="menu">
          <button
            type="button"
            role="menuitem"
            className="clip-item"
            onClick={() => void copy("link", session.shareUrl)}
          >
            <LinkIcon size={16} />
            <span className="clip-text">
              <b>{copied === "link" ? "Link copied" : "Copy link"}</b>
              <em>Anyone holding this link and the password can open the session, inside the team or not.</em>
            </span>
          </button>

          {hasPassword && (
            <button
              type="button"
              role="menuitem"
              className="clip-item"
              onClick={async () => void copy("password", await readPassword(session))}
            >
              <Lock size={16} />
              <span className="clip-text">
                <b>{copied === "password" ? "Password copied" : "Copy password"}</b>
                <em>Share it as carefully as the link. Outside the team it is the whole session.</em>
              </span>
            </button>
          )}

          {isOwner && (
            <button
              type="button"
              role="menuitem"
              className="clip-item"
              onClick={() => void copy("attach", attachCommand)}
            >
              <Terminal size={16} />
              <span className="clip-text">
                <b>{copied === "attach" ? "Command copied" : "Copy attach command"}</b>
                <em>Runs on the machine that started it, so this one is visible only to you.</em>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
