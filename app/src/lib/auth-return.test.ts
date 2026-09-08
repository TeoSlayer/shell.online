import { describe, expect, it } from "vitest";

/**
 * The CLI round trip, as a rule rather than as a rendered page.
 *
 * `shell login` opens /cli/authorize with the request it is waiting on. If the
 * browser is not signed in, whichever auth page it lands on has to carry that
 * URL through and return to it — losing it leaves a terminal hanging on a
 * request nobody can reach any more.
 */
function destinationFor(state: { from?: string } | null): string {
  return state?.from ?? "/sessions";
}

const AUTHORIZE = "/cli/authorize?code_challenge=abc&code_challenge_method=S256";

describe("where an auth page sends you afterwards", () => {
  it("returns to the CLI request when there is one", () => {
    expect(destinationFor({ from: AUTHORIZE })).toBe(AUTHORIZE);
  });

  it("falls back to the sessions page for an ordinary sign-up", () => {
    expect(destinationFor(null)).toBe("/sessions");
    expect(destinationFor({})).toBe("/sessions");
  });

  /*
   * The query string is the request. A path-only return would drop the
   * challenge and the CLI would never be approved.
   */
  it("keeps the query string, which is the request itself", () => {
    const returned = destinationFor({ from: AUTHORIZE });
    expect(returned).toContain("code_challenge=abc");
    expect(returned).toContain("code_challenge_method=S256");
  });
});
