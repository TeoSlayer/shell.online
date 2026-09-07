import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Forwards /relay/* to the relay, rewriting the Origin.
 *
 * The relay accepts a websocket only from its own origin. The browser sets the
 * Origin from wherever the page was served, so an app on its own hostname can
 * never open one directly -- and the relay is the user's own deployment of
 * shell.online, not something this service should be asking to relax.
 *
 * So the socket is opened from here instead. The browser connects same-origin
 * to this service, and this service connects to the relay as the relay expects.
 * The dev server does exactly this; this is the same thing in production, and
 * the client already knows to use the /relay prefix when the app and the relay
 * are not the same origin.
 *
 * Nothing here can read the terminal: frames are encrypted in the browser
 * before they reach the relay, and this proxy sees the same ciphertext the
 * relay does.
 */

export const RELAY_PREFIX = "/relay";

/* Bounded so a stalled relay releases the socket rather than holding it. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Hop-by-hop headers, which belong to one connection and are not forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "origin",
]);

function forwardable(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return out;
}

export interface RelayProxy {
  /** True when this URL is the proxy's to answer. */
  handles(url: string | undefined): boolean;
  request(request: IncomingMessage, response: ServerResponse): void;
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/**
 * @param relayUrl origin of the relay, e.g. https://shell.online
 */
export function relayProxy(relayUrl: string): RelayProxy {
  const relay = new URL(relayUrl);
  const send = relay.protocol === "https:" ? httpsRequest : httpRequest;
  const port = relay.port || (relay.protocol === "https:" ? 443 : 80);

  function targetPath(url: string | undefined): string {
    const path = (url ?? "/").slice(RELAY_PREFIX.length);
    return path.startsWith("/") ? path : `/${path}`;
  }

  function options(incoming: IncomingMessage) {
    return {
      protocol: relay.protocol,
      hostname: relay.hostname,
      port,
      method: incoming.method,
      path: targetPath(incoming.url),
      headers: {
        ...forwardable(incoming.headers),
        host: relay.host,
        /* The whole point: the relay must see a request from its own origin. */
        origin: relay.origin,
      },
    };
  }

  return {
    handles(url) {
      return (url ?? "").startsWith(`${RELAY_PREFIX}/`) || url === RELAY_PREFIX;
    },

    request(incoming, response) {
      const outgoing = send(options(incoming));
      outgoing.setTimeout(CONNECT_TIMEOUT_MS, () => outgoing.destroy());
      outgoing.on("response", (relayed) => {
        response.writeHead(relayed.statusCode ?? 502, forwardable(relayed.headers));
        relayed.pipe(response);
      });
      outgoing.on("error", () => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "relay unreachable" }));
      });
      incoming.pipe(outgoing);
    },

    upgrade(incoming, socket, head) {
      const outgoing = send({
        ...options(incoming),
        headers: {
          ...options(incoming).headers,
          connection: "Upgrade",
          upgrade: "websocket",
        },
      });
      outgoing.setTimeout(CONNECT_TIMEOUT_MS, () => outgoing.destroy());

      outgoing.on("upgrade", (relayed, relaySocket, relayHead) => {
        /*
         * The handshake is replayed verbatim rather than rebuilt: the accept
         * key and any negotiated extensions are the relay's answer to this
         * client's offer, and rewriting them would break the negotiation the
         * two ends already agreed on.
         */
        const lines = [`HTTP/1.1 101 ${relayed.statusMessage ?? "Switching Protocols"}`];
        for (const [name, value] of Object.entries(relayed.headers)) {
          for (const single of Array.isArray(value) ? value : [value ?? ""]) {
            lines.push(`${name}: ${single}`);
          }
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);

        if (relayHead?.length) socket.unshift(relayHead);
        if (head?.length) relaySocket.unshift(head);

        /* Terminal traffic is many tiny frames; Nagle would add latency. */
        if ("setNoDelay" in socket) (socket as Socket).setNoDelay(true);
        relaySocket.setNoDelay(true);
        /* Either end closing takes the other with it; neither is worth keeping. */
        socket.on("error", () => relaySocket.destroy());
        relaySocket.on("error", () => socket.destroy());
        socket.pipe(relaySocket).pipe(socket);
      });

      /*
       * A relay that answers an upgrade with an ordinary response is refusing
       * it -- a 403 for a bad origin, a 404 for a session that has gone. That
       * status is the useful thing to pass on, not a generic failure.
       */
      outgoing.on("response", (relayed) => {
        socket.write(`HTTP/1.1 ${relayed.statusCode ?? 502} ${relayed.statusMessage ?? ""}\r\n\r\n`);
        socket.end();
      });
      outgoing.on("error", () => {
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.end();
      });
      outgoing.end();
    },
  };
}
