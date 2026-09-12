import { resolve } from "node:path";
import { createAccountsServer } from "./app";
import {
  ConfigError,
  allowedOriginsFor,
  readConfig,
  withoutCredentials,
  type Config,
} from "./lib/config";
import { createVerifier } from "./lib/firebase-token";
import { createMailer } from "./lib/mail";
import { relayProxy } from "./lib/relay-proxy";
import { staticFiles } from "./lib/static-files";
import { MemoryStore } from "./lib/store-memory";
import { PostgresStore } from "./lib/store-postgres";
import type { Store } from "./lib/store";
import { relaySessionLiveness } from "./lib/session-liveness";

let config: Config;
try {
  config = readConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`accounts: ${error.message}`);
  process.exit(1);
}

/*
 * Postgres when there is one, the file otherwise. readConfig has already
 * refused the file store under NODE_ENV=production, so this only chooses
 * between two things that are both correct where they run.
 */
const store: Store = config.databaseUrl
  ? await PostgresStore.connect(config.databaseUrl, { max: config.databasePoolMax })
  : new MemoryStore(resolve(config.dataFile));

/*
 * When this process serves the client too, the app and its API share an
 * origin, which is what lets a terminal websocket exist at all: the relay
 * refuses one whose Origin is not its own, and the browser sets that from
 * wherever the page came. /relay/* is forwarded with the Origin rewritten.
 */
const forward = config.relayUrl ? relayProxy(config.relayUrl) : null;

const server = createAccountsServer({
  store,
  verifyIdToken: createVerifier(config.projectId),
  allowedOrigins: allowedOriginsFor(config.webOrigin),
  webOrigin: config.webOrigin,
  trustProxy: config.trustProxy,
  mailer: createMailer(config.mail),
  serveClient: config.clientDir ? staticFiles(config.clientDir) : undefined,
  relay: forward ?? undefined,
  sessionLiveness: config.relayUrl ? relaySessionLiveness(config.relayUrl) : undefined,
});

if (forward) {
  server.on("upgrade", (request, socket, head) => {
    if (forward.handles(request.url)) return forward.upgrade(request, socket, head);
    /* Nothing else here speaks a protocol worth upgrading to. */
    socket.destroy();
  });
}

/*
 * A request that stalls holds a connection and, with Postgres, a pooled one
 * behind it. These caps are well above any honest request to this service and
 * well below the point where slow clients become a way to exhaust it.
 */
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000;

/*
 * Housekeeping on a timer rather than on the request path. It used to run on
 * every request, which with a database meant two DELETE statements per call
 * for work that only needs doing every few minutes. Unreferenced, so it never
 * keeps the process alive on its own.
 */
const purge = setInterval(() => {
  void store.purgeExpired().catch((error) => console.error("accounts: purge failed", error));
}, config.purgeIntervalMs);
purge.unref();

/*
 * A rejection nobody handled is almost always one request going wrong, and
 * every other session in flight should not pay for it. So it is logged and
 * the process carries on.
 */
process.on("unhandledRejection", (reason) => {
  console.error("accounts: unhandled rejection", reason);
});

/*
 * An uncaught exception is different: by definition nothing anticipated it, so
 * what the process is now doing is unknown. Logging and carrying on would have
 * meant a container that failed to bind its port sat there answering nothing
 * and exiting 0, which reads as a healthy deploy. Say what happened, then let
 * the orchestrator restart it.
 */
process.on("uncaughtException", (error) => {
  console.error("accounts: uncaught exception", error);
  process.exit(1);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`accounts: port ${config.port} is already in use`);
  } else {
    console.error("accounts: server error", error);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  /*
   * Names what is configured, never the values. The data file path can carry a
   * home directory, and any of these URLs may carry credentials, so the line
   * says which store and which relay in the abstract and leaves the rest to
   * whoever set them.
   */
  const backing = config.databaseUrl ? "postgres" : "file";
  const serving = config.clientDir
    ? `client, relay ${withoutCredentials(config.relayUrl)}`
    : "api only";
  console.log(
    `accounts: listening on ${config.host}:${config.port} ` +
      `(web ${withoutCredentials(config.webOrigin)}, store ${backing}, ${serving})`,
  );
});

/*
 * A container is stopped with SIGTERM and killed shortly after. Closing the
 * listener first lets requests in flight finish; releasing the pool after that
 * means the last of them still has a connection to finish on.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    clearInterval(purge);
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
  });
}
