import { randomBytes } from "node:crypto";

/**
 * Organizations, membership and invites.
 *
 * Everyone belongs to exactly one organization. Signing up creates one unless
 * an invite is presented, which is what makes "see your colleagues' sessions"
 * a property of the account rather than something to configure afterwards.
 */

export type Role = "owner" | "admin" | "member";

export interface Organization {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
}

export interface Membership {
  orgId: string;
  uid: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: number;
  /**
   * This person's browser key, published so colleagues can seal a session
   * password to them. Absent until they have signed in somewhere.
   */
  publicKey?: string;
  /**
   * Their session vault's public key, once they have set one up. Session
   * passwords shared with them are sealed to this, so every browser they
   * unlock can open them. Read from the vault, never written through here.
   */
  accountKey?: string;
}

export interface Invite {
  id: string;
  orgId: string;
  createdBy: string;
  role: Exclude<Role, "owner">;
  /** When set, only this address may accept. */
  email?: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  acceptedBy?: string;
  revokedAt?: number;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/**
 * A default name for the organization created at signup.
 *
 * Derived from the email domain when that is a real company, so a team signing
 * up lands somewhere recognisable. Personal providers get the local part
 * instead, since "Gmail" would be nobody's organization.
 */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com",
  "fastmail.com", "hey.com", "aol.com", "gmx.com", "zoho.com",
]);

export function suggestOrgName(email: string, displayName?: string): string {
  const [local, domain] = email.toLowerCase().split("@");
  if (domain && !PERSONAL_DOMAINS.has(domain)) {
    const label = domain.split(".")[0] ?? domain;
    return titleCase(label);
  }
  const person = (displayName ?? "").trim();
  if (person) return `${person.split(/\s+/)[0]}'s organization`;
  return `${titleCase(local ?? "personal")}'s organization`;
}

function titleCase(value: string): string {
  if (!value) return "Organization";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* ---------------------------------------------------------------
   What each role may do
   --------------------------------------------------------------- */

export type Capability =
  | "invite"
  | "revoke-invite"
  | "remove-member"
  | "change-role"
  | "rename-org"
  | "transfer-ownership";

const CAPABILITIES: Record<Role, Capability[]> = {
  owner: [
    "invite",
    "revoke-invite",
    "remove-member",
    "change-role",
    "rename-org",
    "transfer-ownership",
  ],
  admin: ["invite", "revoke-invite", "remove-member"],
  member: [],
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES[role].includes(capability);
}

/**
 * Whether `actor` may act on `target`.
 *
 * Rank matters as well as capability: an admin may remove a member but not
 * another admin, and nobody may act on the owner. Without this an admin could
 * remove the person who invited them.
 */
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

/**
 * Who takes over when an owner deletes their account.
 *
 * The longest-standing admin, who already helps run the team, and failing that
 * the longest-standing member. Undefined when nobody else is in it, in which
 * case the organization goes with its owner. A tie on joinedAt falls to the
 * uid, so the answer never depends on the order rows come back in.
 */
export function successorFor(members: Membership[], leavingUid: string): Membership | undefined {
  const others = members.filter((entry) => entry.uid !== leavingUid);
  const byTenure = (a: Membership, b: Membership) =>
    a.joinedAt - b.joinedAt || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  return (
    others.filter((entry) => entry.role === "admin").sort(byTenure)[0] ??
    others.sort(byTenure)[0]
  );
}

export type InviteCheck =
  | { ok: true; invite: Invite }
  | { ok: false; reason: string };

export function checkInvite(
  invite: Invite | undefined,
  email: string,
  now = Date.now(),
): InviteCheck {
  if (!invite) return { ok: false, reason: "That invite link is not valid." };
  if (invite.revokedAt) return { ok: false, reason: "That invite has been revoked." };
  if (invite.acceptedAt) return { ok: false, reason: "That invite has already been used." };
  if (invite.expiresAt <= now) return { ok: false, reason: "That invite has expired." };
  if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
    return { ok: false, reason: "That invite was issued for a different email address." };
  }
  return { ok: true, invite };
}
