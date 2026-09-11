import { describe, expect, it } from "vitest";
import { teamKeyRefusal, teamKeyVerdict } from "./team-trust";

/*
 * The service decides what a browser is told about the team's key, and a
 * browser that believes "there is none" will make one and seal it to the
 * members the service lists. These are the checks on that.
 */
describe("whether to believe the team key on offer", () => {
  it("makes one when there is none and none was ever used here", () => {
    expect(teamKeyVerdict(null, null)).toBe("create");
  });

  it("uses the key it already knows", () => {
    expect(teamKeyVerdict("pk", "pk")).toBe("use");
  });

  it("uses a key seen for the first time in this browser", () => {
    expect(teamKeyVerdict(null, "pk")).toBe("use");
  });

  /* The re-keying attack: "your team has no key" said to a browser that knows better. */
  it("refuses to make a second key for a team that has one", () => {
    expect(teamKeyVerdict("pk", null)).toBe("refuse-missing");
  });

  it("refuses a key that is not the one it used before", () => {
    expect(teamKeyVerdict("pk", "other")).toBe("refuse-changed");
  });

  it("says why, in words a person can act on", () => {
    expect(teamKeyRefusal("refuse-missing")).toMatch(/has none/);
    expect(teamKeyRefusal("refuse-changed")).toMatch(/not the one/);
  });
});
