import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INVITE_TTL_MS,
  can,
  checkInvite,
  newId,
  outranks,
  successorFor,
  suggestOrgName,
  type Invite,
  type Membership,
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

describe("successorFor", () => {
  function member(uid: string, role: Membership["role"], joinedAt: number): Membership {
    return { orgId: "org_1", uid, email: `${uid}@example.com`, name: uid, role, joinedAt };
  }

  it("prefers the longest-standing admin over an earlier member", () => {
    const members = [
      member("owner", "owner", 1),
      member("early-member", "member", 2),
      member("late-admin", "admin", 4),
      member("early-admin", "admin", 3),
    ];
    expect(successorFor(members, "owner")?.uid).toBe("early-admin");
  });

  it("falls back to the longest-standing member", () => {
    const members = [member("owner", "owner", 1), member("b", "member", 3), member("a", "member", 2)];
    expect(successorFor(members, "owner")?.uid).toBe("a");
  });

  it("names nobody for an owner who is alone", () => {
    expect(successorFor([member("owner", "owner", 1)], "owner")).toBeUndefined();
  });
});

describe("suggestOrgName", () => {
  it("uses the company domain for a work address", async () => {
    expect(suggestOrgName("alex@vulturelabs.io")).toBe("Vulturelabs");
    expect(suggestOrgName("sam@acme-corp.co.uk")).toBe("Acme-corp");
  });

  it("does not name an organization after an email provider", async () => {
    expect(suggestOrgName("ana@gmail.com", "Ana Ferreira")).toBe("Ana's organization");
    expect(suggestOrgName("ana@icloud.com", "Ana Ferreira")).toBe("Ana's organization");
  });

  it("falls back to the local part when there is no display name", async () => {
    expect(suggestOrgName("ana@gmail.com")).toBe("Ana's organization");
  });

  it("is case-insensitive about the domain", async () => {
    expect(suggestOrgName("ALEX@VultureLabs.IO")).toBe("Vulturelabs");
  });
});

describe("what each role may do", () => {
  it("lets an owner do everything", async () => {
    for (const capability of [
      "invite", "revoke-invite", "remove-member", "change-role", "rename-org", "transfer-ownership",
    ] as const) {
      expect(can("owner", capability)).toBe(true);
    }
  });

  it("lets an admin manage people but not the organization itself", async () => {
    expect(can("admin", "invite")).toBe(true);
    expect(can("admin", "remove-member")).toBe(true);
    expect(can("admin", "rename-org")).toBe(false);
    expect(can("admin", "change-role")).toBe(false);
    expect(can("admin", "transfer-ownership")).toBe(false);
  });

  it("lets a member do none of it", async () => {
    expect(can("member", "invite")).toBe(false);
    expect(can("member", "remove-member")).toBe(false);
  });
});

describe("rank", () => {
  it("stops an admin acting on another admin or the owner", async () => {
    /* Otherwise an admin could remove the person who invited them. */
    expect(outranks("admin", "member")).toBe(true);
    expect(outranks("admin", "admin")).toBe(false);
    expect(outranks("admin", "owner")).toBe(false);
  });

  it("lets the owner act on anyone else", async () => {
    expect(outranks("owner", "admin")).toBe(true);
    expect(outranks("owner", "member")).toBe(true);
    expect(outranks("owner", "owner")).toBe(false);
  });
});

describe("checkInvite", () => {
  const now = 2000;

  it("accepts a fresh invite", async () => {
    expect(checkInvite(invite(), "new@example.com", now).ok).toBe(true);
  });

  it("refuses one that does not exist", async () => {
    const result = checkInvite(undefined, "new@example.com", now);
    expect(result).toEqual({ ok: false, reason: "That invite link is not valid." });
  });

  it("refuses a revoked, used or expired invite, each with its own reason", async () => {
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

  it("holds an address-restricted invite to that address", async () => {
    const restricted = invite({ email: "wanted@example.com" });
    expect(checkInvite(restricted, "someone@else.com", now).ok).toBe(false);
    expect(checkInvite(restricted, "wanted@example.com", now).ok).toBe(true);
    /* The address is matched without regard to case. */
    expect(checkInvite(restricted, "WANTED@example.com", now).ok).toBe(true);
  });

  it("cannot be used twice", async () => {
    const used = invite({ acceptedAt: now - 1, acceptedBy: "uid-2" });
    expect(checkInvite(used, "a@b.c", now).ok).toBe(false);
  });
});

describe("newId", () => {
  it("prefixes and does not repeat", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const id = newId("org");
      expect(id.startsWith("org_")).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

/*
 * The sign-up form shows a suggested organization name as its placeholder,
 * derived by src/lib/team-name.ts, and this file is what the service falls back
 * to when the rename after sign-up does not land. Two different answers would
 * mean the organization is not called what the placeholder promised, so the
 * personal-domain lists have to stay identical -- checked here rather than
 * trusted, since they are two files in two directories that nothing else ties
 * together.
 */
describe("the personal domains the sign-up form knows", () => {
  it("match the ones the service falls back on", () => {
    const domainsIn = (path: string) => {
      const source = readFileSync(path, "utf8");
      const block = source.slice(source.indexOf("const PERSONAL_DOMAINS"));
      const list = block.slice(0, block.indexOf("]);"));
      return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    };
    expect(domainsIn("src/lib/team-name.ts")).toEqual(domainsIn("server/lib/orgs.ts"));
  });
});
