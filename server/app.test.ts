import { beforeEach, describe, expect, it, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type KeyObject } from "jose";
import { createApp } from "./app";
import { Store } from "./lib/store";
import { createVerifier, localKeySet } from "./lib/firebase-token";
import { base64url, deriveChallenge } from "./lib/pkce";

const PROJECT = "vv-cloud-firebase";
const REDIRECT = "http://127.0.0.1:51234/callback";
const ORIGIN = "http://localhost:5173";

let privateKey: KeyObject;
let verifyIdToken: (token: string) => Promise<{ ok: boolean }>;
let store: Store;
let handle: ReturnType<typeof createApp>;
let verifier: string;

/* Signs a token that looks exactly like a Firebase ID token, minus Google. */
async function idToken(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: "ana@example.com", name: "Ana Ferreira", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(String(overrides.iss ?? `https://securetoken.google.com/${PROJECT}`))
    .setAudience(String(overrides.aud ?? PROJECT))
    .setSubject(String(overrides.sub ?? "uid-1"))
    .setIssuedAt()
    .setExpirationTime((overrides.exp as number | string) ?? "1h")
    .sign(privateKey);
}

/* Minimal node-style request/response doubles so routes are tested directly. */
async function call(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string; origin?: string } = {},
) {
  const chunks: Buffer[] = [];
  if (options.body !== undefined) chunks.push(Buffer.from(JSON.stringify(options.body)));

  const request = {
    method,
    url: path,
    headers: {
      ...(options.auth ? { authorization: `Bearer ${options.auth}` } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    on(event: string, handler: (arg?: unknown) => void) {
      if (event === "data") chunks.forEach((chunk) => handler(chunk));
      if (event === "end") handler();
      return request;
    },
    destroy() {},
  };

  let status = 0;
  let payload = "";
  const headers: Record<string, string> = {};
  const response = {
    writeHead(code: number, given?: Record<string, string>) {
      status = code;
      Object.assign(headers, given ?? {});
      return response;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    end(body?: string) {
      payload = body ?? "";
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handle(request as any, response as any);
  return { status, headers, body: payload ? JSON.parse(payload) : null };
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as KeyObject;
  const jwk = await exportJWK(pair.publicKey);
  verifyIdToken = createVerifier(PROJECT, localKeySet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] })) as never;
});

beforeEach(() => {
  store = Store.memory();
  verifier = base64url(randomBytes(48));
  handle = createApp({ store, verifyIdToken: verifyIdToken as never, allowedOrigins: [ORIGIN] });
});

/* Walks the whole login handshake and returns the CLI's tokens. */
async function login() {
  const authorize = await call("POST", "/api/cli/authorize", {
    auth: await idToken(),
    body: {
      redirect_uri: REDIRECT,
      code_challenge: deriveChallenge(verifier),
      code_challenge_method: "S256",
    },
  });
  const token = await call("POST", "/api/cli/token", {
    body: { code: authorize.body.code, code_verifier: verifier, redirect_uri: REDIRECT },
  });
  return token.body as { access_token: string; refresh_token: string };
}

describe("POST /api/cli/authorize", () => {
  it("mints a code for a signed-in user", async () => {
    const result = await call("POST", "/api/cli/authorize", {
      auth: await idToken(),
      body: {
        redirect_uri: REDIRECT,
        code_challenge: deriveChallenge(verifier),
        code_challenge_method: "S256",
      },
    });
    expect(result.status).toBe(200);
    expect(result.body.code).toMatch(/^shc_/);
  });

  it("refuses without a valid ID token", async () => {
    const result = await call("POST", "/api/cli/authorize", {
      body: { redirect_uri: REDIRECT, code_challenge: deriveChallenge(verifier), code_challenge_method: "S256" },
    });
    expect(result.status).toBe(401);
  });

  it("refuses a token minted for another Firebase project", async () => {
    const result = await call("POST", "/api/cli/authorize", {
      auth: await idToken({ aud: "someone-elses-project", iss: "https://securetoken.google.com/someone-elses-project" }),
      body: { redirect_uri: REDIRECT, code_challenge: deriveChallenge(verifier), code_challenge_method: "S256" },
    });
    expect(result.status).toBe(401);
  });

  it("refuses an expired ID token", async () => {
    const result = await call("POST", "/api/cli/authorize", {
      auth: await idToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      body: { redirect_uri: REDIRECT, code_challenge: deriveChallenge(verifier), code_challenge_method: "S256" },
    });
    expect(result.status).toBe(401);
  });

  it("refuses a non-loopback redirect_uri", async () => {
    const result = await call("POST", "/api/cli/authorize", {
      auth: await idToken(),
      body: {
        redirect_uri: "http://evil.example.com:8080/callback",
        code_challenge: deriveChallenge(verifier),
        code_challenge_method: "S256",
      },
    });
    expect(result.status).toBe(400);
  });

  it("refuses a plain code_challenge_method", async () => {
    const result = await call("POST", "/api/cli/authorize", {
      auth: await idToken(),
      body: { redirect_uri: REDIRECT, code_challenge: deriveChallenge(verifier), code_challenge_method: "plain" },
    });
    expect(result.status).toBe(400);
  });
});

describe("POST /api/cli/token", () => {
  it("exchanges the code for scoped tokens and the account", async () => {
    const tokens = await login();
    expect(tokens.access_token).toMatch(/^sha_/);
    expect(tokens.refresh_token).toMatch(/^shr_/);
  });

  it("never returns the Firebase ID token to the CLI", async () => {
    const firebaseToken = await idToken();
    const authorize = await call("POST", "/api/cli/authorize", {
      auth: firebaseToken,
      body: { redirect_uri: REDIRECT, code_challenge: deriveChallenge(verifier), code_challenge_method: "S256" },
    });
    const result = await call("POST", "/api/cli/token", {
      body: { code: authorize.body.code, code_verifier: verifier, redirect_uri: REDIRECT },
    });
    expect(JSON.stringify(result.body)).not.toContain(firebaseToken);
  });

  it("rejects a stolen code presented without the verifier", async () => {
    const authorize = await call("POST", "/api/cli/authorize", {
      auth: await idToken(),
      body: { redirect_uri: REDIRECT, code_challenge: deriveChallenge(verifier), code_challenge_method: "S256" },
    });
    const result = await call("POST", "/api/cli/token", {
      body: { code: authorize.body.code, code_verifier: base64url(randomBytes(48)), redirect_uri: REDIRECT },
    });
    expect(result.status).toBe(400);
  });
});

describe("GET /api/cli/me", () => {
  it("returns the bound account for a valid access token", async () => {
    const tokens = await login();
    const result = await call("GET", "/api/cli/me", { auth: tokens.access_token });
    expect(result.status).toBe(200);
    expect(result.body.account.uid).toBe("uid-1");
  });

  it("refuses a Firebase ID token in place of a CLI token", async () => {
    const result = await call("GET", "/api/cli/me", { auth: await idToken() });
    expect(result.status).toBe(401);
  });
});

describe("session registry", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    command: "claude",
    encrypted: true,
  };

  it("registers from the CLI and lists in the web app", async () => {
    const tokens = await login();
    const created = await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    expect(created.status).toBe(201);

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(1);
    expect(listed.body.sessions[0].command).toBe("claude");
  });

  it("refuses registration without a CLI token", async () => {
    const result = await call("POST", "/api/sessions", { body: session });
    expect(result.status).toBe(401);
  });

  it("refuses a revoked CLI token", async () => {
    const tokens = await login();
    await call("POST", "/api/cli/revoke", { body: { refresh_token: tokens.refresh_token } });
    const result = await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    expect(result.status).toBe(401);
  });

  it("does not leak another account's sessions", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });

    const other = await call("GET", "/api/sessions", { auth: await idToken({ sub: "uid-2" }) });
    expect(other.body.sessions).toEqual([]);
  });

  it("closes a session and records the exit code", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const closed = await call("PATCH", `/api/sessions/${session.id}`, {
      auth: tokens.access_token,
      body: { exit_code: 0 },
    });
    expect(closed.status).toBe(200);
    expect(closed.body.session.exitCode).toBe(0);
    expect(closed.body.session.closedAt).toBeTypeOf("number");
  });

  it("rejects a malformed session id", async () => {
    const tokens = await login();
    const result = await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { ...session, id: "bad id" },
    });
    expect(result.status).toBe(400);
  });
});

