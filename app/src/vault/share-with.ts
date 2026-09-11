import { shareSessionKeys, type Member, type SessionRecord } from "../lib/api";
import { addToAudience, cachedPassword } from "../lib/session-passwords";
import { keyTrust, trustKey } from "../lib/known-keys";
import type { useVault } from "./VaultProvider";

type Vault = Pick<ReturnType<typeof useVault>, "openShare" | "sealTo">;

/**
 * Seals a session's password to colleagues its owner has just made
 * responsible for it, so they can open it without anyone telling them the
 * password.
 *
 * Skips anyone without a vault yet, and anyone whose vault key has changed
 * since this browser last sealed to them: that is either a reset or a key
 * that is not theirs, and it waits for the owner to confirm it on the session
 * page. Returns who was sealed to.
 */
export async function shareWith(
  vault: Vault,
  owner: string,
  session: Pick<SessionRecord, "id" | "keyShare">,
  recipients: Member[],
): Promise<string[]> {
  /* A proven password before a vault copy nobody can vouch for; see TerminalPane. */
  const cached = cachedPassword(session.id);
  const password =
    (cached?.verified ? cached.password : null) ?? (await vault.openShare(session.id, session.keyShare));
  if (!password) return [];

  const sealed: string[] = [];
  for (const recipient of recipients) {
    if (!recipient.accountKey || recipient.uid === owner) continue;
    if (keyTrust(owner, recipient.uid, recipient.accountKey) === "changed") continue;
    try {
      const share = await vault.sealTo(recipient, session.id, password);
      if (!share) continue;
      await shareSessionKeys(session.id, [
        { uid: recipient.uid, sender_public_key: share.senderPublicKey, sealed: share.sealed },
      ]);
      trustKey(owner, recipient.uid, recipient.accountKey);
      sealed.push(recipient.uid);
    } catch {
      /* Left for the next attempt; the session page offers it again. */
    }
  }
  if (sealed.length > 0) addToAudience(session.id, sealed);
  return sealed;
}
