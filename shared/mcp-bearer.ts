// Runtime-neutral MCP bearer: a two-layer compact JWE (validated by spike 3, jose v6).
//
//   outer envelope  (route key,      ECDH-ES + A256GCM, kid) -> Worker decrypts to route
//   inner envelope  (frame-wrap key, ECDH-ES + A256GCM, kid) -> DO unwraps the 32-byte frame key
//
// The outer payload carries routing claims + the still-wrapped inner (fk). The inner payload
// binds the frame key to grant/session/run/exp (GCM-authenticated). The Worker sees only the
// outer; the DO unwraps the inner only after its own grant checks, so an invalid/revoked
// request never puts a raw frame key in the routing path. No browser password/salt is included.
import { CompactEncrypt, compactDecrypt, importJWK, base64url, type JWK } from "jose";

const te = new TextEncoder();
const td = new TextDecoder();

export const BEARER_VERSION = 1;
export const ROUTE_ALG = "ECDH-ES" as const;
export const ROUTE_ENC = "A256GCM" as const;
export const FRAME_ALG = "ECDH-ES" as const;
export const FRAME_ENC = "A256GCM" as const;
export const FRAME_KEY_BYTES = 32;
// The outer bearer must fit an HTTP Authorization header and the control-socket response.
export const MAX_BEARER_BYTES = 8192;
export const MAX_INNER_PLUS_CLAIMS_BYTES = 4096;

export interface BearerClaims {
  grant: string;
  session: string;
  run: string;
  scopes: string[];
  iat: number;
  exp: number;
}

export interface OuterPayload {
  v: number;
  grant: string;
  session: string;
  run: string;
  scopes: string[];
  iat: number;
  exp: number;
  fk: string | null;
}

export interface InnerPayload {
  v: number;
  grant: string;
  session: string;
  run: string;
  exp: number;
  key: string | null;
}

export type KeyResolver = (kid: string) => CryptoKey | Promise<CryptoKey>;

export interface MintBearerArgs {
  claims: BearerClaims;
  frameKey: Uint8Array | null;
  routeKid: string;
  frameKid: string;
  routeRecipient: CryptoKey | JWK;
  frameRecipient: CryptoKey | JWK;
}

export interface OuterVerification {
  claims: BearerClaims;
  wrappedFrameKey: string | null;
}

export interface FrameKeyUnwrap {
  frameKey: Uint8Array | null;
  binding: { grant: string; session: string; run: string; exp: number };
}

async function encryptJwe(
  payload: string,
  recipient: CryptoKey | JWK,
  alg: string,
  enc: string,
  kid: string,
): Promise<string> {
  return new CompactEncrypt(te.encode(payload))
    .setProtectedHeader({ alg, enc, kid })
    .encrypt(recipient as never);
}

function assertAlgEnc(alg: unknown, enc: unknown, wantAlg: string, wantEnc: string, layer: string): void {
  if (alg !== wantAlg || enc !== wantEnc) {
    throw new Error(`unexpected ${layer} alg/enc: ${String(alg)}/${String(enc)}`);
  }
}

export async function mintBearer(args: MintBearerArgs): Promise<string> {
  const { claims, frameKey, routeKid, frameKid, routeRecipient, frameRecipient } = args;
  if (frameKey !== null && frameKey.byteLength !== FRAME_KEY_BYTES) {
    throw new Error(`frame key must be ${FRAME_KEY_BYTES} bytes`);
  }

  const inner: InnerPayload = {
    v: BEARER_VERSION,
    grant: claims.grant,
    session: claims.session,
    run: claims.run,
    exp: claims.exp,
    key: frameKey === null ? null : base64url.encode(frameKey),
  };
  const fk =
    frameKey === null
      ? null
      : await encryptJwe(JSON.stringify(inner), frameRecipient, FRAME_ALG, FRAME_ENC, frameKid);

  const outer: OuterPayload = {
    v: BEARER_VERSION,
    grant: claims.grant,
    session: claims.session,
    run: claims.run,
    scopes: claims.scopes,
    iat: claims.iat,
    exp: claims.exp,
    fk,
  };
  const outerJson = JSON.stringify(outer);
  const bearer = await encryptJwe(outerJson, routeRecipient, ROUTE_ALG, ROUTE_ENC, routeKid);

  if (bearer.length > MAX_BEARER_BYTES) {
    throw new Error(`bearer too large: ${bearer.length} > ${MAX_BEARER_BYTES}`);
  }
  if (fk !== null && fk.length + outerJson.length > MAX_INNER_PLUS_CLAIMS_BYTES) {
    throw new Error("inner envelope + claims too large for the control-socket response");
  }
  return bearer;
}

export async function verifyOuter(
  bearer: string,
  routeKeyResolver: KeyResolver,
): Promise<OuterVerification> {
  const result = await compactDecrypt(bearer, (header) => routeKeyResolver(String(header.kid ?? "")));
  assertAlgEnc(result.protectedHeader.alg, result.protectedHeader.enc, ROUTE_ALG, ROUTE_ENC, "outer");
  const payload = JSON.parse(td.decode(result.plaintext)) as OuterPayload;
  if (payload.v !== BEARER_VERSION) throw new Error(`unsupported bearer version: ${String(payload.v)}`);
  return {
    claims: {
      grant: payload.grant,
      session: payload.session,
      run: payload.run,
      scopes: payload.scopes,
      iat: payload.iat,
      exp: payload.exp,
    },
    wrappedFrameKey: payload.fk,
  };
}

export async function unwrapFrameKey(
  wrappedInner: string,
  frameKeyResolver: KeyResolver,
): Promise<FrameKeyUnwrap> {
  const result = await compactDecrypt(wrappedInner, (header) => frameKeyResolver(String(header.kid ?? "")));
  assertAlgEnc(result.protectedHeader.alg, result.protectedHeader.enc, FRAME_ALG, FRAME_ENC, "inner");
  const payload = JSON.parse(td.decode(result.plaintext)) as InnerPayload;
  if (payload.v !== BEARER_VERSION) throw new Error(`unsupported inner version: ${String(payload.v)}`);
  const frameKey = payload.key === null ? null : base64url.decode(payload.key);
  if (frameKey !== null && frameKey.byteLength !== FRAME_KEY_BYTES) {
    throw new Error(`frame key must be ${FRAME_KEY_BYTES} bytes`);
  }
  return {
    frameKey,
    binding: { grant: payload.grant, session: payload.session, run: payload.run, exp: payload.exp },
  };
}

export async function hashBearer(bearer: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(bearer));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Import an ECDH-ES private JWK (which carries the public components) into a CryptoKeyPair so
// the same deployment secret can both mint (publicKey) and verify (privateKey).
export async function importEcKeyPair(jwk: Record<string, unknown>): Promise<CryptoKeyPair> {
  const publicJwk: Record<string, unknown> = { ...jwk };
  delete publicJwk.d;
  const privateKey = (await importJWK(jwk, "ECDH-ES", { extractable: false })) as CryptoKey;
  const publicKey = (await importJWK(publicJwk, "ECDH-ES", { extractable: false })) as CryptoKey;
  return { publicKey, privateKey };
}
