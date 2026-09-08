import { describe, expect, it } from "vitest";
import { suggestedOrgName } from "./org-name";

describe("suggestedOrgName", () => {
  it("uses a company domain, which is the useful signal", () => {
    expect(suggestedOrgName("ana@vulturelabs.io")).toBe("Vulturelabs");
    expect(suggestedOrgName("ana@acme.co.uk")).toBe("Acme");
  });

  /* A personal address says nothing about who someone works with. */
  it("falls back to the person for a personal address", () => {
    expect(suggestedOrgName("ana@gmail.com", "Ana Ruiz")).toBe("Ana's organization");
    expect(suggestedOrgName("ana@icloud.com")).toBe("Ana's organization");
  });

  it("offers nothing before there is an address to go on", () => {
    expect(suggestedOrgName("")).toBe("");
    expect(suggestedOrgName("   ")).toBe("");
  });

  it("ignores a domain with no dot, which is a half-typed address", () => {
    expect(suggestedOrgName("ana@vult", "Ana Ruiz")).toBe("Ana's organization");
  });

});
