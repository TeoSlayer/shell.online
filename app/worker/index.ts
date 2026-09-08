import { AsyncLocalStorage } from "node:async_hooks";
import { createApp } from "../server/app";
import { createVerifier } from "../server/lib/firebase-token";
import { createMailer } from "../server/lib/mail";
import type { Store } from "../server/lib/store";
import { PostgresStore } from "../server/lib/store-postgres";
import { callNodeHandler, type NodeHandler } from "./node-adapter";
import { allowedOriginsFor } from "../server/lib/config";

/**
 * The Worker deployment of the accounts service.
 *
 * server/index.ts is the same service on Node: a listener, a static file
 * server, a relay proxy and a purge timer around the router in server/app.ts.
 * On Workers three of those four are the platform's, so what is left here is
 * the wiring and one adapter. The router itself is shared and unchanged, which
 * is the point -- the tests that cover it cover this too.
 */

/*
 * The bindings this Worker is given, declared here rather than pulled from
 * @cloudflare/workers-types: these five members are all the code touches, and
 * the app package has no reason to carry the whole runtime's type surface for
 * them. wrangler.jsonc is the authority on what is actually bound.
 */
export interface Env {
  /** The built client, served for everything that is not an API route. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Hyperdrive in front of Cloud SQL. Its string is local to the isolate. */
  HYPERDRIVE: { connectionString: string };
  FIREBASE_PROJECT_ID: string;
  WEB_ORIGIN: string;
  RELAY_URL: string;
  MAIL_PROVIDER?: string;
  MAIL_API_URL?: string;
  MAIL_FROM?: string;
  /** Secret, set with `wrangler secret put`. */
  MAIL_API_KEY?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
  cron: string;
}

const RELAY_PREFIX = "/relay";

/*
 * The client is a single page that signs in with a popup, and
 * signInWithPopup polls window.closed on the Google window. Under the default
 * Cross-Origin-Opener-Policy the browser severs that handle and the popup
 * never resolves, so the header has to be on the document. The assets binding
 * does content types, caching and the SPA fallback but has no opinion about
 * this, so it is added on the way out; server/lib/static-files.ts sends the
 * same three headers, and vite.config.ts sends them in development.
 */
const CLIENT_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/*
 * The store belonging to the request being served.
 *
 * A connection cannot outlive the request that opened it: the runtime ties
 * every socket to the request context it was created in, and using one from
 * the next request hangs it until the runtime cancels it. Verified rather than
 * assumed -- a pool held across requests answered every second /api/ready and
 * hung on the others. So a request opens its own store and closes it on the
 * way out, which is what Hyperdrive exists to make cheap: it holds the pool to
 * Postgres, and this side pays for a connection to the local proxy.
 *
 * The router, though, is built once per isolate, because its rate limiter is
 * the memory of who is currently calling and rebuilding it per request would
 * leave nothing to limit with. So the store it is given is a stand-in that
 * finds the one belonging to whichever request is running.
 */
const active = new AsyncLocalStorage<Store>();

