import { describe, expect, it } from "vitest";
import { createVault } from "./vault-crypto";
import {
  createTeamKey,
  isAuditEnvelope,
  openAuditText,
  openTeamKeyShare,
  parseAuditEnvelope,
  sealAuditText,
  sealTeamKeyShare,
  teamPrivateKey,
  type AuditContext,
} from "./team-crypto";

/*
 * These tests are the audit log's claim: that what a teammate typed can be
 * read by the team and by nothing the service holds, including a team key
 * the service made up itself. Each names the property it keeps.
 */

async function member(uid: string) {
  const vault = await createVault(uid);
  return { uid, publicKey: vault.bundle.publicKey, privateKey: vault.opened.privateKey };
}

const team = { orgId: "org_1", version: 1 };

describe("sharing the team key", () => {
  it("reaches a teammate intact, and yields the key the team published", async () => {
    const ana = await member("ana");
    const bo = await member("bo");
    const made = await createTeamKey();
    const sealed = await sealTeamKeyShare(ana.privateKey, bo.publicKey, { ...team, senderUid: "ana", recipientUid: "bo" }, made.pkcs8);

    const opened = await openTeamKeyShare(bo.privateKey, ana.publicKey, { ...team, senderUid: "ana", recipientUid: "bo" }, sealed);
    expect(opened).toEqual(made.pkcs8);
    const key = await teamPrivateKey(opened!, made.publicKey);
    expect(key).not.toBeNull();
    expect(key!.extractable).toBe(false);
  });

  it("works for the member who made it, sealed to themselves", async () => {
    const ana = await member("ana");
    const made = await createTeamKey();
    const context = { ...team, senderUid: "ana", recipientUid: "ana" };
    const sealed = await sealTeamKeyShare(ana.privateKey, ana.publicKey, context, made.pkcs8);
    expect(await openTeamKeyShare(ana.privateKey, ana.publicKey, context, sealed)).toEqual(made.pkcs8);
  });

  /*
   * The property the design exists for. Anyone can seal to a public key, so a
   * service could hand a member a team key of its own making. It cannot make
   * one that opens as coming from a teammate, because that takes the
   * teammate's vault.
   */
  it("refuses a share that did not come from the teammate it names", async () => {
    const ana = await member("ana");
    const bo = await member("bo");
    const impostor = await member("service");
    const forged = await createTeamKey();
    const sealed = await sealTeamKeyShare(impostor.privateKey, bo.publicKey, { ...team, senderUid: "ana", recipientUid: "bo" }, forged.pkcs8);
    expect(await openTeamKeyShare(bo.privateKey, ana.publicKey, { ...team, senderUid: "ana", recipientUid: "bo" }, sealed)).toBeNull();
  });

  it("refuses a share replayed to a different person, team or version", async () => {
    const ana = await member("ana");
    const bo = await member("bo");
    const made = await createTeamKey();
    const context = { ...team, senderUid: "ana", recipientUid: "bo" };
    const sealed = await sealTeamKeyShare(ana.privateKey, bo.publicKey, context, made.pkcs8);
    expect(await openTeamKeyShare(bo.privateKey, ana.publicKey, { ...context, recipientUid: "cy" }, sealed)).toBeNull();
    expect(await openTeamKeyShare(bo.privateKey, ana.publicKey, { ...context, orgId: "org_2" }, sealed)).toBeNull();
    expect(await openTeamKeyShare(bo.privateKey, ana.publicKey, { ...context, version: 2 }, sealed)).toBeNull();
  });

  it("will not accept a private key that is not the team's published one", async () => {
    const made = await createTeamKey();
    const other = await createTeamKey();
    expect(await teamPrivateKey(made.pkcs8, other.publicKey)).toBeNull();
  });

  it("does not open with the wrong vault", async () => {
    const ana = await member("ana");
    const bo = await member("bo");
    const cy = await member("cy");
    const made = await createTeamKey();
    const context = { ...team, senderUid: "ana", recipientUid: "bo" };
    const sealed = await sealTeamKeyShare(ana.privateKey, bo.publicKey, context, made.pkcs8);
    expect(await openTeamKeyShare(cy.privateKey, ana.publicKey, context, sealed)).toBeNull();
  });
});

describe("an audit entry", () => {
  const where: AuditContext = { orgId: "org_1", sessionId: "sess_1", kind: "input", at: 1788000000123, actorUid: "ana" };

  async function teamKey() {
    const made = await createTeamKey();
    return { publicKey: made.publicKey, privateKey: (await teamPrivateKey(made.pkcs8, made.publicKey))! };
  }

  it("opens for the team and does not carry the text in the clear", async () => {
    const key = await teamKey();
    const sealed = await sealAuditText(key.publicKey, 1, where, "claude -p 'rotate the prod keys'");
    expect(isAuditEnvelope(sealed)).toBe(true);
    expect(sealed).not.toContain("rotate");
    expect(await openAuditText(key.privateKey, where, sealed)).toBe("claude -p 'rotate the prod keys'");
  });

  it("does not open for a key that is not the team's", async () => {
    const key = await teamKey();
    const other = await teamKey();
    const sealed = await sealAuditText(key.publicKey, 1, where, "ls");
    expect(await openAuditText(other.privateKey, where, sealed)).toBeNull();
  });

  /* The service keeps the metadata; it must not be able to rearrange it. */
  it("refuses to be moved to another session, person, kind, time or team", async () => {
    const key = await teamKey();
    const sealed = await sealAuditText(key.publicKey, 1, where, "ls");
    for (const moved of [
      { ...where, sessionId: "sess_2" },
      { ...where, actorUid: "bo" },
      { ...where, kind: "interrupt" },
      { ...where, at: where.at + 1 },
      { ...where, orgId: "org_2" },
    ]) {
      expect(await openAuditText(key.privateKey, moved, sealed)).toBeNull();
    }
  });

  it("refuses an entry whose key version was changed", async () => {
    const key = await teamKey();
    const sealed = await sealAuditText(key.publicKey, 1, where, "ls");
    expect(await openAuditText(key.privateKey, where, sealed.replace(/^a1\.1\./, "a1.2."))).toBeNull();
  });

  it("refuses ciphertext that has been altered", async () => {
    const key = await teamKey();
    const sealed = await sealAuditText(key.publicKey, 1, where, "ls -la");
    const body = sealed.slice(sealed.lastIndexOf(".") + 1);
    const flipped = (body[20] === "A" ? "B" : "A");
    const altered = sealed.slice(0, sealed.length - body.length) + body.slice(0, 20) + flipped + body.slice(21);
    expect(await openAuditText(key.privateKey, where, altered)).toBeNull();
  });

  it("reads plain text, and junk, as not an envelope", () => {
    expect(isAuditEnvelope("npm test")).toBe(false);
    expect(isAuditEnvelope("a1.1.short.body")).toBe(false);
    expect(parseAuditEnvelope("a1.0." + "A".repeat(87) + ".AAAA")).toBeNull();
  });

  it("never seals the same text to the same bytes twice", async () => {
    const key = await teamKey();
    const first = await sealAuditText(key.publicKey, 1, where, "same");
    const second = await sealAuditText(key.publicKey, 1, where, "same");
    expect(first).not.toBe(second);
  });
});
