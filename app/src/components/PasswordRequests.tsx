import { useState } from "react";
import { Check, Key, Warning, X } from "@phosphor-icons/react";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { answerPasswordRequest, type Member, type PasswordRequest, type SessionRecord } from "../lib/api";
import { keyTrust, trustKey } from "../lib/known-keys";
import { displayName, findPerson } from "../lib/people";
import { PASSWORD_REQUESTS_ANCHOR } from "../lib/password-requests";
import { addToAudience } from "../lib/session-passwords";
import { ago } from "../lib/time";
import { useVault } from "../vault/VaultProvider";
import { useSessionPassword } from "../vault/use-session-password";

/* Enough history to see who was let in recently, without becoming a log. */
const ANSWERED_SHOWN = 10;

/**
 * Where a session's owner answers requests for its password.
 *
 * Accepting seals the password, in this browser, to the asker's vault and
 * sends that copy with the answer; the service could not do it for them,
 * since it holds no copy it can open. Declining sends nothing but the answer.
 * Either way the asker's prompt shows the result on its next poll, and an
 * accepted one opens by itself.
 */
export function PasswordRequests({
  session,
  requests,
  members,
  you,
  onChanged,
}: {
  session: SessionRecord;
  requests: PasswordRequest[];
  members: Member[];
  you: Member;
  onChanged: () => Promise<void> | void;
}) {
  const vault = useVault();
  const password = useSessionPassword(session);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /* Someone whose vault key changed, waiting for the owner to say go ahead. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /*
   * Answered here, shown as answered before the next load catches up. Keyed
   * by the ask's time as well, so asking again after an answer is a new row
   * rather than one this browser already answered.
   */
  const [answered, setAnswered] = useState<Record<string, { status: PasswordRequest["status"]; at: number }>>({});
  const answerKey = (request: PasswordRequest) => `${request.requesterUid}\u0000${request.requestedAt}`;

  const view = requests.map((request) => {
    const local = request.status === "pending" ? answered[answerKey(request)] : undefined;
    return local ? { ...request, status: local.status, resolvedAt: local.at } : request;
  });
  const pending = view.filter((request) => request.status === "pending");
  const done = view
    .filter((request) => request.status !== "pending")
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    .slice(0, ANSWERED_SHOWN);

  async function accept(request: PasswordRequest, confirmedChange = false) {
    const uid = request.requesterUid;
    const member = findPerson(members, uid);
    setError("");
    if (!member) {
      setError("They are no longer in this team.");
      return;
    }
    if (!member.accountKey) {
      setError(`${displayName(member)} has no vault to seal the password to yet.`);
      return;
    }
    if (!password) {
      setError("This browser cannot open the session's password. Unlock your vault, then accept.");
      return;
    }
    /*
     * A key this browser has sealed to before, and that has since changed, is
     * either a colleague who reset their vault or a key that is not theirs.
     * Nothing is sealed to it until the owner has seen that and said so.
     */
    if (keyTrust(you.uid, uid, member.accountKey) === "changed" && !confirmedChange) {
      setConfirming(uid);
      return;
    }
    setConfirming(null);
    setBusy(uid);
    try {
      const share = await vault.sealTo(member, session.id, password);
      if (!share) throw new Error(`${displayName(member)} has no vault to seal the password to yet.`);
      await answerPasswordRequest(session.id, uid, {
        decision: "approve",
        share: { sender_public_key: share.senderPublicKey, sealed: share.sealed },
      });
      trustKey(you.uid, uid, member.accountKey);
      addToAudience(session.id, [uid]);
      setAnswered((current) => ({ ...current, [answerKey(request)]: { status: "approved", at: Date.now() } }));
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not share the password.");
    } finally {
      setBusy("");
    }
  }

  async function decline(request: PasswordRequest) {
    const uid = request.requesterUid;
    setError("");
    setConfirming(null);
    setBusy(uid);
    try {
      await answerPasswordRequest(session.id, uid, { decision: "decline" });
      setAnswered((current) => ({ ...current, [answerKey(request)]: { status: "declined", at: Date.now() } }));
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not decline the request.");
    } finally {
      setBusy("");
    }
  }

  const waiting = confirming ? findPerson(members, confirming) : undefined;
  const waitingRequest = confirming ? pending.find((request) => request.requesterUid === confirming) : undefined;

  return (
    <section id={PASSWORD_REQUESTS_ANCHOR} className="password-requests" tabIndex={-1}>
      <h2 className="detail-heading">
        <Key size={15} weight="bold" />
        Password requests
        {pending.length > 0 && <span className="clip-count" data-waiting="true">{pending.length}</span>}
      </h2>

      {pending.length === 0 ? (
        <p className="detail-empty">
          Nobody is waiting. Teammates without the password can ask you for it from the terminal&apos;s
          password prompt, and their request shows up here.
        </p>
      ) : (
        <ul className="password-requests-list">
          {pending.map((request) => {
            const person = findPerson(members, request.requesterUid);
            return (
              <li key={request.requesterUid}>
                <Avatar person={person} size="xs" />
                <span className="password-requests-who">
                  <b>{person ? displayName(person) : "A former member"}</b>
                  <time dateTime={new Date(request.requestedAt).toISOString()}>
                    asked {ago(request.requestedAt, Date.now())}
                  </time>
                </span>
                <span className="password-requests-actions">
                  <Button
                    type="button"
                    busy={busy === request.requesterUid}
                    busyLabel="Sharing"
                    disabled={Boolean(busy) || !person?.accountKey || !password}
                    onClick={() => void accept(request)}
                  >
                    <Check size={14} weight="bold" />
                    Accept
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={Boolean(busy)}
                    onClick={() => void decline(request)}
                  >
                    <X size={14} weight="bold" />
                    Decline
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {pending.length > 0 && password === null && (
        <p className="password-requests-note">
          This browser cannot open the session&apos;s password, so it has nothing to share yet. Unlock your
          vault to accept. You can still decline.
        </p>
      )}

      {waiting && waitingRequest && (
        <div className="audience-confirm" role="alert">
          <p>
            <Warning size={14} weight="fill" />
            <span>
              {displayName(waiting)}&apos;s vault key has changed since you last shared with them. That
              happens when someone resets their vault. If you did not expect it, check with them before
              sharing.
            </span>
          </p>
          <div className="audience-confirm-actions">
            <Button type="button" variant="ghost" onClick={() => void accept(waitingRequest, true)}>
              Share anyway
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {done.length > 0 && (
        <ul className="password-requests-done">
          {done.map((request) => {
            const person = findPerson(members, request.requesterUid);
            return (
              <li key={request.requesterUid} data-status={request.status}>
                {request.status === "approved" ? <Check size={13} weight="bold" /> : <X size={13} weight="bold" />}
                <span>
                  {person ? displayName(person) : "A former member"}
                  {request.status === "approved" ? " was given the password" : " was declined"}
                  {request.resolvedAt ? ` ${ago(request.resolvedAt, Date.now())}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="audience-error">{error}</p>}
    </section>
  );
}
