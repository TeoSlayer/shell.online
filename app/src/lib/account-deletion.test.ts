import { describe, expect, it } from "vitest";
import type { Member } from "./api";
import { emailMatches, successorFor } from "./account-deletion";

function member(uid: string, role: Member["role"], joinedAt: number): Member {
  return { orgId: "org_1", uid, email: `${uid}@example.com`, name: uid, role, joinedAt };
}

describe("successorFor", () => {
  it("hands the team to the longest-standing admin", () => {
    const members = [
      member("owner", "owner", 1),
      member("early-member", "member", 2),
      member("late-admin", "admin", 4),
      member("early-admin", "admin", 3),
    ];
    expect(successorFor(members, "owner")?.uid).toBe("early-admin");
  });

  it("falls back to the longest-standing member when there is no admin", () => {
    const members = [member("owner", "owner", 1), member("b", "member", 3), member("a", "member", 2)];
    expect(successorFor(members, "owner")?.uid).toBe("a");
  });

  it("names nobody when the owner is alone", () => {
    expect(successorFor([member("owner", "owner", 1)], "owner")).toBeUndefined();
  });

  it("breaks a tie on the uid, as the service does", () => {
    const members = [member("owner", "owner", 1), member("zed", "admin", 2), member("amy", "admin", 2)];
    expect(successorFor(members, "owner")?.uid).toBe("amy");
  });
});

describe("emailMatches", () => {
  it("ignores case and surrounding spaces", () => {
    expect(emailMatches("  Ana@Example.com ", "ana@example.com")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(emailMatches("ana@example.co", "ana@example.com")).toBe(false);
    expect(emailMatches("", "")).toBe(false);
    expect(emailMatches("ana@example.com", null)).toBe(false);
  });
});
