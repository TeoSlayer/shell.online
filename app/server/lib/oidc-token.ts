import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Identity, VerifyResult } from "./firebase-token";

export type { Identity, VerifyResult };

type KeyLookup = Parameters<typeof jwtVerify>[1];
/* The callable half of KeyLookup: what createRemoteJWKSet hands back. */
type KeyResolver = ReturnType<typeof createRemoteJWKSet>;

export interface IssuerSettings {
  /** The `iss` every accepted token must carry, exactly as the provider writes it. */
  issuer: string;
  /** The `aud` every accepted token must carry. For OIDC, the client id. */
  audience: string;
  /**
   * Where the signing keys are published. Absent means ask the issuer: its
   * OpenID configuration names them, which is the point of having one.
   */
  jwksUri?: string;
}

const DISCOVERY_PATH = "/.well-known/openid-configuration";

/**
 * The signing keys of an OpenID provider, found the standard way.
 *
 * Discovery is deferred to the first token rather than done at boot. The app
 * and the provider come up together under one compose file, and a service that
 * refused to start because its neighbour was still starting would be a worse
 * failure than a first request that waits. The result is cached, including the
 * key set's own rotation handling, so this is one fetch per process.
 *
 * A failed discovery is not cached: the next token tries again, which is what
 * makes a provider that was briefly down recoverable without a restart.
 */
function discoverKeys(settings: IssuerSettings): KeyLookup {
  if (settings.jwksUri) return createRemoteJWKSet(new URL(settings.jwksUri));

  let keys: KeyResolver | undefined;
  let pending: Promise<KeyResolver> | undefined;

  const load = async (): Promise<KeyResolver> => {
    const url = settings.issuer.replace(/\/$/, "") + DISCOVERY_PATH;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    const document = (await response.json()) as { jwks_uri?: unknown };
    if (typeof document.jwks_uri !== "string" || !document.jwks_uri) {
      throw new Error(`${url} has no jwks_uri`);
    }
    return createRemoteJWKSet(new URL(document.jwks_uri));
  };

  return async (header, input) => {
    if (!keys) {
      pending ??= load().then(
        (found) => {
          keys = found;
          pending = undefined;
          return found;
        },
        (error) => {
          pending = undefined;
          throw error;
        },
      );
      await pending;
    }
    return keys!(header, input);
  };
}

/**
 * Verifies the ID tokens of an OpenID Connect provider.
 *
 * This is the same shape as the Firebase verifier beside it, and deliberately
 * so: an ID token is an RS256 JWT signed by a key the provider publishes, and
 * Firebase is one such provider with its issuer and audience spelled a
 * particular way. Everything specific to a provider lives in the settings.
 */
export function createVerifier(settings: IssuerSettings, keys?: KeyLookup) {
  const jwks = keys ?? discoverKeys(settings);

  return async function verifyIdToken(token: string): Promise<VerifyResult> {
    if (!token) return { ok: false, reason: "missing token" };
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: settings.issuer,
        audience: settings.audience,
        algorithms: ["RS256"],
      });
      payload = result.payload;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "invalid token" };
    }

    /*
     * sub is the account, and it is the one claim the store keys people by, so
     * an empty one is rejected here rather than allowed to become a row.
     */
    const uid = typeof payload.sub === "string" ? payload.sub : "";
    if (!uid) return { ok: false, reason: "token has no subject" };

    /*
     * name is optional in OIDC and Keycloak only sends it when the account has
     * both given and family names. Falling back through the other standard
     * claims keeps the app from showing an empty display name for someone who
     * filled in a username and nothing else.
     */
    const name =
      firstString(payload.name, payload.preferred_username, payload.given_name) || "";

    return {
      ok: true,
      identity: {
        uid,
        email: typeof payload.email === "string" ? payload.email : "",
        name,
        emailVerified: payload.email_verified === true,
        /*
         * Seconds in the token, milliseconds everywhere in this service. A
         * renewed token keeps the original sign-in's time, which is what lets
         * account deletion insist on a recent one.
         */
        authTime: typeof payload.auth_time === "number" ? payload.auth_time * 1000 : undefined,
      },
    };
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
