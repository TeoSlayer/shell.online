import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, avatarColor, displayName, findPerson, initials, shortName } from "./people";

const ana = { uid: "uid-1", name: "Ana Ferreira", email: "ana@example.com" };
const single = { uid: "uid-2", name: "Prince", email: "prince@example.com" };
const nameless = { uid: "uid-3", email: "bruno.silva@example.com" };
const bare = { uid: "uid-4" };

describe("avatarColor", () => {
  it("is stable for the same person", () => {
    expect(avatarColor("uid-1")).toBe(avatarColor("uid-1"));
  });

  it("always comes from the palette", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(AVATAR_COLORS).toContain(avatarColor(`uid-${i}`));
    }
  });

  it("spreads people across the palette rather than clustering", () => {
    const used = new Set(Array.from({ length: 60 }, (_, i) => avatarColor(`uid-${i}`)));
    expect(used.size).toBeGreaterThan(AVATAR_COLORS.length / 2);
  });

  it("handles an empty id without throwing", () => {
    expect(AVATAR_COLORS).toContain(avatarColor(""));
  });
});

describe("displayName", () => {
  it("prefers the name", () => {
    expect(displayName(ana)).toBe("Ana Ferreira");
  });

  it("falls back to the email's local part, never the id", () => {
    expect(displayName(nameless)).toBe("bruno.silva");
    expect(displayName(bare)).toBe("Unknown");
    expect(displayName(bare)).not.toContain("uid");
  });

  it("survives a missing person", () => {
    expect(displayName(null)).toBe("Unknown");
    expect(displayName(undefined)).toBe("Unknown");
  });

  it("ignores a name that is only whitespace", () => {
    expect(displayName({ uid: "x", name: "   ", email: "a@b.c" })).toBe("a");
  });
});

describe("shortName", () => {
  it("abbreviates the surname", () => {
    expect(shortName(ana)).toBe("Ana F.");
  });

  it("leaves a single name alone", () => {
    expect(shortName(single)).toBe("Prince");
  });
});

describe("initials", () => {
  it("takes first and last from a full name", () => {
    expect(initials(ana)).toBe("AF");
    expect(initials({ uid: "x", name: "Ana Maria Ferreira" })).toBe("AF");
  });

  it("takes two letters from a single name", () => {
    expect(initials(single)).toBe("PR");
  });

  it("uses the email when there is no name", () => {
    expect(initials(nameless)).toBe("BR");
  });

  it("never derives initials from an account id", () => {
    expect(initials(bare)).toBe("?");
  });

  it("survives a missing person", () => {
    expect(initials(null)).toBe("?");
  });
});

describe("findPerson", () => {
  it("finds by id and copes with an absent one", () => {
    expect(findPerson([ana, single], "uid-2")).toBe(single);
    expect(findPerson([ana], "nope")).toBeUndefined();
    expect(findPerson([ana], undefined)).toBeUndefined();
  });
});
