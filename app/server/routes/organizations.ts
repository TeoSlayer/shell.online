import { DELETED_ACCOUNT_MEMORY_MS, type Store } from "../lib/store";
import type { Identity } from "../lib/firebase-token";
import { invitationMessage, type Mailer } from "../lib/mail";
import {
  INVITE_TTL_MS,
  can,
  checkInvite,
  newId,
  outranks,
  suggestOrgName,
  type Invite,
  type Membership,
  type Role,
} from "../lib/orgs";

export interface Result {
  status: number;
  body: unknown;
}

const ok = (body: unknown): Result => ({ status: 200, body });
const created = (body: unknown): Result => ({ status: 201, body });
const bad = (error: string): Result => ({ status: 400, body: { error } });
const denied = (error: string): Result => ({ status: 403, body: { error } });
const missing = (error: string): Result => ({ status: 404, body: { error } });

/**
 * Everyone belongs to exactly one organization, established on their first
 * authenticated call. Doing it here rather than on a signup screen means an
 * account is never left without one, whichever way it arrived.
 */
export async function ensureMembership(
  store: Store,
  identity: Identity,
  inviteId?: string,
): Promise<{ membership: Membership; joined: boolean; error?: string } | null> {
  const existing = await store.membershipOf(identity.uid);

  if (existing && inviteId) {
    return await acceptAsExistingMember(store, identity, existing, inviteId);
  }
  if (existing) return { membership: existing, joined: false };

  /*
   * Someone who deleted their account moments ago can still present an ID
   * token that verifies, from a tab left open or another browser. Building
   * them a new team from it would quietly undo the deletion, so an account
   * deleted recently gets no membership at all.
   */
  if (await store.recentlyDeleted(identity.uid, Date.now() - DELETED_ACCOUNT_MEMORY_MS)) {
    return null;
  }

  if (inviteId) {
    const check = checkInvite(await store.invite(inviteId), identity.email);
    if (!check.ok) {
      /*
       * A bad invite still gets an organization, because the alternative is an
       * account that belongs nowhere. The reason travels back so the person is
       * told they are on their own rather than left to discover it.
       */
      return { membership: await createOwnOrg(store, identity), joined: false, error: check.reason };
    }
    const claimed = await store.claimInvite(check.invite.id, identity.uid);
    if (!claimed) {
      return {
        membership: await createOwnOrg(store, identity),
        joined: false,
        error: "That invite has already been used or is no longer available.",
      };
    }
    const membership: Membership = {
      orgId: claimed.orgId,
      uid: identity.uid,
      email: identity.email,
      name: identity.name,
      role: claimed.role,
      joinedAt: Date.now(),
    };
    await store.putMembership(membership);
    return { membership, joined: true };
  }

  return { membership: await createOwnOrg(store, identity), joined: false };
}

/**
 * Accepting an invite when you already belong somewhere.
 *
 * Everyone is in exactly one organization, so joining another means leaving
 * the current one. That is fine for the organization created for you at
 * signup, which nobody else is in. It is not fine if you own one with other
 * people in it: leaving would strand them with no owner, so that has to be
 * resolved deliberately first.
 */
async function acceptAsExistingMember(
  store: Store,
  identity: Identity,
  existing: Membership,
  inviteId: string,
): Promise<{ membership: Membership; joined: boolean; error?: string }> {
  const check = checkInvite(await store.invite(inviteId), identity.email);
  if (!check.ok) return { membership: existing, joined: false, error: check.reason };

  if (check.invite.orgId === existing.orgId) {
    return { membership: existing, joined: false, error: "You are already in that organization." };
  }

  const current = await store.members(existing.orgId);
  if (existing.role === "owner" && current.length > 1) {
    const organization = await store.organization(existing.orgId);
    return {
      membership: existing,
      joined: false,
      error:
        `You own ${organization?.name ?? "an organization"} and other people are in it. ` +
        `Hand ownership over or remove the others before joining another.`,
    };
  }

  const claimed = await store.claimInvite(check.invite.id, identity.uid);
  if (!claimed) {
    return {
      membership: existing,
      joined: false,
      error: "That invite has already been used or is no longer available.",
    };
  }

  await store.removeMember(existing.orgId, identity.uid);
  const membership: Membership = {
    orgId: claimed.orgId,
    uid: identity.uid,
    email: identity.email,
    name: identity.name,
    role: claimed.role,
    joinedAt: Date.now(),
  };
  await store.putMembership(membership);
  return { membership, joined: true };
}

async function createOwnOrg(store: Store, identity: Identity): Promise<Membership> {
  const organization = {
    id: newId("org"),
    name: suggestOrgName(identity.email, identity.name),
    createdAt: Date.now(),
    createdBy: identity.uid,
  };
  const membership: Membership = {
    orgId: organization.id,
    uid: identity.uid,
    email: identity.email,
    name: identity.name,
    role: "owner",
    joinedAt: Date.now(),
  };
  /*
   * Signing in fires several requests at once, and on a new account none of
   * them finds a membership. Each would otherwise create an organization and
   * try to claim the same person, and the second insert violates the unique
   * index on uid. Whoever gets there first wins; the rest adopt what they
   * wrote and their organization is rolled back with the attempt.
   */
  return store.claimOwnOrganization(organization, membership);
}

