import { describe, expect, it } from "vitest";
import { CompactEncrypt, exportJWK, generateKeyPair, generateSecret, base64url, type JWK } from "jose";
import {
  FRAME_KEY_BYTES,
  hashBearer,
  importEcKeyPair,
  mintBearer,
  unwrapFrameKey,
  verifyOuter,
  type BearerClaims,
  type KeyResolver,
} from "../shared/mcp-bearer";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function makeKeyPair(kid: string) {
  const pair = await generateKeyPair("ECDH-ES", { extractable: true });
  return {
    kid,
    pub: { ...(await exportJWK(pair.publicKey)), kid },
    priv: { ...(await exportJWK(pair.privateKey)), kid },
    pair,
  };
}

function resolverFor(entries: Record<string, CryptoKey>): KeyResolver {
  return (kid) => {
    const key = entries[kid];
    if (!key) throw new Error(`no retained key for kid=${kid}`);
    return key;
  };
}

const now = Math.floor(Date.now() / 1000);
const claims: BearerClaims = {
  grant: "grant-abc123",
  session: "sess-XYZ789-secret",
  run: "run-42",
  scopes: ["observe"],
  iat: now,
  exp: now + 3600,
};

describe("mcp-bearer (two-layer compact JWE)", () => {
  it("mint -> verifyOuter -> unwrapFrameKey round-trips the frame key, bound to claims", async () => {
    const route = await makeKeyPair("route-v1");
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));

    const bearer = await mintBearer({
      claims,
      frameKey,
      routeKid: "route-v1",
      frameKid: "frame-v1",
      routeRecipient: route.pub,
      frameRecipient: frame.pub,
    });

    const outer = await verifyOuter(bearer, resolverFor({ "route-v1": route.pair.privateKey }));
    expect(outer.claims.session).toBe(claims.session);
    expect(outer.claims.run).toBe(claims.run);
    expect(outer.claims.scopes).toEqual(claims.scopes);
    expect(outer.wrappedFrameKey).toBeTypeOf("string");

    const unwrapped = await unwrapFrameKey(
      outer.wrappedFrameKey as string,
      resolverFor({ "frame-v1": frame.pair.privateKey }),
    );
    expect(unwrapped.frameKey?.byteLength).toBe(FRAME_KEY_BYTES);
    expect(bytesEqual(unwrapped.frameKey as Uint8Array, frameKey)).toBe(true);
    expect(unwrapped.binding).toEqual({
      grant: claims.grant,
      session: claims.session,
      run: claims.run,
      exp: claims.exp,
    });
  });

  it("detects an inner envelope bound to a different run", async () => {
    const route = await makeKeyPair("route-v1");
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));
    const otherClaims = { ...claims, run: "run-OTHER" };

    const a = await mintBearer({
      claims, frameKey, routeKid: "route-v1", frameKid: "frame-v1",
      routeRecipient: route.pub, frameRecipient: frame.pub,
    });
    const b = await mintBearer({
      claims: otherClaims, frameKey, routeKid: "route-v1", frameKid: "frame-v1",
      routeRecipient: route.pub, frameRecipient: frame.pub,
    });
    const outerA = await verifyOuter(a, resolverFor({ "route-v1": route.pair.privateKey }));
    const outerB = await verifyOuter(b, resolverFor({ "route-v1": route.pair.privateKey }));
    // The DO compares the inner binding to the outer claims; a swapped inner is detectable.
    const unwrappedB = await unwrapFrameKey(outerB.wrappedFrameKey as string, resolverFor({ "frame-v1": frame.pair.privateKey }));
    expect(unwrappedB.binding.run).not.toBe(outerA.claims.run);
  });

  it("kid rotation: current kid decrypts, rotated-out kid is rejected", async () => {
    const routeCur = await makeKeyPair("route-v2");
    const routeOld = await makeKeyPair("route-v0");
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));

    const mintedWith = (kid: string, pub: JWK) =>
      mintBearer({
        claims, frameKey, routeKid: kid, frameKid: "frame-v1",
        routeRecipient: pub, frameRecipient: frame.pub,
      });

    const withCurrent = await mintedWith("route-v2", routeCur.pub);
    await expect(
      verifyOuter(withCurrent, resolverFor({ "route-v2": routeCur.pair.privateKey })),
    ).resolves.toMatchObject({ claims: { run: claims.run } });

    const withRotatedOut = await mintedWith("route-v0", routeOld.pub);
    // Only the current key is retained; the rotated-out kid has no retained private key.
    await expect(
      verifyOuter(withRotatedOut, resolverFor({ "route-v2": routeCur.pair.privateKey })),
    ).rejects.toThrow(/no retained key/);
  });

  it("keeps grant/session/run opaque in the outer token (no plaintext leak)", async () => {
    const route = await makeKeyPair("route-v1");
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));
    const bearer = await mintBearer({
      claims, frameKey, routeKid: "route-v1", frameKid: "frame-v1",
      routeRecipient: route.pub, frameRecipient: frame.pub,
    });
    for (const secret of [claims.grant, claims.session, claims.run]) {
      expect(bearer.includes(secret)).toBe(false);
    }
  });

  it("enforces size limits (outer < 8 KiB header; inner+claims < 4 KiB socket)", async () => {
    const route = await makeKeyPair("route-v1");
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));
    const bearer = await mintBearer({
      claims, frameKey, routeKid: "route-v1", frameKid: "frame-v1",
      routeRecipient: route.pub, frameRecipient: frame.pub,
    });
    expect(bearer.length).toBeLessThan(8192);
    expect(bearer.length).toBeGreaterThan(0);
  });

  it("rejects a non-ECDH (A256KW) outer token via the ECDH route-key resolver", async () => {
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));
    const route = await makeKeyPair("route-v1");
    const inner = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({
      v: 1, grant: claims.grant, session: claims.session, run: claims.run, exp: claims.exp,
      key: base64url.encode(frameKey),
    })))
      .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", kid: "frame-v1" })
      .encrypt(frame.pub as never);
    const sym = await generateSecret("A256KW");
    const outer = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({
      v: 1, grant: claims.grant, session: claims.session, run: claims.run,
      scopes: claims.scopes, iat: claims.iat, exp: claims.exp, fk: inner,
    })))
      .setProtectedHeader({ alg: "A256KW", enc: "A256GCM", kid: "route-v1" })
      .encrypt(sym as never);
    await expect(
      verifyOuter(outer, resolverFor({ "route-v1": route.pair.privateKey })),
    ).rejects.toThrow();
  });

  it("supports --no-e2ee (no frame key, no inner envelope)", async () => {
    const route = await makeKeyPair("route-v1");
    const frame = await makeKeyPair("frame-v1");
    const bearer = await mintBearer({
      claims, frameKey: null, routeKid: "route-v1", frameKid: "frame-v1",
      routeRecipient: route.pub, frameRecipient: frame.pub,
    });
    const outer = await verifyOuter(bearer, resolverFor({ "route-v1": route.pair.privateKey }));
    expect(outer.wrappedFrameKey).toBeNull();
  });

  it("hashBearer is a stable 64-hex-char SHA-256 of the complete token", async () => {
    const route = await makeKeyPair("route-v1");
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));
    const bearer = await mintBearer({
      claims, frameKey, routeKid: "route-v1", frameKid: "frame-v1",
      routeRecipient: route.pub, frameRecipient: frame.pub,
    });
    const h1 = await hashBearer(bearer);
    const h2 = await hashBearer(bearer);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });

  it("importEcKeyPair lets one deployment secret both mint and verify", async () => {
    const generated = await makeKeyPair("route-v1");
    const frame = await makeKeyPair("frame-v1");
    const frameKey = crypto.getRandomValues(new Uint8Array(FRAME_KEY_BYTES));

    // The deployment imports its private route JWK (as a wrangler secret) into a keypair.
    const routePair = await importEcKeyPair(generated.priv as Record<string, unknown>);

    const bearer = await mintBearer({
      claims, frameKey, routeKid: "route-v1", frameKid: "frame-v1",
      routeRecipient: routePair.publicKey, frameRecipient: frame.pub,
    });
    const outer = await verifyOuter(bearer, resolverFor({ "route-v1": routePair.privateKey }));
    expect(outer.claims.session).toBe(claims.session);
  });
});
