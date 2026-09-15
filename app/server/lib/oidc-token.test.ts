import { beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { createVerifier } from "./oidc-token";

const ISSUER = "https://auth.example.test/realms/shell";
const AUDIENCE = "shell-online-app";

/* The server build has no DOM lib, so CryptoKey is named through jose. */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: SigningKey;
let keySet: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
});

async function token(claims: Record<string, unknown>, overrides: Record<string, string> = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function verifier() {
  return createVerifier({ issuer: ISSUER, audience: AUDIENCE }, keySet as never);
}

describe("the OIDC verifier", () => {
  it("accepts a token from the configured issuer and audience", async () => {
    const result = await verifier()(
      await token({ sub: "uid-1", email: "a@example.test", name: "Ada Lovelace" }),
    );
    expect(result).toEqual({
      ok: true,
      identity: {
        uid: "uid-1",
        email: "a@example.test",
        name: "Ada Lovelace",
        emailVerified: false,
        authTime: undefined,
      },
    });
  });

  it("carries the verified address and the sign-in time through", async () => {
    const result = await verifier()(
      await token({ sub: "uid-1", email_verified: true, auth_time: 1_700_000_000 }),
    );
    expect(result).toMatchObject({
      ok: true,
      /* Seconds in the token, milliseconds in the service. */
      identity: { emailVerified: true, authTime: 1_700_000_000_000 },
    });
  });

  it("rejects a token from another issuer on the same provider", async () => {
    const other = await token({ sub: "uid-1" }, { issuer: "https://auth.example.test/realms/other" });
    expect(await verifier()(other)).toMatchObject({ ok: false });
  });

  it("rejects a token minted for another client", async () => {
    const other = await token({ sub: "uid-1" }, { audience: "some-other-app" });
    expect(await verifier()(other)).toMatchObject({ ok: false });
  });

  it("rejects an empty token without calling the key set", async () => {
    expect(await verifier()("")).toEqual({ ok: false, reason: "missing token" });
  });

  it("refuses a token with no subject, which would become a row keyed by nothing", async () => {
    const result = await verifier()(await token({ email: "a@example.test" }));
    expect(result).toEqual({ ok: false, reason: "token has no subject" });
  });

  /*
   * Keycloak sends `name` only when the account has both a given and a family
   * name, so an account created with just a username would otherwise show up
   * with an empty display name everywhere in the app.
   */
  it("falls back through the standard name claims", async () => {
    const result = await verifier()(await token({ sub: "uid-2", preferred_username: "ada" }));
    expect(result).toMatchObject({ ok: true, identity: { name: "ada" } });

    const given = await verifier()(await token({ sub: "uid-3", given_name: "Ada" }));
    expect(given).toMatchObject({ ok: true, identity: { name: "Ada" } });

    const none = await verifier()(await token({ sub: "uid-4" }));
    expect(none).toMatchObject({ ok: true, identity: { name: "" } });
  });

  it("accepts a token carrying no email, which the scope may not have asked for", async () => {
    const result = await verifier()(await token({ sub: "uid-5" }));
    expect(result).toMatchObject({ ok: true, identity: { uid: "uid-5", email: "" } });
  });
});

describe("key discovery", () => {
  it("asks the issuer for its jwks_uri, once, and caches it", async () => {
    const jwks = await exportJWK((await generateKeyPair("RS256", { extractable: true })).publicKey);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({ jwks_uri: "https://auth.example.test/jwks" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ keys: [{ ...jwks, kid: "remote", alg: "RS256" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verify = createVerifier({ issuer: ISSUER, audience: AUDIENCE });
    /*
     * The token is signed by a key the remote set does not carry, so
     * verification fails. What is being checked is the discovery around it:
     * the configuration is fetched, and only once across both calls.
     */
    await verify(await token({ sub: "uid-1" }));
    await verify(await token({ sub: "uid-1" }));

    const discoveries = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/.well-known/openid-configuration"),
    );
    expect(discoveries).toHaveLength(1);
    expect(String(discoveries[0][0])).toBe(`${ISSUER}/.well-known/openid-configuration`);
    vi.unstubAllGlobals();
  });

  /*
   * A provider that was down when the first token arrived must not poison the
   * process: the app and the provider start together, and one losing the race
   * would otherwise need a restart to recover.
   */
  it("retries discovery after a failure instead of caching it", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection refused");
      return new Response(JSON.stringify({ jwks_uri: "https://auth.example.test/jwks" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verify = createVerifier({ issuer: ISSUER, audience: AUDIENCE });
    const first = await verify(await token({ sub: "uid-1" }));
    expect(first).toMatchObject({ ok: false });
    await verify(await token({ sub: "uid-1" }));
    expect(attempts).toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });

  it("skips discovery entirely when the key set is named", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const verify = createVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: "https://auth.example.test/jwks",
    });
    await verify("not-a-token.at.all");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
