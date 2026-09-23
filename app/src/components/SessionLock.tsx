import { LockSimple } from "@phosphor-icons/react";
import type { SessionRecord } from "../lib/api";
import { useSessionPassword } from "../vault/use-session-password";

/**
 * A small lock beside a session's name when this browser has no password for
 * it: nothing in the vault, nothing proven here. Opening it will ask for one,
 * and the owner can be asked from that prompt.
 *
 * Nothing is shown while the answer is still being worked out, so a row does
 * not flash locked on every load.
 */
export function SessionLock({ session }: { session: SessionRecord }) {
  const password = useSessionPassword(session);
  if (!session.encrypted || password !== null) return null;
  const label =
    session.passwordRequest?.status === "pending"
      ? "No password in this browser. You asked the owner for it."
      : "No password in this browser";
  return (
    <span className="session-lock" role="img" aria-label={label} title={label}>
      <LockSimple size={12} weight="bold" />
    </span>
  );
}
