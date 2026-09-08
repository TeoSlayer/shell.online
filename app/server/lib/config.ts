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
  /**
   * The relay to forward /relay/* to. Required whenever the client is served
   * from here, because a browser on this origin cannot reach the relay itself.
   */
  relayUrl?: string;
  /**
   * Whether a proxy in front rewrites X-Forwarded-For. Off by default: an
   * unproxied deployment that believed the header would let any caller pick a
   * new address per request and walk past the rate limiter.
   */
  trustProxy: boolean;
  /** How often expired codes and finished commands are swept. */
  purgeIntervalMs: number;
  /**
   * Connections this instance may hold. Postgres counts them per server, so
   * this multiplied by the instance count has to stay under the database's
   * max_connections with room to spare for administration.
   */
  databasePoolMax: number;
  /**
   * Where to post outgoing mail, and as whom. All three are needed before
   * anything is sent; with any of them missing the message is logged instead,
   * so an unconfigured deployment still creates a perfectly good invite.
   */
  mail: { provider?: "sendgrid" | "json"; apiUrl?: string; apiKey?: string; from?: string };
}

export class ConfigError extends Error {}

/**
 * Which browser origins may call the API.
 *
 * The Vite dev server runs on a different port from the service, so
 * development needs its loopback origin allowed. A deployment must not: a page
 * on someone's own machine could otherwise make cross-origin calls against
 * production with a token it had been given.
 *
 * Rather than a separate switch to forget, the deployment tells us which it is
 * by where it says it is served from. A loopback WEB_ORIGIN is development.
 */
export function allowedOriginsFor(webOrigin: string): string[] {
  let host = "";
  try {
    host = new URL(webOrigin).hostname;
  } catch {
    return [webOrigin];
  }
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  return loopback ? [webOrigin, "http://localhost:5173", "http://127.0.0.1:5173"] : [webOrigin];
}

/**
 * A URL with any credentials taken out, for printing.
 *
 * A URL is allowed to carry a username and password, and several of these
 * settings are URLs an operator supplies. Echoing one back into the startup
 * line, or into a log an aggregator keeps for a year, would publish a
 * credential nobody meant to share. The host is the useful part; the userinfo
 * never is.
 */
export function withoutCredentials(value: string | undefined): string {
  if (!value) return "none";
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    return `${url.protocol}//***@${url.host}`;
  } catch {
    /* Not a URL. Say nothing about it rather than guess what it holds. */
    return "set";
  }
}

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

  const clientDir = env.CLIENT_DIR?.trim() || undefined;
  const relayUrl = env.RELAY_URL?.trim() || undefined;
  if (relayUrl) {
    try {
      new URL(relayUrl);
    } catch {
      throw new ConfigError(`RELAY_URL must be a URL, got ${relayUrl}`);
    }
  }
  /*
   * Serving the app without somewhere to forward /relay/* would leave every
   * terminal unable to connect, and it would look like a relay outage rather
   * than a missing variable.
   */
  if (clientDir && !relayUrl) {
    throw new ConfigError("set RELAY_URL: a client served from here needs the relay proxied");
  }

  return {
    port,
    host: env.HOST?.trim() ?? (production ? "0.0.0.0" : "127.0.0.1"),
    projectId,
    webOrigin,
    databaseUrl,
    dataFile: env.ACCOUNTS_DATA?.trim() ?? ".data/accounts.json",
    clientDir,
    relayUrl,
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    databasePoolMax: Number(env.DATABASE_POOL_MAX ?? 5),
    purgeIntervalMs: 5 * 60_000,
    mail: {
      /*
       * SendGrid unless told otherwise, since that is what this deployment
       * uses. Anything else speaks the flat JSON body that Resend and
       * Postmark accept, and needs its URL given.
       */
      provider: env.MAIL_PROVIDER?.trim() === "json" ? "json" : "sendgrid",
      apiUrl: env.MAIL_API_URL?.trim() || undefined,
      apiKey: env.MAIL_API_KEY?.trim() || undefined,
      from: env.MAIL_FROM?.trim() || undefined,
    },
  };
}
