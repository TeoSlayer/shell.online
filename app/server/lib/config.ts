/**
 * Everything the service reads from the environment, checked once at boot.
 *
 * A container that is going to fail should fail while it is starting, with a
 * line saying which variable is wrong -- not on the first request that happens
 * to need the value. So this throws rather than falling back to a default that
 * would be wrong in production.
 */
export interface Config {
  port: number;
  /** Loopback in development; a container has to bind its network interface. */
  host: string;
  /** Firebase project whose ID tokens are accepted. */
  projectId: string;
  /** Where the browser app is served from, for CORS and link building. */
  webOrigin: string;
  /** Postgres connection string. Absent means the file store, for development. */
  databaseUrl?: string;
  /** Where the file store writes, when there is no database. */
  dataFile: string;
  /** Serve the built client from this directory, making the app single-origin. */
  clientDir?: string;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new ConfigError(`set ${names.join(" or ")}`);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";

  const port = Number(env.PORT ?? env.ACCOUNTS_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`PORT must be a port number, got ${env.PORT ?? env.ACCOUNTS_PORT}`);
  }

  const projectId = required(env, "FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID");

  const webOrigin = env.WEB_ORIGIN?.trim() ?? "http://localhost:5173";
  try {
    new URL(webOrigin);
  } catch {
    throw new ConfigError(`WEB_ORIGIN must be a URL, got ${webOrigin}`);
  }

  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  /*
   * The file store is a single process rewriting a whole file per mutation.
   * That is fine for one developer and wrong for a deployment, and the
   * difference is quiet enough -- it works, until two instances run -- that
   * production refuses it outright rather than warning.
   */
  if (production && !databaseUrl) {
    throw new ConfigError("set DATABASE_URL: the file store cannot back a deployment");
  }

  return {
    port,
    host: env.HOST?.trim() ?? (production ? "0.0.0.0" : "127.0.0.1"),
    projectId,
    webOrigin,
    databaseUrl,
    dataFile: env.ACCOUNTS_DATA?.trim() ?? ".data/accounts.json",
    clientDir: env.CLIENT_DIR?.trim() || undefined,
  };
}
