import { describe, expect, it } from "vitest";
import { suggestedTeamName } from "./team-name";

describe("suggestedTeamName", () => {
  it("uses a company domain, which is the useful signal", () => {
    expect(suggestedTeamName("ana@vulturelabs.io")).toBe("Vulturelabs");
    expect(suggestedTeamName("ana@acme.co.uk")).toBe("Acme");
  });

  /* A personal address says nothing about who someone works with. */
  it("falls back to the person for a personal address", () => {
    expect(suggestedTeamName("ana@gmail.com", "Ana Ruiz")).toBe("Ana's team");
    expect(suggestedTeamName("ana@icloud.com")).toBe("Ana's team");
  });

  it("offers nothing before there is an address to go on", () => {
    expect(suggestedTeamName("")).toBe("");
    expect(suggestedTeamName("   ")).toBe("");
  });

  it("ignores a domain with no dot, which is a half-typed address", () => {
    expect(suggestedTeamName("ana@vult", "Ana Ruiz")).toBe("Ana's team");
  });

});
