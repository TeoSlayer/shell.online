import { describe, expect, it } from "vitest";
import { CompactEncrypt, generateKeyPair } from "jose";
import {
  MCP_TEAM_REQUEST_TTL,
  mcpTeamRowSweepable,
  readTeamGrantReport,
  trimMcpTeamRows,
  type McpTeamRequest,
} from "./mcp-team";

const now = 1_800_000_000_000;
const grantId = "AbCdEf0123456789_-AbCQ";
const bearer = "eyJhbGciOiJFQ0RILUVTIn0.eyJlbmMiOiJBMjU2R0NNIn0.abc-def_ghi.j9LQyZ8-S_9r_E.abc123";

function request(patch: Partial<McpTeamRequest> = {}): McpTeamRequest {
  return {
    requestId: "mcp_AbCdEf0123456789_-AbCQ",
    orgId: "org_1",
    sessionId: "sess_1",
    requesterUid: "uid-2",
    recipientPublicKey: "test-recipient",
    status: "pending",
    createdAt: now - 1000,
    expiresAt: now + MCP_TEAM_REQUEST_TTL,
    sealedToRecipient: false,
    ...patch,
  };
}

describe("readTeamGrantReport", () => {
  it("accepts a bearer minted by the real ECDH-ES implementation", async () => {
    const { publicKey } = await generateKeyPair("ECDH-ES");
    const realBearer = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({
      v: 1, grant: grantId, session: "s1", run: "run-1", scopes: ["observe"], iat: now / 1000, exp: now / 1000 + 3600, fk: null,
    }))).setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", kid: "route" }).encrypt(publicKey);
    expect(realBearer.split(".")[1]).toBe("");
    expect(readTeamGrantReport({ grantId, expiresAt: now + 3600_000, bearer: realBearer }, now)?.bearer).toBe(realBearer);
  });
  it("accepts a well-formed report", () => {
    expect(readTeamGrantReport({ grantId, expiresAt: now + 3600_000, bearer }, now)).toEqual({
      grantId,
      expiresAt: now + 3600_000,
      bearer,
    });
  });

  it.each([
    { grantId: "short", expiresAt: now + 3600_000, bearer },
    { grantId: `${grantId}g`, expiresAt: now + 3600_000, bearer },
    { grantId, expiresAt: now, bearer },
    { grantId, expiresAt: now + 13 * 3600_000, bearer },
    { grantId, expiresAt: 1.5, bearer },
    { grantId, expiresAt: now + 3600_000, bearer: "not-a-jwe" },
    { grantId, expiresAt: now + 3600_000, bearer: `${bearer}.extra` },
    { grantId, expiresAt: now + 3600_000, bearer: "" },
    { grantId, expiresAt: now + 3600_000, bearer: "a.b.c.d.e".padEnd(8193, "f") },
    { grantId, expiresAt: now + 3600_000 },
    { grantId, bearer },
    { expiresAt: now + 3600_000, bearer },
  ])("rejects a malformed report %#", (body) => {
    expect(readTeamGrantReport(body, now)).toBeNull();
  });

  it("rejects unknown fields and non-objects", () => {
    expect(readTeamGrantReport({ grantId, expiresAt: now + 3600_000, bearer, label: "extra" }, now)).toBeNull();
    expect(readTeamGrantReport(null, now)).toBeNull();
    expect(readTeamGrantReport("nope", now)).toBeNull();
    expect(readTeamGrantReport([grantId], now)).toBeNull();
  });
});

describe("mcpTeamRowSweepable", () => {
  it("sweeps a pending row a grace after its deadline", () => {
    const row = request({ expiresAt: now - 61 * 60_000 });
    expect(mcpTeamRowSweepable(row, now)).toBe(true);
    expect(mcpTeamRowSweepable(request({ expiresAt: now - 59 * 60_000 }), now)).toBe(false);
  });

  it("sweeps a revoked row a grace after the revocation", () => {
    expect(mcpTeamRowSweepable(request({ status: "revoked", revokedAt: now - 61 * 60_000 }), now)).toBe(true);
    expect(mcpTeamRowSweepable(request({ status: "revoked", revokedAt: now - 59 * 60_000 }), now)).toBe(false);
  });

  it("sweeps an issued row a grace after its grant's expiry", () => {
    const issued = request({ status: "issued", grantId, grantExpiresAt: now - 61 * 60_000, bearer, issuedAt: now - 70 * 60_000 });
    expect(mcpTeamRowSweepable(issued, now)).toBe(true);
    expect(mcpTeamRowSweepable(request({ status: "issued", grantId, grantExpiresAt: now + 60_000, bearer }), now)).toBe(false);
  });
});

describe("trimMcpTeamRows", () => {
  it("drops sweepable rows and keeps the rest", () => {
    const done = request({ requestId: "mcp_dead", status: "revoked", revokedAt: now - 2 * 3600_000, grantId });
    const live = request({ requestId: "mcp_live" });
    expect(trimMcpTeamRows([done, live], now)).toEqual([live]);
  });

  it("revokes a session's rows over its per-status cap, oldest last", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      request({ requestId: `mcp_${i}`, createdAt: now - (6 - i) * 1000, expiresAt: now + MCP_TEAM_REQUEST_TTL }),
    );
    const trimmed = trimMcpTeamRows(rows, now);
    expect(trimmed).toHaveLength(6);
    const revoked = trimmed.filter((row) => row.status === "revoked");
    /* The two oldest pending rows are over the cap of four. */
    expect(revoked.map((row) => row.requestId).sort()).toEqual(["mcp_0", "mcp_1"]);
    expect(revoked.every((row) => row.revokedAt === now)).toBe(true);
  });

  it("revokes the oldest rows past the global cap", () => {
    /*
     * One row per session, so the per-session caps cannot fire: what trims
     * this burst is the global backstop, which revokes the oldest rows.
     */
    const global = trimMcpTeamRows(
      Array.from({ length: 520 }, (_, i) =>
        request({
          requestId: `mcp_${i}`,
          orgId: `org_${i}`,
          sessionId: `sess_${i}`,
          createdAt: now - (520 - i) * 1000,
          expiresAt: now + MCP_TEAM_REQUEST_TTL,
        }),
      ),
      now,
    );
    expect(global).toHaveLength(520);
    expect(global.filter((row) => row.status === "pending")).toHaveLength(512);
    expect(global.filter((row) => row.status === "revoked").map((row) => row.requestId).sort()).toEqual(
      ["mcp_0", "mcp_1", "mcp_2", "mcp_3", "mcp_4", "mcp_5", "mcp_6", "mcp_7"],
    );
  });
});
