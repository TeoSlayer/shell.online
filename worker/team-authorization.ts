/*
 * The live use-time check a team MCP grant is re-authorized against.
 *
 * A team grant is minted for a teammate, not the owner, and the accounts
 * service -- not the DO -- is the authority on whether the teammate is still
 * a member and the session still consents. The DO's own copy may be arbitrarily
 * stale (the issuing host may be offline), so the check is live: no cache, a
 * removal is effective on the very next request. And it is fail-closed: an
 * unlinked or unreachable accounts service, or any answer that is not an
 * explicit yes, denies. The owner's own grants never take this path.
 *
 * Mirrors account-stats.ts: the fetch is injectable so the fail-closed
 * behaviour is testable without a network.
 */

export type TeamAuthorizationResult = { ok: true } | { ok: false; status: number; error: string };

const UNAVAILABLE: TeamAuthorizationResult = { ok: false, status: 503, error: "team authorization is unavailable" };
const NOT_AUTHORIZED: TeamAuthorizationResult = { ok: false, status: 403, error: "team access is not authorized" };

export async function checkTeamAuthorization(
  opts: {
    origin?: string;
    token?: string;
    sessionId?: string;
    requesterUid?: string;
    grantId?: string;
    allowLocalHttp?: boolean;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<TeamAuthorizationResult> {
  const origin = opts.origin?.trim();
  const secret = opts.token?.trim();
  const sessionId = opts.sessionId;
  const requesterUid = opts.requesterUid;
  const grantId = opts.grantId;
  if (!origin || !secret || !sessionId || !requesterUid || !grantId) return UNAVAILABLE;
  try {
    const url = new URL(origin);
    const localHttp = opts.allowLocalHttp === true && url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if ((!localHttp && url.protocol !== "https:") || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return UNAVAILABLE;
    url.pathname = "/api/internal/mcp/team-authorized";
    url.search = new URLSearchParams({ session: sessionId, requester: requesterUid, grant: grantId }).toString();
    const response = await fetchImplementation(url, {
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      // workerd supports manual/follow; reject every redirect by status below.
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok || !response.body) return UNAVAILABLE;
    const reader = response.body.getReader();
    let contents = "";
    let length = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 1024) return UNAVAILABLE;
        contents += decoder.decode(chunk.value, { stream: true });
      }
      contents += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = JSON.parse(contents) as { authorized?: unknown };
    if (body.authorized !== true) return NOT_AUTHORIZED;
    return { ok: true };
  } catch {
    return UNAVAILABLE;
  }
}