describe("refresh", () => {
  it("issues a working access token from the refresh token", async () => {
    const tokens = await login();
    const refreshed = await call("POST", "/api/cli/refresh", {
      body: { refresh_token: tokens.refresh_token },
    });
    expect(refreshed.status).toBe(200);
    const me = await call("GET", "/api/cli/me", { auth: refreshed.body.access_token });
    expect(me.status).toBe(200);
  });

  it("refuses an unknown refresh token", async () => {
    const result = await call("POST", "/api/cli/refresh", { body: { refresh_token: "shr_nope" } });
    expect(result.status).toBe(401);
  });
});

describe("cors", () => {
  it("allows the configured web origin", async () => {
    const result = await call("GET", "/api/health", { origin: ORIGIN });
    expect(result.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
  });

  it("does not echo an unlisted origin", async () => {
    const result = await call("GET", "/api/health", { origin: "http://evil.example.com" });
    expect(result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });
});

describe("linked machines", () => {
  it("lists a machine after login, with no secrets in the payload", async () => {
    const tokens = await login();
    const result = await call("GET", "/api/devices", { auth: await idToken() });

    expect(result.status).toBe(200);
    expect(result.body.devices).toHaveLength(1);

    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain(tokens.access_token);
    expect(serialised).not.toContain(tokens.refresh_token);
    /* Hashes are not secrets, but there is no reason to hand them out either. */
    expect(serialised).not.toContain("accessHash");
    expect(serialised).not.toContain("refreshHash");
  });

  it("carries the label the CLI supplied", async () => {
    const authorize = await call("POST", "/api/cli/authorize", {
      auth: await idToken(),
      body: {
        redirect_uri: REDIRECT,
        code_challenge: deriveChallenge(verifier),
        code_challenge_method: "S256",
      },
    });
    await call("POST", "/api/cli/token", {
      body: {
        code: authorize.body.code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        label: "ana-mbp",
      },
    });

    const result = await call("GET", "/api/devices", { auth: await idToken() });
    expect(result.body.devices[0].label).toBe("ana-mbp");
  });

  it("never lists another account's machines", async () => {
    await login();
    const other = await call("GET", "/api/devices", { auth: await idToken({ sub: "uid-2" }) });
    expect(other.body.devices).toEqual([]);
  });

  it("unlinks a machine and kills its token", async () => {
    const tokens = await login();
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    const deviceId = listed.body.devices[0].id;

    const revoked = await call("DELETE", `/api/devices/${deviceId}`, { auth: await idToken() });
    expect(revoked.status).toBe(200);

    /* The point of unlinking: that machine can no longer publish. */
    const publish = await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        command: "claude",
      },
    });
    expect(publish.status).toBe(401);

    const after = await call("GET", "/api/devices", { auth: await idToken() });
    expect(after.body.devices).toEqual([]);
  });

  it("refuses to unlink a machine belonging to another account", async () => {
    await login();
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    const deviceId = listed.body.devices[0].id;

    const attempt = await call("DELETE", `/api/devices/${deviceId}`, {
      auth: await idToken({ sub: "uid-2" }),
    });
    expect(attempt.status).toBe(404);

    const still = await call("GET", "/api/devices", { auth: await idToken() });
    expect(still.body.devices).toHaveLength(1);
  });

  it("refuses without a signed-in user", async () => {
    await login();
    expect((await call("GET", "/api/devices")).status).toBe(401);
    expect((await call("DELETE", "/api/devices/dev_anything")).status).toBe(401);
  });

  it("404s an unknown machine rather than reporting success", async () => {
    await login();
    const result = await call("DELETE", "/api/devices/dev_nope", { auth: await idToken() });
    expect(result.status).toBe(404);
  });
});

