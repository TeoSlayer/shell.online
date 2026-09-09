import { useEffect, useState } from "react";
import { UserPlus } from "@phosphor-icons/react";
import { Avatar } from "./Avatar";
import { PersonPicker } from "./PersonPicker";
import { shareSessionKeys, type Member, type SessionRecord } from "../lib/api";
import { openSealed, sealForMembers } from "../lib/keypair";
import { addToAudience, audienceFor, passwordFor } from "../lib/session-passwords";
import { displayName } from "../lib/people";

/**
 * Who else can open this session.
 *
 * The password is sealed once per person, so this list is the whole of the
 * answer: a colleague who is not on it holds nothing, whatever the session
 * says about who it is assigned to. Assigning a session to somebody used to
 * appear to hand it over because the password had already gone to everyone.
 *
 * Only ever adds. Removing somebody here would not reach into their browser
 * and take back the copy they hold, so a control that offered it would be
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
  const [audience, setAudience] = useState<string[]>(() => audienceFor(session.id));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [held, setHeld] = useState(false);

  const isOwner = Boolean(you && session.ownerUid === you.uid);

  /* Only somebody holding the password has anything to seal. */
  useEffect(() => {
    let live = true;
    void (async () => {
      const own = passwordFor(session.id);
      if (own) return live && setHeld(true);
      const share = session.keyShare;
      const opened = share ? await openSealed(share.senderPublicKey, share.sealed) : null;
      if (live) setHeld(Boolean(opened));
    })();
    return () => {
      live = false;
    };
  }, [session]);

  if (!isOwner || !held) return null;

  const shared = members.filter((member) => audience.includes(member.uid));
  const candidates = members.filter(
    (member) =>
      member.uid !== you?.uid && !audience.includes(member.uid) && Boolean(member.publicKey),
  );

  async function add(uid: string) {
    const member = members.find((candidate) => candidate.uid === uid);
    if (!member?.publicKey) return;
    const password = passwordFor(session.id);
    if (!password) return setError("This browser no longer holds the password for this session.");

    setBusy(uid);
    setError("");
    try {
      const sealed = await sealForMembers([member], password);
      await shareSessionKeys(
        session.id,
        sealed.map((entry) => ({
          uid: entry.uid,
          sender_public_key: entry.senderPublicKey,
          sealed: entry.sealed,
        })),
      );
      setAudience(addToAudience(session.id, [uid]));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not share the session.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="audience">
      <h2 className="detail-heading">Who can open it</h2>

      {shared.length === 0 ? (
        <p className="detail-empty">Only you. Add someone and they can open it straight away.</p>
      ) : (
        <ul className="audience-list">
          {shared.map((member) => (
            <li key={member.uid}>
              <Avatar person={member} size="xs" />
              {displayName(member)}
            </li>
          ))}
        </ul>
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
