import { describe, expect, it } from "vitest";
import { checkTeamAuthorization } from "../worker/team-authorization";

/*
 * The live use-time check a team grant is re-authorized against. The invariant
 * under test is fail-closed: anything that is not an explicit, authenticated
 * yes is a no. The fetch is injected so no test needs a network.
 */

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const base = { origin: "https://accounts.example", token: "t".repeat(32), sessionId: "s1", requesterUid: "uid-2", grantId: "grant-1" };

describe("team authorization (live, fail-closed)", () => {
  it("refuses unsafe origins before sending the shared secret", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return answer(200, { authorized: true }); }) as typeof fetch;
    for (const origin of ["http://accounts.example", "https://user:pass@accounts.example", "https://accounts.example/path",
      "https://accounts.example/?query=1", "https://accounts.example/#fragment", "http://127.0.0.1:8080"]) {
      expect((await checkTeamAuthorization({ ...base, origin }, fetchImpl)).ok).toBe(false);
    }
    expect(calls).toBe(0);
    expect((await checkTeamAuthorization({ ...base, origin: "http://127.0.0.1:8080", allowLocalHttp: true }, fetchImpl)).ok).toBe(true);
    expect((await checkTeamAuthorization({ ...base, origin: "http://accounts.example", allowLocalHttp: true }, fetchImpl)).ok).toBe(false);
  });

  it("disables redirects and bounds the authorization body", async () => {
    const fetchImpl = (async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      return answer(200, { authorized: true, padding: "x".repeat(1024) });
    }) as typeof fetch;
    expect((await checkTeamAuthorization(base, fetchImpl)).ok).toBe(false);
    const redirect = (async () => new Response(null, { status: 302, headers: { Location: "https://other.example" } })) as typeof fetch;
    expect((await checkTeamAuthorization(base, redirect)).ok).toBe(false);
  });
  it("allows only an explicit authenticated yes", async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, _init?: RequestInit) => answer(200, { authorized: true })) as typeof fetch;
    await expect(checkTeamAuthorization(base, fetchImpl)).resolves.toEqual({ ok: true });
  });

  it("denies an explicit no", async () => {
    const fetchImpl = (async () => answer(200, { authorized: false })) as typeof fetch;
    await expect(checkTeamAuthorization(base, fetchImpl)).resolves.toEqual({ ok: false, status: 403, error: "team access is not authorized" });
  });

  it("denies when the link is absent (no origin, token, session, or requester)", async () => {
    for (const patch of [{ origin: undefined }, { token: undefined }, { sessionId: undefined }, { requesterUid: undefined }, {}]) {
      const fetchImpl = (async () => {
        throw new Error("the network must not be consulted when the link is absent");
      }) as typeof fetch;
      await expect(checkTeamAuthorization({ ...base, ...patch }, fetchImpl)).resolves.toEqual({ ok: false, status: 503, error: "team authorization is unavailable" });
    }
  });

  it("denies when the service is unreachable or times out", async () => {
    const down = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    await expect(checkTeamAuthorization(base, down)).resolves.toEqual({ ok: false, status: 503, error: "team authorization is unavailable" });
  });

  it("denies a non-200 answer and a malformed body", async () => {
    const httpError = (async () => answer(500, {})) as typeof fetch;
    await expect(checkTeamAuthorization(base, httpError)).resolves.toEqual({ ok: false, status: 503, error: "team authorization is unavailable" });
    const notJson = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    await expect(checkTeamAuthorization(base, notJson)).resolves.toEqual({ ok: false, status: 503, error: "team authorization is unavailable" });
    const wrongShape = (async () => answer(200, { authorized: "yes" })) as typeof fetch;
    await expect(checkTeamAuthorization(base, wrongShape)).resolves.toEqual({ ok: false, status: 403, error: "team access is not authorized" });
  });

  it("presents the token and asks about the right session and requester", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return answer(200, { authorized: true });
    }) as typeof fetch;
    await checkTeamAuthorization({ ...base, origin: "https://accounts.example/" }, fetchImpl);
    expect(seenUrl).toBe("https://accounts.example/api/internal/mcp/team-authorized?session=s1&requester=uid-2&grant=grant-1");
    expect(seenAuth).toBe(`Bearer ${"t".repeat(32)}`);
  });
});