describe("driving a machine from the browser", () => {
  async function withDevice() {
    const tokens = await login();
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    /* A start is refused unless an agent is listening, so poll once first. */
    await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    return { tokens, deviceId: listed.body.devices[0].id as string };
  }

  it("queues a start for a machine and hands it to that machine's agent", async () => {
    const { tokens, deviceId } = await withDevice();

    const queued = await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: deviceId, kind: "start", command: "top" },
    });
    expect(queued.status).toBe(202);

    const claimed = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    expect(claimed.body.commands).toHaveLength(1);
    expect(claimed.body.commands[0]).toMatchObject({ kind: "start", command: "top" });
  });

  it("hands a command out only once, so two agents cannot both run it", async () => {
    const { tokens, deviceId } = await withDevice();
    await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: deviceId, kind: "start", command: "top" },
    });

    const first = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const second = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    expect(first.body.commands).toHaveLength(1);
    expect(second.body.commands).toEqual([]);
  });

  it("refuses a machine that is not yours", async () => {
    const { deviceId } = await withDevice();
    const result = await call("POST", "/api/commands", {
      auth: await idToken({ sub: "uid-2" }),
      body: { device_id: deviceId, kind: "start", command: "top" },
    });
    expect(result.status).toBe(404);
  });

  it("refuses an empty or oversized command", async () => {
    const { deviceId } = await withDevice();
    for (const command of ["", "   ", "x".repeat(501)]) {
      const result = await call("POST", "/api/commands", {
        auth: await idToken(),
        body: { device_id: deviceId, kind: "start", command },
      });
      expect(result.status).toBe(400);
    }
  });

  it("will not queue a kill for another account's session", async () => {
    const { tokens, deviceId } = await withDevice();
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        command: "top",
      },
    });

    const result = await call("POST", "/api/commands", {
      auth: await idToken({ sub: "uid-2" }),
      body: {
        device_id: deviceId,
        kind: "kill",
        session_id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
      },
    });
    expect(result.status).toBe(404);
  });

  it("rejects an unknown command kind", async () => {
    const { deviceId } = await withDevice();
    const result = await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: deviceId, kind: "rm -rf" },
    });
    expect(result.status).toBe(400);
  });

  it("accepts a completion report from the machine that claimed it", async () => {
    const { tokens, deviceId } = await withDevice();
    await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: deviceId, kind: "start", command: "top" },
    });
    const claimed = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const id = claimed.body.commands[0].id;

    const done = await call("POST", `/api/agent/commands/${id}`, {
      auth: tokens.access_token,
      body: {},
    });
    expect(done.status).toBe(200);

    /* Reporting twice is not an error the agent should have to reason about. */
    const again = await call("POST", `/api/agent/commands/${id}`, {
      auth: tokens.access_token,
      body: {},
    });
    expect(again.status).toBe(404);
  });

  it("refuses agent routes without a machine token", async () => {
    await withDevice();
    expect((await call("GET", "/api/agent/commands")).status).toBe(401);
    expect((await call("POST", "/api/agent/commands/cmd_x", { body: {} })).status).toBe(401);
  });
});

