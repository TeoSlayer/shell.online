import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSummaryTicket, readSessionSummary, summaryTicketSigner, SUMMARY_TICKET_LIFETIME_MS } from "./session-summary";

const publicKey = "BDxrse1_E7EAHDreFfDYFkHs7kcn3d2n_BqKorrlu6H-9FarvjSDUCUSY3EOYKRBJusTV2E2GwRZLdplZc3UbQY";
const body = { generation: "a".repeat(32), observedAt: 1000, senderPublicKey: publicKey, sealed: `ss1.${Buffer.alloc(40).toString("base64url")}` };
// RFC 8032 test vector 1: seed 9d61b19d…, public key d75a9801….
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64url");
const PUBLIC = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex").toString("base64url");

describe("sealed session summary validation", () => {
  it("accepts the 8192-character boundary and nothing larger", async () => {
    const at = { ...body, sealed: `ss1.${"A".repeat(8188)}` };
    // 8188 base64url characters is canonical only when it decodes and re-encodes to itself.
    const canonical = `ss1.${Buffer.alloc(6141).toString("base64url")}`;
    expect(canonical.length).toBe(8192);
    expect(await readSessionSummary({ ...body, sealed: canonical })).toEqual({ ...body, sealed: canonical });
    expect(await readSessionSummary({ ...body, sealed: `ss1.${Buffer.alloc(6142).toString("base64url")}` })).toBeNull();
    expect(at.sealed.length).toBe(8192);
  });
  it.each([
    { generation: "../session" }, { generation: "" }, { generation: "A".repeat(32) },
    { observedAt: 0 }, { observedAt: -1 }, { observedAt: 1.5 }, { observedAt: Number.MAX_SAFE_INTEGER },
    { senderPublicKey: "A".repeat(87) },
    { sealed: `sc1.${Buffer.alloc(40).toString("base64url")}` },
    { sealed: `ss1.${Buffer.alloc(28).toString("base64url")}` },
    { sealed: "ss1.A===" }, { sealed: "ss1.A" }, { sealed: "plaintext" },
    { title: "never store plaintext" },
  ])("rejects invalid input %#", async (patch) => {
    expect(await readSessionSummary({ ...body, ...patch })).toBeNull();
  });
});

describe("summary tickets", () => {
  it("derives the enclave's public key from the seed", async () => {
    expect((await summaryTicketSigner(SEED))!.publicKey).toBe(PUBLIC);
  });

  it.each([undefined, null, "", "short", `${SEED}A`, SEED.slice(0, 42) + "+", Buffer.alloc(31).toString("base64url")])(
    "refuses a malformed key %#", async (seed) => {
      expect(await summaryTicketSigner(seed as string)).toBeNull();
    });

  it("signs the exact protocol payload over the prefixed encoding", async () => {
    const signer = (await summaryTicketSigner(SEED))!;
    const ticket = await issueSummaryTicket(signer, { uid: "uid-1", sessionId: "s1", generation: "g".repeat(32) }, 1_000);
    const match = ticket.match(/^st1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    expect(match).not.toBeNull();
    const payload = JSON.parse(Buffer.from(match![1], "base64url").toString("utf8"));
    expect(Object.keys(payload)).toEqual(["v", "uid", "session_id", "generation", "exp", "jti"]);
    expect(payload).toMatchObject({ v: 1, uid: "uid-1", session_id: "s1", generation: "g".repeat(32), exp: 1_000 + SUMMARY_TICKET_LIFETIME_MS });
    expect(Buffer.from(payload.jti, "base64url")).toHaveLength(16);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: PUBLIC }, format: "jwk" });
    const signed = Buffer.from(`st1.${match![1]}`);
    const signature = Buffer.from(match![2], "base64url");
    expect(verify(null, signed, key, signature)).toBe(true);
    expect(verify(null, Buffer.from(match![1]), key, signature)).toBe(false);
    const other = await issueSummaryTicket(signer, { uid: "uid-1", sessionId: "s1", generation: "g".repeat(32) }, 1_000);
    expect(JSON.parse(Buffer.from(other.split(".")[1], "base64url").toString()).jti).not.toBe(payload.jti);
  });
});
