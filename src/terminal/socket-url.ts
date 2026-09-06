/**
 * Where to open the terminal websocket for a session.
 *
 * The relay refuses a websocket whose Origin is not its own, so the socket has
 * to look same-origin to the browser. Two cases:
 *
 *  - the app is served from the relay (production): connect straight to it;
 *  - the app is on its own port (development): go through the dev proxy, which
 *    forwards to the relay and rewrites the Origin.
 *
 * The relay is derived from the share URL rather than configured, so a session
 * recorded against one relay keeps working if another is introduced later.
 */

export const RELAY_PROXY_PREFIX = "/relay";

export interface SocketTarget {
  /** Absolute ws:// or wss:// URL to open. */
  url: string;
  /** True when the connection is going through the development proxy. */
  proxied: boolean;
}

export type SocketResolution =
  | { ok: true; target: SocketTarget }
  | { ok: false; reason: string };

/**
 * @param proxyRelayOrigin origin the dev proxy forwards to, when there is one.
 */
export function resolveSessionSocket(
  shareUrl: string,
  appOrigin: string,
  proxyRelayOrigin?: string,
): SocketResolution {
  let share: URL;
  let app: URL;
  try {
    share = new URL(shareUrl);
    app = new URL(appOrigin);
  } catch {
    return { ok: false, reason: "That session link is not a URL this app understands." };
  }

  const id = share.pathname.match(/^\/s\/([A-Za-z0-9_-]{32})$/)?.[1];
  if (!id) {
    return { ok: false, reason: "That session link does not point at a session." };
  }

  const scheme = app.protocol === "https:" ? "wss:" : "ws:";
  const path = `/api/sessions/${id}/ws`;

  if (share.origin === app.origin) {
    return { ok: true, target: { url: `${scheme}//${app.host}${path}`, proxied: false } };
  }

  /*
   * The proxy forwards to exactly one relay. Sending a session recorded
   * against a different relay down it would open a socket to the wrong
   * service and report the session as missing, which is a confusing way to
   * describe a misconfiguration. Say what is actually wrong instead.
   */
  if (!proxyRelayOrigin) {
    return {
      ok: false,
      reason: `This session lives on ${share.origin}, which this app is not configured to reach.`,
    };
  }
  let relay: URL;
  try {
    relay = new URL(proxyRelayOrigin);
  } catch {
    return { ok: false, reason: "The configured relay URL is not valid." };
  }
  if (relay.origin !== share.origin) {
    return {
      ok: false,
      reason:
        `This session is on ${share.origin}, but this app proxies to ${relay.origin}. ` +
        `Start it with SHELL_ONLINE_SERVER=${relay.origin} to open it here.`,
    };
  }

  return {
    ok: true,
    target: { url: `${scheme}//${app.host}${RELAY_PROXY_PREFIX}${path}`, proxied: true },
  };
}

/** The 32-character session id inside a share URL, or null. */
export function sessionIdFromShareUrl(shareUrl: string): string | null {
  try {
    return new URL(shareUrl).pathname.match(/^\/s\/([A-Za-z0-9_-]{32})$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The `#salt=` / `#key=` fragment of a share URL, or an empty string. */
export function encryptionFragment(shareUrl: string): string {
  try {
    return new URL(shareUrl).hash;
  } catch {
    return "";
  }
}