describe("starting on a machine with no agent", () => {
  async function deviceWithoutAgent() {
    await login();
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    return listed.body.devices[0].id as string;
  }

  it("refuses, and names the command that fixes it", async () => {
    /*
     * Queuing for a machine with nothing listening used to sit there silently
     * forever, which is a worse answer than saying so at the point of asking.
     */
    const deviceId = await deviceWithoutAgent();
    const result = await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: deviceId, kind: "start", command: "top" },
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("shell agent");
  });

  it("accepts once the agent has polled", async () => {
    const tokens = await login();
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    const deviceId = listed.body.devices[0].id;

    /* Polling for work is what marks a machine as listening. */
    await call("GET", "/api/agent/commands", { auth: tokens.access_token });

    const result = await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: deviceId, kind: "start", command: "top" },
    });
    expect(result.status).toBe(202);
  });

  it("reports agent liveness on the machine, distinct from any other use", async () => {
    const tokens = await login();
    const before = await call("GET", "/api/devices", { auth: await idToken() });
    expect(before.body.devices[0].agentSeenAt).toBeUndefined();

    /* Registering a session is use, but it is not an agent listening. */
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        command: "top",
      },
    });
    const afterUse = await call("GET", "/api/devices", { auth: await idToken() });
    expect(afterUse.body.devices[0].agentSeenAt).toBeUndefined();

    await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const afterPoll = await call("GET", "/api/devices", { auth: await idToken() });
    expect(afterPoll.body.devices[0].agentSeenAt).toBeTypeOf("number");
  });
});

describe("relaying a sealed password", () => {
  it("passes the envelope to the agent without being able to read it", async () => {
    const tokens = await login();
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    const deviceId = listed.body.devices[0].id;
    await call("GET", "/api/agent/commands", { auth: tokens.access_token });

    await call("POST", "/api/commands", {
      auth: await idToken(),
      body: {
        device_id: deviceId,
        kind: "start",
        command: "cat",
        sender_public_key: "BASE64_SENDER_KEY",
        sealed_password: "BASE64_SEALED_ENVELOPE",
      },
    });

    const claimed = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    expect(claimed.body.commands[0]).toMatchObject({
      senderPublicKey: "BASE64_SENDER_KEY",
      sealedPassword: "BASE64_SEALED_ENVELOPE",
    });
  });

  it("records the agent's published key so a browser can seal to it", async () => {
    const tokens = await login();
    await call("GET", "/api/agent/commands?key=AGENT_PUBLIC_KEY", {
      auth: tokens.access_token,
    });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    expect(listed.body.devices[0].agentPublicKey).toBe("AGENT_PUBLIC_KEY");
  });

  it("takes a new key when the agent restarts", async () => {
    const tokens = await login();
    await call("GET", "/api/agent/commands?key=FIRST", { auth: tokens.access_token });
    await call("GET", "/api/agent/commands?key=SECOND", { auth: tokens.access_token });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    expect(listed.body.devices[0].agentPublicKey).toBe("SECOND");
  });

  it("ties a session back to the request that started it", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        command: "cat",
        origin: "cmd_abc",
      },
    });
    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    /* This is how the browser recognises the session it started. */
    expect(listed.body.sessions[0].origin).toBe("cmd_abc");
  });
});
