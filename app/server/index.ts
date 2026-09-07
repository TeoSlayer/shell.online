import { resolve } from "node:path";
import { createAccountsServer } from "./app";
import { ConfigError, readConfig, type Config } from "./lib/config";
import { createVerifier } from "./lib/firebase-token";
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

const server = createAccountsServer({
  store,
  verifyIdToken: createVerifier(config.projectId),
  allowedOrigins: [config.webOrigin, "http://127.0.0.1:5173"],
});

server.listen(config.port, config.host, () => {
  const backing = config.databaseUrl ? "postgres" : config.dataFile;
  console.log(
    `accounts: http://${config.host}:${config.port} ` +
      `(project ${config.projectId}, web ${config.webOrigin}, store ${backing})`,
  );
});

/*
 * A container is stopped with SIGTERM and killed shortly after. Closing the
 * listener first lets requests in flight finish; releasing the pool after that
 * means the last of them still has a connection to finish on.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
  });
}
