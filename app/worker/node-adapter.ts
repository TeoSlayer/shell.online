import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Runs the Node router in server/app.ts on a Workers request.
 *
 * The router was written against node:http and there is no node:http on
 * Workers, so this builds the small part of those objects that the router
 * actually touches. That part is short and fixed, and naming it here is the
 * whole design:
 *
 *   reads   method, url (path and query), headers, socket.remoteAddress
 *   body    the "data", "end" and "error" events, plus destroy()
 *   writes  writeHead(status, headers), setHeader(name, value), end(body)
 *
 * Nothing else exists here and nothing else should. This is an adapter for one
 * known caller, not a Node compatibility layer: anything the router does not
 * use would be untested code pretending to be a runtime. server/app.test.ts
 * already drives the same router through shims of the same shape, which is the
 * evidence that a handler with no Node objects behind it works at all.
 */

export type NodeHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export async function callNodeHandler(request: Request, handle: NodeHandler): Promise<Response> {
  const url = new URL(request.url);

  /* IncomingMessage.headers is lowercase-keyed, and so is a Headers iterator. */
  const incoming: Record<string, string> = {};
  for (const [name, value] of request.headers) incoming[name] = value;

  /*
   * The body is read in full before the router starts. readBody registers its
   * listeners synchronously and expects the events to arrive on their own, so
   * there is nowhere in it to await a stream; buffering first and replaying on
   * subscription is what makes a promise-shaped body fit an emitter-shaped
   * reader. The router still applies its own 64 KB limit to what it is handed,
   * and Cloudflare caps the request before that.
   */
  const chunks: Uint8Array[] = [];
  const body = new Uint8Array(await request.arrayBuffer());
  /* No chunks at all is how readBody recognises an empty body, not one chunk
     of length zero. */
  if (body.byteLength > 0) chunks.push(body);

  const nodeRequest = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: incoming,
    /*
     * The peer address as Cloudflare knows it. This is the one the rate
     * limiter must count, and it is why the Worker runs with trustProxy off:
     * X-Forwarded-For arrives from the caller and can say anything, while
     * CF-Connecting-IP is written by the edge and cannot be spoofed past it.
     */
    socket: { remoteAddress: request.headers.get("CF-Connecting-IP") ?? undefined },
    on(event: string, listener: (chunk?: unknown) => void) {
      /* Delivered as the router subscribes. It registers "data" before "end",
         which is the ordering that makes replaying here correct. */
      if (event === "data") for (const chunk of chunks) listener(chunk);
      if (event === "end") listener();
      return nodeRequest;
    },
    /* Called when the body is refused. There is no socket to tear down. */
    destroy() {},
  };

  /* Node's own default, for a handler that answered without a status. */
  let status = 200;
  let payload: string | undefined;
  const outgoing: Record<string, string> = {};

  const nodeResponse = {
    writeHead(code: number, given?: Record<string, string | number>) {
      status = code;
      /*
       * Merged over whatever setHeader put there, which is the precedence
       * node:http gives writeHead. applyCors sets its headers before send
       * writes the status, and both have to survive.
       */
      for (const [name, value] of Object.entries(given ?? {})) outgoing[name] = String(value);
      return nodeResponse;
    },
    setHeader(name: string, value: string | number) {
      outgoing[name] = String(value);
    },
    end(chunk?: string) {
      payload = chunk;
    },
  };

  await handle(nodeRequest as unknown as IncomingMessage, nodeResponse as unknown as ServerResponse);

  /* null rather than "" so a 204 is constructible. */
  return new Response(payload ?? null, { status, headers: outgoing });
}
