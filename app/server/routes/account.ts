import type { Store } from "../lib/store";
import type { Identity } from "../lib/firebase-token";
import { successorFor } from "../lib/orgs";
import { RESET_SIGN_IN_WINDOW_MS } from "../lib/vault";
import type { Result } from "./organizations";

/**
 * Deletes the caller's account from this service.
 *
 * Two checks stand in front of it: the account's email address typed back, so
 * a stray request cannot do this by accident, and a sign-in from the last few
 * minutes, the proof of presence a vault reset asks for, so a token lifted
 * from an idle browser cannot either.
 *
 * The Firebase account is deleted by the browser afterwards. This service
 * verifies Firebase tokens and holds no credential that could manage them.
 */
export async function deleteAccount(
  store: Store,
  identity: Identity,
  confirm: unknown,
  now = Date.now(),
): Promise<Result> {
  const email = identity.email.trim().toLowerCase();
  if (typeof confirm !== "string" || !email || confirm.trim().toLowerCase() !== email) {
    return { status: 400, body: { error: "Type your account's email address to confirm." } };
  }
  if (!identity.authTime || now - identity.authTime > RESET_SIGN_IN_WINDOW_MS) {
    return {
      status: 403,
      body: {
        error: "Deleting your account needs a recent sign-in. Sign in again and retry.",
        reauthenticate: true,
      },
    };
  }

  const membership = await store.membershipOf(identity.uid);
  const members = membership ? await store.members(membership.orgId) : [];
  const others = members.filter((entry) => entry.uid !== identity.uid);
  /* An owner hands the team over; anyone else simply leaves it. */
  const successor = membership?.role === "owner" ? successorFor(members, identity.uid) : undefined;

  await store.deleteAccount(
    identity.uid,
    {
      orgId: membership?.orgId,
      dissolve: membership !== null && others.length === 0,
      successorUid: successor?.uid,
    },
    now,
  );
  return {
    status: 200,
    body: {
      deleted: true,
      owner: successor ? { uid: successor.uid, email: successor.email, name: successor.name } : null,
    },
  };
}
