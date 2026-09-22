import { useEffect, useRef, useState } from "react";
import { CaretDown, Copy, Check, Link as LinkIcon, Lock, Terminal, Warning } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { Member, SessionRecord } from "../lib/api";
import { verifiedPasswordFor } from "../lib/session-passwords";
import { COPY_FAILED, useCopy } from "../lib/clipboard";
import { useVault } from "../vault/VaultProvider";
import { isVaultShare } from "../lib/vault-crypto";

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
 * either holds it already, or opens the copy sealed to this person's vault.
 * So the answer to "may this person copy it" is not a permission the service
 * grants: they either hold a copy or they do not, and someone outside the
 * team holds nothing whatever the interface says.
 */
async function readPassword(
  session: SessionRecord,
  openShare: (sessionId: string, share: SessionRecord["keyShare"]) => Promise<string | null>,
): Promise<string | null> {
  /* A vault share is the current credential generation. A locally verified
   * cache may be from before rotation and is only a fallback for legacy rows. */
  if (isVaultShare(session.keyShare?.sealed)) return openShare(session.id, session.keyShare);
  return verifiedPasswordFor(session.id, session.shareUrl) ?? openShare(session.id, session.keyShare);
}

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
   */
  const [password, setPassword] = useState<string | null>(null);
  const { copiedKey, failedKey, copy } = useCopy<Item>();
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
  const { openShare } = useVault();
  useEffect(() => {
    let live = true;
    void readPassword(session, openShare).then((value) => {
      if (live) setPassword(value);
    });
    return () => {
      live = false;
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- see above */
  }, [session.id, sealed, openShare]);

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
