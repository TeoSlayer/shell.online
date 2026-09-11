import { useEffect, useState } from "react";
import { UserPlus, Warning } from "@phosphor-icons/react";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { PersonPicker } from "./PersonPicker";
import { shareSessionKeys, type Member, type SessionRecord } from "../lib/api";
import { addToAudience, audienceFor, passwordFor } from "../lib/session-passwords";
import { keyTrust, trustKey } from "../lib/known-keys";
import { displayName } from "../lib/people";
import { useVault } from "../vault/VaultProvider";

/**
 * Who else can open this session.
 *
 * The password is sealed once per person, to their vault, so this list is the
 * whole of the answer: a colleague who is not on it holds nothing, whatever
 * the session says about who it is assigned to.
 *
 * Only ever adds. Removing somebody here would not reach into their vault and
 * take back the copy they hold, so a control that offered it would be
 * describing something that did not happen.
 */
export function SessionAudience({
  session,
  members,
  you,
}: {
  session: SessionRecord;
  members: Member[];
  you: Member | null;
}) {
  const vault = useVault();
  const [audience, setAudience] = useState<string[]>(() => audienceFor(session.id));
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /* Someone whose vault key changed, waiting for the owner to say go ahead. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const isOwner = Boolean(you && session.ownerUid === you.uid);
  const sealed = session.keyShare ? `${session.keyShare.senderPublicKey}:${session.keyShare.sealed}` : "";

  /* Only somebody holding the password has anything to seal. */
  useEffect(() => {
    let live = true;
    void (async () => {
      const opened = passwordFor(session.id) ?? (await vault.openShare(session.id, session.keyShare));
      if (live) setPassword(opened);
    })();
    return () => {
      live = false;
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- content, not identity */
  }, [session.id, sealed, vault.openShare]);

  if (!isOwner || !password || !you) return null;

  /* Who holds a copy: what the service stores, and what this browser has sent. */
  const holders = new Set([...(session.sharedWith ?? []), ...audience]);
  const shared = members.filter((member) => member.uid !== you.uid && holders.has(member.uid));
  const candidates = members.filter(
    (member) => member.uid !== you.uid && !holders.has(member.uid) && Boolean(member.accountKey),
  );

  async function add(uid: string, confirmedChange = false) {
    const member = members.find((candidate) => candidate.uid === uid);
    if (!member?.accountKey || !password || !you) return;

    /*
     * A key this browser has sealed to before, and that has since changed, is
     * either a colleague who reset their vault or a key that is not theirs.
     * Nothing is sealed to it until the owner has seen that and said so.
     */
    if (keyTrust(you.uid, member.uid, member.accountKey) === "changed" && !confirmedChange) {
      setConfirming(uid);
      return;
    }

    setBusy(uid);
    setError("");
    setConfirming(null);
    try {
      const share = await vault.sealTo(member, session.id, password);
      if (!share) throw new Error(`${displayName(member)} has not set up a vault yet.`);
      await shareSessionKeys(session.id, [
        { uid: member.uid, sender_public_key: share.senderPublicKey, sealed: share.sealed },
      ]);
      trustKey(you.uid, member.uid, member.accountKey);
      const kept = addToAudience(session.id, [uid]);
      setAudience((current) => [...new Set([...current, ...kept, uid])]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not share the session.");
    } finally {
      setBusy("");
    }
  }

  const waiting = confirming ? members.find((member) => member.uid === confirming) : undefined;

  return (
    <section className="audience">
      <h2 className="detail-heading">Who can open it</h2>

      {shared.length === 0 ? (
        <p className="detail-empty">Only you. Add someone and they can open it straight away.</p>
      ) : (
        <ul className="audience-list">
          {shared.map((member) => {
            const changed =
              member.accountKey && keyTrust(you.uid, member.uid, member.accountKey) === "changed";
            return (
              <li key={member.uid}>
                <Avatar person={member} size="xs" />
                {displayName(member)}
                {changed && (
                  <button
                    type="button"
                    className="vault-link"
                    onClick={() => void add(member.uid)}
                    disabled={busy === member.uid}
                  >
                    Share again
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {waiting && (
        <div className="audience-confirm" role="alert">
          <p>
            <Warning size={14} weight="fill" />
            <span>
              {displayName(waiting)}&apos;s vault key has changed since you last
              shared with them. That happens when someone resets their vault. If
              you did not expect it, check with them before sharing.
            </span>
          </p>
          <div className="audience-confirm-actions">
            <Button type="button" variant="ghost" onClick={() => void add(waiting.uid, true)}>
              Share anyway
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="audience-add">
          <UserPlus size={15} weight="bold" />
          <PersonPicker
            people={candidates}
            value={undefined}
            label="Add someone to this session"
            placeholder={busy ? "Sharing" : "Add someone"}
            onChange={(uid) => void add(uid)}
          />
        </div>
      )}

      {error && <p className="audience-error">{error}</p>}
    </section>
  );
}
