import type { Comment, Notification, Store } from "../lib/store";
import { newId, type Membership } from "../lib/orgs";
import { findMentions } from "../lib/mentions";

export const MAX_COMMENT = 4000;

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

/**
 * Adds a comment to a session and notifies whoever it mentions.
 *
 * Notifying is derived from the same parse the reader sees, so nobody is
 * notified about a mention that is not visible, and nobody visible is missed.
 */
export async function addComment(
  store: Store,
  membership: Membership,
  sessionId: string,
  body: string,
): Promise<Outcome<Comment>> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, status: 400, error: "write something first" };
  if (trimmed.length > MAX_COMMENT) {
    return { ok: false, status: 400, error: "that comment is too long" };
  }
  const session = await store.sessionInOrg(membership.orgId, sessionId);
  if (!session) return { ok: false, status: 404, error: "no such session" };

  const members = await store.members(membership.orgId);
  const mentions = findMentions(trimmed, members)
    /* Mentioning yourself is not news. */
    .filter((uid) => uid !== membership.uid);

  const comment: Comment = {
    id: newId("cmt"),
    orgId: membership.orgId,
    sessionId,
    authorUid: membership.uid,
    body: trimmed,
    at: Date.now(),
    mentions,
  };
  await store.putComment(comment);

  for (const uid of mentions) {
    await store.putNotification({
      id: newId("ntf"),
      orgId: membership.orgId,
      uid,
      kind: "mention",
      sessionId,
      actorUid: membership.uid,
      body: trimmed.slice(0, 200),
      at: comment.at,
    });
  }

  return { ok: true, value: comment };
}

/** Tells someone a session is now theirs. */
export async function notifyAssigned(
  store: Store,
  membership: Membership,
  sessionId: string,
  assigneeUid: string,
  sessionLabel: string,
): Promise<void> {
  /* Assigning to yourself is not news either. */
  if (assigneeUid === membership.uid) return;
  await store.putNotification({
    id: newId("ntf"),
    orgId: membership.orgId,
    uid: assigneeUid,
    kind: "assigned",
    sessionId,
    actorUid: membership.uid,
    body: sessionLabel,
    at: Date.now(),
  });
}

/**
 * Tells the rest of the organization that a session has started.
 *
 * The quietest of the three: it is informational, and everyone gets one for
 * every session a colleague starts, so it must not shout the way an
 * assignment does.
 */
export async function notifySessionStarted(
  store: Store,
  orgId: string,
  ownerUid: string,
  sessionId: string,
  label: string,
): Promise<void> {
  for (const member of await store.members(orgId)) {
    if (member.uid === ownerUid) continue;
    await store.putNotification({
      id: newId("ntf"),
      orgId,
      uid: member.uid,
      kind: "shared",
      sessionId,
      actorUid: ownerUid,
      body: label,
      at: Date.now(),
    });
  }
}

export async function inbox(
  store: Store,
  membership: Membership,
): Promise<{ notifications: Notification[]; unread: number; unreadAssignments: number }> {
  const notifications = await store.notificationsFor(membership.uid);
  return {
    notifications,
    unread: notifications.filter((entry) => !entry.readAt).length,
    /* Counted apart, because an assignment deserves more attention than a
       mention and the UI shows them differently. */
    unreadAssignments: notifications.filter(
      (entry) => !entry.readAt && entry.kind === "assigned",
    ).length,
  };
}
