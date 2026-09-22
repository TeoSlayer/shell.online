/**
 * Security policy shared by the Node and Worker app frontends.
 *
 * Sign-in is a redirect to an OpenID Connect provider whose address is a
 * deployment's choice, so the policy is built from that address rather than
 * from a list of hostnames. The provider needs three things: the browser
 * fetches its discovery document, JWKS and token endpoint (`connect-src`), it
 * is navigated to for the authorization request (`form-action`, which also
 * covers a navigation started by a form), and the hidden iframe that renews a
 * session loads the callback on this origin (`frame-src 'self'`).
 */
import { POSTHOG_ORIGIN } from "../../../shared/posthog.ts";

function policy(issuer?: string): string {
  const provider = originOf(issuer);
  if (!provider) {
    /* Existing hosted Firebase sign-in: popup, hosted iframe and token APIs. */
    return [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self' https://apis.google.com",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: https:",
      `connect-src 'self' wss: ${POSTHOG_ORIGIN} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseinstallations.googleapis.com`,
      "frame-src https://*.firebaseapp.com https://*.web.app https://accounts.google.com",
      "form-action 'self'",
    ].join("; ");
  }
  const connect = ["'self'", "wss:", POSTHOG_ORIGIN, provider].filter(Boolean).join(" ");
  const form = ["'self'", provider].filter(Boolean).join(" ");
  const frame = ["'self'", provider].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    /*
     * 'self', not 'none': the silent renew loads this app's callback route in
     * a hidden iframe on this same origin, and 'none' would refuse it — which
     * shows up as sessions quietly ending at the token's expiry rather than
     * as an error anybody sees.
     */
    "frame-ancestors 'self'",
    `frame-src ${frame}`,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: https:",
    `connect-src ${connect}`,
    `form-action ${form}`,
  ].join("; ");
}

/** The provider's origin, or nothing when it is unset or unparseable. */
function originOf(issuer?: string): string {
  if (!issuer) return "";
  try {
    return new URL(issuer).origin;
  } catch {
    return "";
  }
}

export function browserSecurityHeaders(issuer?: string): Readonly<Record<string, string>> {
  const oidc = Boolean(originOf(issuer));
  return {
    "Content-Security-Policy": policy(issuer),
    /*
     * The re-authentication popup is polled for closure by oidc-client-ts.
     * Under the default COOP the browser severs that handle, so the popup
     * never resolves; this keeps the isolation and the handle both.
     */
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "X-Content-Type-Options": "nosniff",
    /* Same reason as frame-ancestors above: the renewal iframe is our own. */
    "X-Frame-Options": oidc ? "SAMEORIGIN" : "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

/** The policy for a deployment that has not named its provider. */
export const BROWSER_SECURITY_HEADERS: Readonly<Record<string, string>> = browserSecurityHeaders();