const currentStore = new Proxy({} as Store, {
  get(_target, method: string | symbol) {
    return (...args: unknown[]) => {
      const store = active.getStore();
      if (!store) throw new Error("no store: the router ran outside a request");
      const call = (store as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[method];
      return call.apply(store, args);
    };
  },
});

function openStore(env: Env): Promise<PostgresStore> {
  return PostgresStore.connect(env.HYPERDRIVE.connectionString, {
    /*
     * Migrations are `npm run db:migrate`, deliberately. A cold deploy starts
     * dozens of isolates at once and every one of them would race the same DDL
     * behind the same advisory lock, which is a slow start at best and a schema
     * half applied by whichever one lost at worst.
     */
    migrate: false,
    /*
     * A ceiling for one request rather than for the deployment. Nothing here
     * needs more than one connection at a time; the pool opens what it is
     * asked for and no more, and Hyperdrive is what keeps the count at
     * Postgres bounded.
     */
    max: 2,
  });
}

let routing: NodeHandler | undefined;

function routerFor(env: Env): NodeHandler {
  return (routing ??= createApp({
    store: currentStore,
    verifyIdToken: createVerifier(env.FIREBASE_PROJECT_ID),
    /* The first entry is the web app's own origin; see readConfig. */
    allowedOrigins: allowedOriginsFor(env.WEB_ORIGIN),
    webOrigin: env.WEB_ORIGIN,
    /*
     * Off, and it must stay off. node-adapter takes the caller's address from
     * CF-Connecting-IP, which the edge writes and a caller cannot forge.
     * X-Forwarded-For arrives from the caller, so believing it here would let
     * anyone pick a new address per request and walk past the rate limiter.
     */
    trustProxy: false,
    mailer: createMailer({
      provider: env.MAIL_PROVIDER === "json" ? "json" : "sendgrid",
      apiUrl: env.MAIL_API_URL,
      apiKey: env.MAIL_API_KEY,
      from: env.MAIL_FROM,
    }),
    log: (message, error) => console.error(message, error),
  }));
}

function handlesRelay(pathname: string): boolean {
  return pathname === RELAY_PREFIX || pathname.startsWith(`${RELAY_PREFIX}/`);
}

/**
 * Forwards /relay/* to the relay with the Origin rewritten to the relay's own.
 *
 * The relay accepts a websocket only from its own origin. A browser sets the
 * Origin from wherever the page was served, so the app on its own hostname can
 * never open one directly, and the relay is the operator's deployment of
 * shell.online rather than something this service should ask to relax. So the
 * browser connects same-origin to here and here connects onward as the relay
 * expects. server/lib/relay-proxy.ts is the same idea rebuilt by hand, because
 * node:http cannot forward an upgrade without replaying the handshake header
 * by header; on Workers the upgrade rides along with the request and the
 * answer, webSocket and all, is the thing to return.
 *
 * Nothing here can read the terminal. Frames are encrypted in the browser
 * before they reach the relay, so this sees the ciphertext the relay sees.
 */
async function toRelay(request: Request, relayUrl: string): Promise<Response> {
  const relay = new URL(relayUrl);
  const incoming = new URL(request.url);
  const rest = incoming.pathname.slice(RELAY_PREFIX.length) || "/";
  const target = new URL(rest.startsWith("/") ? rest : `/${rest}`, relay.origin);
  target.search = incoming.search;

  const upstream = new Request(target, request);
  /* The whole point: the relay must see a request from its own origin. */
  upstream.headers.set("Origin", relay.origin);

  try {
    /*
     * Returned as it came back rather than rebuilt. A 101 cannot be
     * constructed, and the socket the runtime attached to this response is
     * what makes the terminal work.
     */
    return await fetch(upstream);
  } catch {
    return Response.json({ error: "relay unreachable" }, { status: 502 });
  }
}

async function toClient(request: Request, env: Env): Promise<Response> {
  const served = await env.ASSETS.fetch(request);
  const response = new Response(served.body, served);
  for (const [name, value] of Object.entries(CLIENT_HEADERS)) response.headers.set(name, value);
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    /*
     * Before anything else, including the router's rate limiter: this is the
     * terminal's own traffic, and counting a busy session against a budget
     * meant for credential guessing would cut off the thing the app exists to
     * do.
     */
    if (handlesRelay(pathname)) return toRelay(request, env.RELAY_URL);

    /* Everything that is not the API is a page or an asset of the client. */
    if (!pathname.startsWith("/api/")) return toClient(request, env);

    const handle = routerFor(env);
    const store = await openStore(env);
    try {
      return await active.run(store, () => callNodeHandler(request, handle));
    } finally {
      /*
       * The whole answer is already a string by here, so nothing is still
       * reading. Handing the close to waitUntil returns the response now and
       * releases the connection just after.
       */
      ctx.waitUntil(store.close());
    }
  },

  /*
   * Housekeeping on the cron trigger rather than on the request path. Node
   * runs it on a setInterval the process owns; a Worker owns no process, and
   * doing it per request would mean two DELETE statements on every call for
   * work that needs doing every few minutes.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = await openStore(env);
    try {
      await store.purgeExpired();
    } catch (error) {
      console.error("accounts: purge failed", error);
    } finally {
      await store.close();
    }
  },
};