export async function describeOrganization(store: Store, membership: Membership): Promise<Result> {
  const organization = await store.organization(membership.orgId);
  if (!organization) return missing("that organization is gone");
  return ok({
    organization,
    you: membership,
    members: await store.members(membership.orgId),
    /* Invites are only anyone's business if they can act on them. */
    invites: can(membership.role, "invite") ? await store.invites(membership.orgId) : [],
  });
}

export async function renameOrganization(store: Store, membership: Membership, name: string): Promise<Result> {
  if (!can(membership.role, "rename-org")) return denied("only the owner can rename it");
  const trimmed = name.trim();
  if (!trimmed) return bad("give the organization a name");
  if (trimmed.length > 80) return bad("that name is too long");
  await store.renameOrganization(membership.orgId, trimmed);
  return ok({ organization: await store.organization(membership.orgId) });
}

export async function createInvite(
  store: Store,
  membership: Membership,
  input: { role?: string; email?: string },
): Promise<Result> {
  if (!can(membership.role, "invite")) return denied("you cannot invite people");
  const role: Role = input.role === "admin" ? "admin" : "member";
  if (role === "admin" && !can(membership.role, "change-role")) {
    return denied("only the owner can invite an admin");
  }
  const email = (input.email ?? "").trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return bad("that does not look like an email address");
  }

  const invite = {
    id: newId("inv"),
    orgId: membership.orgId,
    createdBy: membership.uid,
    role,
    email: email || undefined,
    createdAt: Date.now(),
    expiresAt: Date.now() + INVITE_TTL_MS,
  };
  await store.putInvite(invite);
  return created({ invite });
}

export async function revokeInvite(store: Store, membership: Membership, id: string): Promise<Result> {
  if (!can(membership.role, "revoke-invite")) return denied("you cannot manage invites");
  const invite = await store.invite(id);
  if (!invite || invite.orgId !== membership.orgId) return missing("no such invite");
  if (invite.acceptedAt) return bad("that invite has already been used");
  await store.updateInvite(id, { revokedAt: Date.now() });
  return ok({ revoked: true });
}

/** What an invite link can say before anyone has signed in. */
export async function previewInvite(store: Store, id: string): Promise<Result> {
  const invite = await store.invite(id);
  if (!invite) return missing("that invite link is not valid");
  const organization = await store.organization(invite.orgId);
  if (!organization) return missing("that organization is gone");

  const usable = !invite.revokedAt && !invite.acceptedAt && invite.expiresAt > Date.now();
  return ok({
    organization: { name: organization.name },
    role: invite.role,
    /* Echoed so the recipient sees which account the invite expects. */
    email: invite.email ?? null,
    usable,
  });
}

export async function removeMember(store: Store, membership: Membership, uid: string): Promise<Result> {
  if (!can(membership.role, "remove-member")) return denied("you cannot remove people");
  if (uid === membership.uid) return bad("you cannot remove yourself");
  const target = (await store.members(membership.orgId)).find((entry) => entry.uid === uid);
  if (!target) return missing("no such member");
  if (!outranks(membership.role, target.role)) {
    return denied(`you cannot remove ${target.role === "owner" ? "the owner" : "another admin"}`);
  }
  await store.removeMember(membership.orgId, uid);
  /*
   * Their copy of the team's audit key goes with them. A copy they already
   * opened cannot be taken back out of their browser, but the service stops
   * handing it to them.
   */
  await store.deleteTeamKeyShare(membership.orgId, uid);
  return ok({ removed: true });
}

export async function changeRole(
  store: Store,
  membership: Membership,
  uid: string,
  role: string,
): Promise<Result> {
  if (!can(membership.role, "change-role")) return denied("only the owner can change roles");
  if (uid === membership.uid) return bad("you cannot change your own role");
  if (role !== "admin" && role !== "member") return bad("unknown role");
  const target = (await store.members(membership.orgId)).find((entry) => entry.uid === uid);
  if (!target) return missing("no such member");
  if (target.role === "owner") return denied("the owner's role cannot be changed");
  await store.setRole(membership.orgId, uid, role);
  return ok({ changed: true });
}

/**
 * Emails an invitation, when there is an address to send it to.
 *
 * Best effort by design. An invite is a link, and the link exists whether or
 * not the mail goes out; failing the request because a mail provider is having
 * a bad afternoon would throw away a perfectly good invite that the inviter
 * can still copy and paste. The failure is reported to the log instead.
 */
export async function notifyInvited(
  store: Store,
  mailer: Mailer,
  webOrigin: string,
  inviter: Membership,
  invite: Invite,
  log: (message: string, error?: unknown) => void,
): Promise<void> {
  if (!invite.email) return;
  const organization = await store.organization(invite.orgId);
  try {
    await mailer.send(
      invitationMessage({
        to: invite.email,
        inviterName: inviter.name || inviter.email,
        organizationName: organization?.name ?? "your team",
        joinUrl: `${webOrigin.replace(/\/+$/, "")}/join/${invite.id}`,
        expiresAt: invite.expiresAt,
      }),
    );
  } catch (error) {
    log(`accounts: could not email the invitation to ${invite.email}`, error);
  }
}
