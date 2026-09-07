import { resolve } from "node:path";
import { createAccountsServer } from "./app";
import { ConfigError, readConfig, type Config } from "./lib/config";
import { createVerifier } from "./lib/firebase-token";
import { relayProxy } from "./lib/relay-proxy";
import { staticFiles } from "./lib/static-files";
import { MemoryStore } from "./lib/store-memory";
import { PostgresStore } from "./lib/store-postgres";
import type { Store } from "./lib/store";

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
  ? await PostgresStore.connect(config.databaseUrl)
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
  allowedOrigins: [config.webOrigin, "http://127.0.0.1:5173"],
  trustProxy: config.trustProxy,
  serveClient: config.clientDir ? staticFiles(config.clientDir) : undefined,
  relay: forward ?? undefined,
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
 * A rejection nobody handled would otherwise take the process down with it and
 * print nothing useful. Logging and staying up is right here: one request went
 * wrong, and every other session in flight should not pay for it.
 */
process.on("unhandledRejection", (reason) => {
  console.error("accounts: unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
  console.error("accounts: uncaught exception", error);
});

server.listen(config.port, config.host, () => {
  const backing = config.databaseUrl ? "postgres" : config.dataFile;
  const serving = config.clientDir ? `client ${config.clientDir}, relay ${config.relayUrl}` : "api only";
  console.log(
    `accounts: http://${config.host}:${config.port} ` +
      `(project ${config.projectId}, web ${config.webOrigin}, store ${backing}, ${serving})`,
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
