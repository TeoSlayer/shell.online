import { describe, expect, it } from "vitest";
import { ConfigError, allowedOriginsFor, readConfig, withoutCredentials } from "./config";

/**
 * A container that is going to fail should fail while it is starting, with a
 * line naming the variable. These are the mistakes that would otherwise be
 * found by a user, at the moment they needed the thing that was misconfigured.
 */
const MINIMAL = { FIREBASE_PROJECT_ID: "test-firebase-project" };

describe("readConfig", () => {
  it("needs a project whose tokens it can verify", () => {
    expect(() => readConfig({})).toThrow(ConfigError);
    expect(() => readConfig({})).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it("accepts the client's copy of the project id", () => {
    expect(readConfig({ VITE_FIREBASE_PROJECT_ID: "p" }).projectId).toBe("p");
  });

  it("spells a Firebase project as the issuer it actually is", () => {
    expect(readConfig({ FIREBASE_PROJECT_ID: "p" }).identity).toEqual({
      issuer: "https://securetoken.google.com/p",
      audience: "p",
      jwksUri:
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    });
  });

  it("takes any OpenID issuer, and prefers it to a leftover Firebase project", () => {
    const config = readConfig({
      ...MINIMAL,
      OIDC_ISSUER: "https://auth.example.test/realms/shell",
      OIDC_CLIENT_ID: "shell-online-app",
    });
    expect(config.identity).toEqual({
      issuer: "https://auth.example.test/realms/shell",
      audience: "shell-online-app",
      jwksUri: undefined,
    });
    expect(config.projectId).toBe("");
  });

  /* A trailing slash is a paste artefact and is never part of `iss`. */
  it("trims a trailing slash from the issuer", () => {
    const config = readConfig({
      OIDC_ISSUER: "https://auth.example.test/realms/shell/",
      OIDC_AUDIENCE: "a",
    });
    expect(config.identity.issuer).toBe("https://auth.example.test/realms/shell");
  });

  it("refuses an issuer without an audience, which would accept another app's tokens", () => {
    expect(() => readConfig({ OIDC_ISSUER: "https://auth.example.test/realms/shell" })).toThrow(
      /OIDC_AUDIENCE/,
    );
  });

  it("refuses an issuer that is not a URL", () => {
    expect(() => readConfig({ OIDC_ISSUER: "auth.example.test", OIDC_AUDIENCE: "a" })).toThrow(
      /OIDC_ISSUER/,
    );
  });

  it("takes an explicit key set, for a provider that publishes one elsewhere", () => {
    const config = readConfig({
      OIDC_ISSUER: "https://auth.example.test/realms/shell",
      OIDC_AUDIENCE: "a",
      OIDC_JWKS_URI: "https://auth.example.test/keys",
    });
    expect(config.identity.jwksUri).toBe("https://auth.example.test/keys");
  });

  it("refuses a port that is not one", () => {
    expect(() => readConfig({ ...MINIMAL, PORT: "http" })).toThrow(/PORT/);
    expect(() => readConfig({ ...MINIMAL, PORT: "70000" })).toThrow(/PORT/);
    expect(readConfig({ ...MINIMAL, PORT: "8080" }).port).toBe(8080);
  });

  it("refuses a web origin that is not a URL", () => {
    expect(() => readConfig({ ...MINIMAL, WEB_ORIGIN: "app.example.com" })).toThrow(/WEB_ORIGIN/);
  });

  /*
   * The file store is one process rewriting a whole file per mutation. It
   * works, right up until a second instance starts, which is quiet enough to
   * be worth refusing outright.
   */
  it("refuses the file store in production", () => {
    expect(() => readConfig({ ...MINIMAL, NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
    expect(
      readConfig({ ...MINIMAL, NODE_ENV: "production", DATABASE_URL: "postgres://x/y" }).databaseUrl,
    ).toBe("postgres://x/y");
  });

  it("binds loopback in development and the interface in production", () => {
    expect(readConfig(MINIMAL).host).toBe("127.0.0.1");
    expect(readConfig({ ...MINIMAL, NODE_ENV: "production", DATABASE_URL: "postgres://x/y" }).host).toBe(
      "0.0.0.0",
    );
    expect(readConfig({ ...MINIMAL, HOST: "::1" }).host).toBe("::1");
  });

  /*
   * Serving the client without somewhere to forward /relay/* leaves every
   * terminal unable to connect, and it looks like a relay outage rather than
   * a missing variable.
   */
  it("refuses to serve the client with no relay to proxy", () => {
    expect(() => readConfig({ ...MINIMAL, CLIENT_DIR: "/app/dist" })).toThrow(/RELAY_URL/);
    expect(
      readConfig({ ...MINIMAL, CLIENT_DIR: "/app/dist", RELAY_URL: "https://shell.online" }).relayUrl,
    ).toBe("https://shell.online");
  });

  it("refuses a relay that is not a URL", () => {
    expect(() => readConfig({ ...MINIMAL, RELAY_URL: "shell.online" })).toThrow(/RELAY_URL/);
  });

  /*
   * Off unless the deployment says so. Believing the header without a proxy
   * in front lets a caller pick a new address per request, and the rate
   * limiter never sees the same caller twice.
   */
  it("does not trust a forwarded address by default", () => {
    expect(readConfig(MINIMAL).trustProxy).toBe(false);
    expect(readConfig({ ...MINIMAL, TRUST_PROXY: "1" }).trustProxy).toBe(true);
    expect(readConfig({ ...MINIMAL, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(readConfig({ ...MINIMAL, TRUST_PROXY: "no" }).trustProxy).toBe(false);
  });

  it("treats a blank variable as absent rather than as a value", () => {
    expect(readConfig({ ...MINIMAL, DATABASE_URL: "   " }).databaseUrl).toBeUndefined();
    expect(readConfig({ ...MINIMAL, CLIENT_DIR: "" }).clientDir).toBeUndefined();
  });
});

describe("withoutCredentials", () => {
  /*
   * A URL may carry a username and password. Several of these settings are
   * URLs an operator supplies, and a startup line often ends up in a log an
   * aggregator keeps for a year.
   */
  it("strips userinfo from a URL", () => {
    expect(withoutCredentials("postgres://app:s3cret@10.0.0.4:5432/shell")).toBe("postgres://***@10.0.0.4:5432");
    expect(withoutCredentials("https://user@relay.example.com")).toBe("https://***@relay.example.com");
  });

  it("keeps a URL that carries none of it readable", () => {
    expect(withoutCredentials("https://app.shell.online")).toBe("https://app.shell.online");
    expect(withoutCredentials("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
  });

  /* Saying nothing beats guessing what an unparseable value holds. */
  it("says only that something is set when it is not a URL", () => {
    expect(withoutCredentials("/srv/data/accounts.json")).toBe("set");
    expect(withoutCredentials(undefined)).toBe("none");
    expect(withoutCredentials("")).toBe("none");
  });

  it("never echoes a password back, whatever the shape", () => {
    for (const value of [
      "postgres://u:p@h/db",
      "https://:onlypassword@h",
      "redis://user:pa$$w0rd@h:6379",
    ]) {
      const printed = withoutCredentials(value);
      expect(printed).not.toContain("p@");
      expect(printed).not.toMatch(/onlypassword|pa\$\$w0rd|:p@/);
    }
  });
});

describe("readConfig statistics settings", () => {
  it("reads the accounts the statistics leave out, and excludes nobody by default", () => {
    expect(readConfig(MINIMAL).excludedAccounts).toEqual([]);
    expect(readConfig({ ...MINIMAL, STATS_EXCLUDE: "Ours.example, someone@mail.example" }).excludedAccounts)
      .toEqual(["ours.example", "someone@mail.example"]);
  });

  it("refuses a statistics token short enough to guess", () => {
    expect(() => readConfig({ ...MINIMAL, STATS_TOKEN: "short" })).toThrow(/STATS_TOKEN/);
    expect(readConfig({ ...MINIMAL, STATS_TOKEN: "t".repeat(32) }).statsToken).toBe("t".repeat(32));
  });
});

describe("allowedOriginsFor", () => {
  /*
   * A page on somebody's own machine must not be able to call production with
   * a token it was given. The dev origin exists only because Vite serves the
   * client on a different port from the service.
   */
  it("allows only the deployment's own origin in production", () => {
    expect(allowedOriginsFor("https://app.shell.online")).toEqual(["https://app.shell.online"]);
    expect(allowedOriginsFor("https://shell-online-app.workers.dev")).not.toContain(
      "http://127.0.0.1:5173",
    );
  });

  it("adds the dev server when the deployment is itself loopback", () => {
    expect(allowedOriginsFor("http://localhost:5173")).toContain("http://127.0.0.1:5173");
    expect(allowedOriginsFor("http://127.0.0.1:8787")).toContain("http://localhost:5173");
  });

  it("does not widen an origin it cannot parse", () => {
    expect(allowedOriginsFor("not a url")).toEqual(["not a url"]);
  });
});
