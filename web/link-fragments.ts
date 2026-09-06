/**
 * Local memory of the decryption fragment for saved shares.
 *
 * An encrypted share keeps its key in the URL fragment, which by design never
 * reaches the relay. The account list therefore cannot carry it: the server
 * only ever knows a session id. The fragment stays in this browser, keyed by
 * session, and is stitched back on when the account page renders a link.
 *
 * The consequence is deliberate and visible in the UI: a link saved on one
 * device can only be reopened in full on that device. Sending the fragment to
 * the relay would make the list portable but would hand over the key, which
 * is exactly what end-to-end encryption is there to prevent.
 */
const PREFIX = "shell-online:link-fragment:";

export function rememberLinkFragment(sessionId: string, fragment: string): void {
  if (!sessionId || !fragment || fragment === "#") return;
  try {
    localStorage.setItem(PREFIX + sessionId, fragment.startsWith("#") ? fragment : `#${fragment}`);
  } catch {
    // Storage may be unavailable; the account page then says the key is elsewhere.
  }
}

export function linkFragmentFor(sessionId: string): string {
  try {
    return localStorage.getItem(PREFIX + sessionId) ?? "";
  } catch {
    return "";
  }
}

export function forgetLinkFragment(sessionId: string): void {
  try {
    localStorage.removeItem(PREFIX + sessionId);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** Rebuilds a complete share URL, including the fragment when this browser has it. */
export function completeShareUrl(shareUrl: string, sessionId: string): string {
  if (shareUrl.includes("#")) return shareUrl;
  return shareUrl + linkFragmentFor(sessionId);
}
