import type { IssuerSettings } from "./oidc-token";

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
  /** Firebase project whose ID tokens are accepted. Empty under OIDC_ISSUER. */
  projectId: string;
  /**
   * The issuer whose ID tokens are accepted, and how to check them.
   *
   * Firebase is one OpenID provider among others, so it is described the same
   * way as any other rather than being a mode of its own: FIREBASE_PROJECT_ID
   * is shorthand for an issuer and audience that can also be written out.
   */
  identity: IssuerSettings;
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
  /**
   * Where feedback sent from the app is forwarded by email. Absent keeps it
   * in the database only, which is still the record.
   */
  feedbackTo?: string;
  /**
   * The bearer token the relay's statistics dashboard presents for account
   * figures. Absent means that route does not exist.
   */
  statsToken?: string;
}

export class ConfigError extends Error {}

/**
 * Where settings are read from.
 *
 * `process.env` on Node and the bindings object on Workers, which is not a
 * `ProcessEnv` but is the same shape as far as anything here is concerned.
 */
export type Env = Record<string, string | undefined>;

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

function required(env: Env, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new ConfigError(`set ${names.join(" or ")}`);
}

const FIREBASE_ISSUER = "https://securetoken.google.com/";
const FIREBASE_JWKS =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/**
 * Which identity provider signs the ID tokens this service accepts.
 *
 * OIDC_ISSUER wins when it is set, because naming an issuer is the more
 * specific statement; a deployment carrying both has almost certainly just
 * migrated and left the old variable behind.
 *
 * The audience has to be given separately: for Firebase it happens to equal
 * the project id, but for everything else it is the client id, and guessing it
 * from the issuer would accept tokens minted for a different application on
 * the same provider.
 */
export function readIdentity(env: Env): { projectId: string; identity: IssuerSettings } {
  /*
   * The client's copy is accepted too, the way the Firebase project id was: a
   * single-container deployment sets the VITE_ values because the client is
   * built from the same .env, and making it repeat them for the server is how
   * the two come to disagree about which provider is in use.
   */
  /* `||`, not `??`: an unset repository variable arrives as the empty string. */
  const issuer = env.OIDC_ISSUER?.trim() || env.VITE_OIDC_ISSUER?.trim();
  if (issuer) {
    try {
      new URL(issuer);
    } catch {
      throw new ConfigError(`OIDC_ISSUER must be a URL, got ${issuer}`);
    }
    const audience = required(env, "OIDC_AUDIENCE", "OIDC_CLIENT_ID", "VITE_OIDC_CLIENT_ID");
    return {
      projectId: "",
      identity: {
        /* Trailing slashes are a common paste artefact and never part of iss. */
        issuer: issuer.replace(/\/$/, ""),
        audience,
        jwksUri: env.OIDC_JWKS_URI?.trim() || undefined,
      },
    };
  }

  const projectId = required(env, "FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID", "OIDC_ISSUER");
  return {
    projectId,
    identity: {
      issuer: FIREBASE_ISSUER + projectId,
      audience: projectId,
      jwksUri: FIREBASE_JWKS,
    },
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";

  const port = Number(env.PORT ?? env.ACCOUNTS_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`PORT must be a port number, got ${env.PORT ?? env.ACCOUNTS_PORT}`);
  }

  const { projectId, identity } = readIdentity(env);

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

  const statsToken = env.STATS_TOKEN?.trim() || undefined;
  /* A short token is a guessable one, and this one opens business figures. */
  if (statsToken !== undefined && statsToken.length < 32) {
    throw new ConfigError("STATS_TOKEN must be at least 32 characters");
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
    identity,
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
    feedbackTo: env.FEEDBACK_TO?.trim() || undefined,
    statsToken,
  };
}
