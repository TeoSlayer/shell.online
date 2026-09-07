/*
 * The approve screen validates the request before showing an approve button.
 * The service validates it again; this copy exists so a malformed link fails
 * with an explanation instead of a generic error after the user clicks.
 */

export interface AuthorizeRequest {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  port: string;
}

export type ParseResult =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function parseAuthorizeRequest(search: string): ParseResult {
  const params = new URLSearchParams(search);
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "";

  if (!redirectUri || !state || !codeChallenge) {
    return { ok: false, reason: "This link is missing part of the sign-in request." };
  }
  if (method !== "S256") {
    return { ok: false, reason: "This link uses an unsupported challenge method." };
  }
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
    return { ok: false, reason: "This link carries a malformed challenge." };
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { ok: false, reason: "This link carries a malformed callback address." };
  }

  /*
   * A non-loopback callback would send a live code to another machine. That is
   * the one failure here worth naming plainly, because it means the link did
   * not come from a terminal on this computer.
   */
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason:
        "This link points somewhere other than a terminal on this computer, so it was not opened by shell login.",
    };
  }
  if (url.pathname !== "/callback" || !url.port) {
    return { ok: false, reason: "This link carries an unexpected callback address." };
  }

  return { ok: true, request: { redirectUri, state, codeChallenge, port: url.port } };
}

export function buildCallback(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
