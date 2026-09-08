import { describe, expect, it } from "vitest";
import { LINKED_PARAM, wasJustLinked, withoutLinkedFlag } from "./linked";

describe("wasJustLinked", () => {
  it("recognises the flag the CLI redirects with", () => {
    expect(wasJustLinked("?linked=1")).toBe(true);
    expect(wasJustLinked(new URLSearchParams({ linked: "1" }))).toBe(true);
  });

  it("ignores anything else", () => {
    expect(wasJustLinked("")).toBe(false);
    expect(wasJustLinked("?linked=0")).toBe(false);
    expect(wasJustLinked("?linked=yes")).toBe(false);
    expect(wasJustLinked("?tab=machines")).toBe(false);
  });

  /* The path the CLI actually sends, kept in step with login.go. */
  it("matches the URL internal/account/login.go redirects to", () => {
    const target = new URL("http://localhost:5173/sessions?linked=1");
    expect(target.pathname).toBe("/sessions");
    expect(wasJustLinked(target.search)).toBe(true);
  });
});

describe("withoutLinkedFlag", () => {
  it("removes only the flag", () => {
    expect(withoutLinkedFlag("?linked=1&tab=machines").toString()).toBe("tab=machines");
  });

  it("leaves a query that never had it alone", () => {
    expect(withoutLinkedFlag("?tab=machines").toString()).toBe("tab=machines");
    expect(withoutLinkedFlag("").toString()).toBe("");
  });

  it("does not mutate what it was given", () => {
    const original = new URLSearchParams({ [LINKED_PARAM]: "1" });
    withoutLinkedFlag(original);
    expect(original.get(LINKED_PARAM)).toBe("1");
  });
});
