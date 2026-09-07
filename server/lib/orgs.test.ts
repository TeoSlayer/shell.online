import { describe, expect, it } from "vitest";
import {
  INVITE_TTL_MS,
  can,
  checkInvite,
  newId,
  outranks,
  suggestOrgName,
  type Invite,
} from "./orgs";

function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    id: "inv_1",
    orgId: "org_1",
    createdBy: "uid-1",
    role: "member",
    createdAt: 1000,
    expiresAt: 1000 + INVITE_TTL_MS,
    ...overrides,
  };
}

describe("suggestOrgName", () => {
  it("uses the company domain for a work address", () => {
    expect(suggestOrgName("alex@vulturelabs.io")).toBe("Vulturelabs");
    expect(suggestOrgName("sam@acme-corp.co.uk")).toBe("Acme-corp");
  });

  it("does not name an organization after an email provider", () => {
    expect(suggestOrgName("ana@gmail.com", "Ana Ferreira")).toBe("Ana's organization");
    expect(suggestOrgName("ana@icloud.com", "Ana Ferreira")).toBe("Ana's organization");
  });

  it("falls back to the local part when there is no display name", () => {
    expect(suggestOrgName("ana@gmail.com")).toBe("Ana's organization");
  });

  it("is case-insensitive about the domain", () => {
    expect(suggestOrgName("ALEX@VultureLabs.IO")).toBe("Vulturelabs");
  });
});

describe("what each role may do", () => {
  it("lets an owner do everything", () => {
    for (const capability of [
      "invite", "revoke-invite", "remove-member", "change-role", "rename-org", "transfer-ownership",
    ] as const) {
      expect(can("owner", capability)).toBe(true);
    }
  });

  it("lets an admin manage people but not the organization itself", () => {
    expect(can("admin", "invite")).toBe(true);
    expect(can("admin", "remove-member")).toBe(true);
    expect(can("admin", "rename-org")).toBe(false);
    expect(can("admin", "change-role")).toBe(false);
    expect(can("admin", "transfer-ownership")).toBe(false);
  });

  it("lets a member do none of it", () => {
    expect(can("member", "invite")).toBe(false);
    expect(can("member", "remove-member")).toBe(false);
  });
});

describe("rank", () => {
  it("stops an admin acting on another admin or the owner", () => {
    /* Otherwise an admin could remove the person who invited them. */
    expect(outranks("admin", "member")).toBe(true);
    expect(outranks("admin", "admin")).toBe(false);
    expect(outranks("admin", "owner")).toBe(false);
  });

  it("lets the owner act on anyone else", () => {
    expect(outranks("owner", "admin")).toBe(true);
    expect(outranks("owner", "member")).toBe(true);
    expect(outranks("owner", "owner")).toBe(false);
  });
});

describe("checkInvite", () => {
  const now = 2000;

  it("accepts a fresh invite", () => {
    expect(checkInvite(invite(), "new@example.com", now).ok).toBe(true);
  });

  it("refuses one that does not exist", () => {
    const result = checkInvite(undefined, "new@example.com", now);
    expect(result).toEqual({ ok: false, reason: "That invite link is not valid." });
  });

  it("refuses a revoked, used or expired invite, each with its own reason", () => {
    expect(checkInvite(invite({ revokedAt: 1500 }), "a@b.c", now)).toMatchObject({
      reason: "That invite has been revoked.",
    });
    expect(checkInvite(invite({ acceptedAt: 1500 }), "a@b.c", now)).toMatchObject({
      reason: "That invite has already been used.",
    });
    expect(checkInvite(invite({ expiresAt: 1500 }), "a@b.c", now)).toMatchObject({
      reason: "That invite has expired.",
    });
  });

  it("holds an address-restricted invite to that address", () => {
    const restricted = invite({ email: "wanted@example.com" });
    expect(checkInvite(restricted, "someone@else.com", now).ok).toBe(false);
    expect(checkInvite(restricted, "wanted@example.com", now).ok).toBe(true);
    /* The address is matched without regard to case. */
    expect(checkInvite(restricted, "WANTED@example.com", now).ok).toBe(true);
  });

  it("cannot be used twice", () => {
    const used = invite({ acceptedAt: now - 1, acceptedBy: "uid-2" });
    expect(checkInvite(used, "a@b.c", now).ok).toBe(false);
  });
});

describe("newId", () => {
  it("prefixes and does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const id = newId("org");
      expect(id.startsWith("org_")).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
