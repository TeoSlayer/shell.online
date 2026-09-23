import { useEffect, useState } from "react";
import type { SessionRecord } from "../lib/api";
import { verifiedPasswordFor } from "../lib/session-passwords";
import { isVaultShare } from "../lib/vault-crypto";
import { useVault } from "./VaultProvider";

type Opener = ReturnType<typeof useVault>["openShare"];

/*
 * The password this browser can reach for a session, from the vault copy or a
 * password proven here. A vault share is the current credential generation; a
 * locally verified cache may be from before a rotation and is only a fallback
 * for rows from before the vault.
 */
export async function readSessionPassword(
  session: Pick<SessionRecord, "id" | "shareUrl" | "keyShare">,
  openShare: Opener,
): Promise<string | null> {
  if (isVaultShare(session.keyShare?.sealed)) return openShare(session.id, session.keyShare);
  return verifiedPasswordFor(session.id, session.shareUrl) ?? openShare(session.id, session.keyShare);
}

/**
 * The session's password in this browser: a string, null when there is none
 * to be had here, or undefined while it is still being worked out.
 *
 * Keyed on the sealed material and the vault's state, not on the session
 * object: the list hands every row a new object on each poll, and this should
 * not run a key derivation per row every few seconds for the same answer.
 */
export function useSessionPassword(
  session: Pick<SessionRecord, "id" | "shareUrl" | "keyShare">,
): string | null | undefined {
  const { openShare, status } = useVault();
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const sealed = session.keyShare ? `${session.keyShare.senderPublicKey}:${session.keyShare.sealed}` : "";
  useEffect(() => {
    let live = true;
    void readSessionPassword(session, openShare)
      .catch(() => null)
      .then((value) => {
        if (live) setPassword(value);
      });
    return () => {
      live = false;
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- content, not identity */
  }, [session.id, session.shareUrl, sealed, openShare, status]);
  return password;
}
