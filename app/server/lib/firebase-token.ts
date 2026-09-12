import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const CERT_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface Identity {
  uid: string;
  email: string;
  name: string;
  /** True only when the identity provider has verified ownership of email. */
  emailVerified: boolean;
  /**
   * When this person last actually signed in, in milliseconds. A refreshed
   * token keeps the original time, so this is how an operation that deserves
   * a fresh sign-in can ask for one.
   */
  authTime?: number;
}

export type VerifyResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: string };

type KeyLookup = Parameters<typeof jwtVerify>[1];

/**
 * Firebase ID tokens are RS256 JWTs signed by Google. Verifying them needs no
 * service account key, only Google's public JWKs plus the issuer and audience
 * checks that bind a token to this specific project.
 */
export function createVerifier(projectId: string, keys?: KeyLookup) {
  const jwks = keys ?? createRemoteJWKSet(new URL(CERT_URL));

  return async function verifyIdToken(token: string): Promise<VerifyResult> {
    if (!token) return { ok: false, reason: "missing token" };
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
        algorithms: ["RS256"],
      });
      payload = result.payload;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "invalid token" };
    }

    /*
     * sub carries the Firebase uid. jwtVerify already enforced exp, iss and
     * aud, but sub is only guaranteed non-empty by Firebase, so check it here
     * rather than trusting an empty subject through to the store.
     */
    const uid = typeof payload.sub === "string" ? payload.sub : "";
    if (!uid) return { ok: false, reason: "token has no subject" };

    return {
      ok: true,
      identity: {
        uid,
        email: typeof payload.email === "string" ? payload.email : "",
        name: typeof payload.name === "string" ? payload.name : "",
        emailVerified: payload.email_verified === true,
        authTime: typeof payload.auth_time === "number" ? payload.auth_time * 1000 : undefined,
      },
    };
  };
}

/** Test seam: verify against a locally generated key set instead of Google's. */
export function localKeySet(jwks: Parameters<typeof createLocalJWKSet>[0]) {
  return createLocalJWKSet(jwks);
}
