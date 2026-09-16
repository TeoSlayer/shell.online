import { describe, expect, it } from "vitest";
import { excludedAccountFilter, isExcludedAccount, parseExcludedAccounts } from "./internal-accounts";

describe("parseExcludedAccounts", () => {
  it("reads a list however it was written, and nothing from an unset variable", () => {
    expect(parseExcludedAccounts("a@example.com, b.com;  @c.org\nD@Example.com")).toEqual([
      "a@example.com",
      "b.com",
      "@c.org",
      "d@example.com",
    ]);
    expect(parseExcludedAccounts(undefined)).toEqual([]);
    expect(parseExcludedAccounts("  ")).toEqual([]);
  });
});

describe("isExcludedAccount", () => {
  const rules = parseExcludedAccounts("ours.example, @tools.example, someone@mail.example");

  it("excludes a domain and its subdomains, written either way", () => {
    expect(isExcludedAccount(rules, "a@ours.example")).toBe(true);
    expect(isExcludedAccount(rules, "a@eng.ours.example")).toBe(true);
    expect(isExcludedAccount(rules, "a@tools.example")).toBe(true);
    expect(isExcludedAccount(rules, "a@notours.example")).toBe(false);
    /* A domain rule must not match a company whose name merely ends the same way. */
    expect(isExcludedAccount(rules, "a@theirours.example")).toBe(false);
  });

  it("excludes one named address without touching the rest of its provider", () => {
    expect(isExcludedAccount(rules, "someone@mail.example")).toBe(true);
    expect(isExcludedAccount(rules, "SomeOne@Mail.Example")).toBe(true);
    expect(isExcludedAccount(rules, "someone.else@mail.example")).toBe(false);
  });

  it("sees through a +tag on either side", () => {
    expect(isExcludedAccount(rules, "someone+shell@mail.example")).toBe(true);
    expect(isExcludedAccount(parseExcludedAccounts("someone+old@mail.example"), "someone@mail.example")).toBe(true);
  });

  it("excludes nobody on an empty list or a missing address", () => {
    expect(isExcludedAccount([], "a@ours.example")).toBe(false);
    expect(isExcludedAccount(rules, "")).toBe(false);
    expect(isExcludedAccount(rules, undefined)).toBe(false);
    expect(isExcludedAccount(rules, "not-an-address")).toBe(false);
  });
});

describe("excludedAccountFilter", () => {
  it("is a predicate, and excludes nobody when nothing is configured", () => {
    expect(excludedAccountFilter(parseExcludedAccounts("ours.example"))("a@ours.example")).toBe(true);
    expect(excludedAccountFilter([])("a@ours.example")).toBe(false);
  });
});
