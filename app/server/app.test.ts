import { beforeEach, describe, expect, it, beforeAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type KeyObject } from "jose";
import { createApp } from "./app";
import { MemoryStore } from "./lib/store-memory";
import { deferred } from "./lib/store-deferred";
import type { Store } from "./lib/store";
import { createVerifier, localKeySet } from "./lib/firebase-token";
import { base64url, deriveChallenge } from "./lib/pkce";
import { createVault, sealToAccount } from "../src/lib/vault-crypto";

const PROJECT = "test-firebase-project";
const REDIRECT = "http://127.0.0.1:51234/callback";
const ORIGIN = "http://localhost:5173";
const P256_PUBLIC_KEY_A = "BDxrse1_E7EAHDreFfDYFkHs7kcn3d2n_BqKorrlu6H-9FarvjSDUCUSY3EOYKRBJusTV2E2GwRZLdplZc3UbQY";
const P256_PUBLIC_KEY_B = "BM4rJdocNKu-sk24tVjh1QKxfdLJN43q2NVO3NElj_H09ORvqFD6ZcX7xJ_DTef8pYUGo0AJz9bnFV8oxvkBElc";
const SESSION_SHARE_A = base64url(Buffer.alloc(40, 0x41));
const SESSION_SHARE_B = base64url(Buffer.alloc(40, 0x42));

let privateKey: KeyObject;
let verifyIdToken: (token: string) => Promise<{ ok: boolean }>;
let store: Store;
let handle: ReturnType<typeof createApp>;
let verifier: string;

/* Signs a token that looks exactly like a Firebase ID token, minus Google. */
async function idToken(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: "ana@example.com", name: "Ana Ferreira", email_verified: true, ...overrides })
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
  options: { body?: unknown; auth?: string; origin?: string; address?: string } = {},
  target: typeof handle = handle,
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
    socket: { remoteAddress: options.address ?? "10.0.0.1" },
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
  await target(request as any, response as any);
  return { status, headers, body: payload ? JSON.parse(payload) : null };
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as KeyObject;
  const jwk = await exportJWK(pair.publicKey);
  verifyIdToken = createVerifier(PROJECT, localKeySet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] })) as never;
});

beforeEach(async () => {
  /* Deferred, so a write the routes forget to await fails here. */
  store = deferred(MemoryStore.memory());
  verifier = base64url(randomBytes(48));
  handle = createApp({ store, verifyIdToken: verifyIdToken as never, allowedOrigins: [ORIGIN] });
});

/*
 * Walks the whole login handshake and returns the CLI's tokens. `extra` goes
 * into the token request, which is where a real CLI names its machine.
 */
async function login(extra: Record<string, unknown> = {}, subject = "uid-1") {
  const authorize = await call("POST", "/api/cli/authorize", {
    auth: await idToken({ sub: subject }),
    body: {
      redirect_uri: REDIRECT,
      code_challenge: deriveChallenge(verifier),
      code_challenge_method: "S256",
    },
  });
  const token = await call("POST", "/api/cli/token", {
    body: { code: authorize.body.code, code_verifier: verifier, redirect_uri: REDIRECT, ...extra },
  });
  return token.body as { access_token: string; refresh_token: string };
}

/* The machines this account has linked, newest first. */
async function devices(subject = "uid-1") {
  const result = await call("GET", "/api/devices", { auth: await idToken({ sub: subject }) });
  return result.body.devices as { id: string; label: string; createdAt: number }[];
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

describe("owner MCP flow feed", () => {
  const id = "flow_session_123";
  const path = `/api/cli/sessions/${id}/mcp-flows`;
  const event = () => ({ id: "00000000-0000-4000-8000-000000000001", tool: "shell_wait", phase: "settled", outcome: "timeout", at: Date.now() });
  async function setup() {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: { id, share_url: `https://shell.online/s/${id}`, command: "private command", encrypted: true } });
    return tokens;
  }

  it("requires authentication and originating machine, then returns no-store metadata only", async () => {
    const tokens = await setup();
    const report = { events: [event()] };
    expect((await call("POST", path, { body: report })).status).toBe(401);
    expect((await call("GET", "/api/game/mcp-flows")).status).toBe(401);
    expect((await call("POST", path, { auth: await idToken(), body: report })).status).toBe(401);
    const second = await login({ label: "other machine" });
    expect((await call("POST", path, { auth: second.access_token, body: report })).status).toBe(404);
    expect((await call("POST", path, { auth: tokens.access_token, body: report })).status).toBe(200);
    const result = await call("GET", "/api/game/mcp-flows", { auth: await idToken() });
    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(result.body).toEqual({ flows: [{ ...report.events[0], targetSessionId: id }] });
    expect(JSON.stringify(result.body)).not.toContain("private command");
    expect((await call("GET", "/api/game/mcp-flows", { auth: await idToken({ sub: "uid-2" }) })).body).toEqual({ flows: [] });
  });

  it("rejects plaintext, extra fields, stale clocks and oversized batches", async () => {
    const tokens = await setup();
    for (const body of [
      { events: [{ ...event(), content: "private" }] },
      { events: [event()], source: "fake" },
      { events: [{ ...event(), at: Date.now() + 60_000 }] },
      { events: [{ ...event(), at: Date.now() - 120_001 }] },
      { events: Array(33).fill(event()) },
      { events: [{ ...event(), outcome: undefined }] },
      { events: [event(), event()] },
    ]) expect((await call("POST", path, { auth: tokens.access_token, body })).status).toBe(400);
    expect((await call("GET", "/api/game/mcp-flows", { auth: await idToken() })).body).toEqual({ flows: [] });
  });

  it("pairs started and settled under one id and dedupes a retried batch", async () => {
    const tokens = await setup();
    const started = { id: "00000000-0000-4000-8000-000000000002", tool: "shell_send", phase: "started", at: Date.now() - 1000 };
    const settled = { ...started, phase: "settled", outcome: "delivered" };
    const batch = { events: [started, settled] };
    expect((await call("POST", path, { auth: tokens.access_token, body: batch })).status).toBe(200);
    expect((await call("POST", path, { auth: tokens.access_token, body: batch })).status).toBe(200);
    const result = await call("GET", "/api/game/mcp-flows", { auth: await idToken() });
    expect(result.body).toEqual({ flows: [{ ...started, targetSessionId: id }, { ...settled, targetSessionId: id }] });
  });

  it("serves a flow reported to one instance from another instance on the same store", async () => {
    const tokens = await setup();
    const report = { events: [event()] };
    expect((await call("POST", path, { auth: tokens.access_token, body: report })).status).toBe(200);
    /*
     * The production shape: the Worker builds one router per isolate, and the
     * host's report and the game's read land on different isolates. A
     * per-instance buffer loses the flow; the store is what the instances
     * share, so the second one must serve what the first was told.
     */
    const otherInstance = createApp({ store, verifyIdToken: verifyIdToken as never, allowedOrigins: [ORIGIN] });
    const result = await call("GET", "/api/game/mcp-flows", { auth: await idToken() }, otherInstance);
    expect(result.body).toEqual({ flows: [{ ...report.events[0], targetSessionId: id }] });
    /* And the reverse direction: reported to the other instance, read here. */
    const second = { events: [{ id: "00000000-0000-4000-8000-000000000099", tool: "shell_wait", phase: "settled", outcome: "timeout", at: Date.now() }] };
    expect((await call("POST", path, { auth: tokens.access_token, body: second }, otherInstance)).status).toBe(200);
    expect((await call("GET", "/api/game/mcp-flows", { auth: await idToken() })).body.flows).toHaveLength(2);
  });

  it("rechecks closing, deletion and device revocation before serving flows", async () => {
    const tokens = await setup();
    const owner = await idToken();
    await call("POST", path, { auth: tokens.access_token, body: { events: [event()] } });
    await call("PATCH", `/api/sessions/${id}`, { auth: tokens.access_token, body: { exit_code: 0 } });
    expect((await call("GET", "/api/game/mcp-flows", { auth: owner })).body).toEqual({ flows: [] });
    expect((await call("POST", path, { auth: tokens.access_token, body: { events: [event()] } })).status).toBe(404);
    await store.patchSession("uid-1", id, { closedAt: undefined });
    await call("POST", path, { auth: tokens.access_token, body: { events: [event()] } });
    const membership = (await store.membershipOf("uid-1"))!;
    await store.deleteSession(membership.orgId, id);
    expect((await call("GET", "/api/game/mcp-flows", { auth: owner })).body).toEqual({ flows: [] });
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: { id, share_url: `https://shell.online/s/${id}`, command: "private", encrypted: true } });
    await call("POST", path, { auth: tokens.access_token, body: { events: [event()] } });
    const machine = (await devices())[0];
    await store.revokeDevice("uid-1", machine.id);
    expect((await call("GET", "/api/game/mcp-flows", { auth: owner })).body).toEqual({ flows: [] });
  });
});

describe("team MCP grant requests", () => {
  const id = "team_session_123";
  const grantId = "AbCdEf0123456789_-AbCQ";
  const bearer = "eyJhbGciOiJFQ0RILUVTIn0.eyJlbmMiOiJBMjU2R0NNIn0.abc-def_ghi.j9LQyZ8-S_9r_E.abc123";
  const report = () => ({ grantId, expiresAt: Date.now() + 3600_000, bearer });

  /* Owner's machine + session, consent on, and one invited teammate. */
  async function setup(role: "member" | "admin" = "member") {
    const tokens = await login();
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { id, share_url: `https://shell.online/s/${id}`, command: "claude", encrypted: true },
    });
    await call("PUT", `/api/cli/sessions/${id}/automation`, {
      auth: tokens.access_token,
      body: { mcpTeamAccess: true },
    });
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: { role } });
    const teammate = await idToken({ sub: "uid-2", email: "teammate@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: teammate });
    return { tokens, teammate };
  }

  it("serves the full authorized flow: request, host issue, fetch", async () => {
    const { tokens, teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    expect(ask.status).toBe(201);
    expect(ask.body.requestId).toMatch(/^mcp_[a-f0-9]{32}$/);
    expect(ask.body.expiresAt).toBeGreaterThan(Date.now());

    /* Pending until the machine answers. */
    const pending = await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate });
    expect(pending.status).toBe(202);
    expect(pending.body).toEqual({ status: "pending", expiresAt: ask.body.expiresAt });

    const work = await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: tokens.access_token });
    expect(work.status).toBe(200);
    expect(work.body).toEqual({
      issues: [{ requestId: ask.body.requestId, requesterUid: "uid-2", action: "issue", expiresAt: ask.body.expiresAt }],
      revocations: [],
    });

    const issued = await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: report(),
    });
    expect(issued.status).toBe(200);
    expect(issued.body).toEqual({ result: "stored" });

    const got = await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate });
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("issued");
    expect(got.body.grantId).toBe(grantId);
    expect(got.body.bearer).not.toContain(bearer);
    expect(JSON.parse(got.body.bearer).s).toMatch(/^v2\./);
    expect(got.body.sealedToRecipient).toBe(true);
    expect(got.body.expiresAt).toBeGreaterThan(Date.now());
    /* The credential leaves exactly once; a lost fetch is recovered by asking again. */
    const again = await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate });
    expect(again.status).toBe(410);
    expect(again.body.error).toBe("this request was already delivered");
  });

  it("requires a valid immutable recipient key before creating a request", async () => {
    const { teammate } = await setup();
    for (const body of [{}, { recipientPublicKey: "bad-key" }, { recipientPublicKey: P256_PUBLIC_KEY_A, replace: true }]) {
      const response = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body });
      expect(response.status).toBe(400);
    }
    const asked = await call("POST", `/api/sessions/${id}/mcp/team`, {
      auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A },
    });
    expect(asked.status).toBe(201);
    const replaced = await call("PUT", `/api/sessions/${id}/mcp/team/${asked.body.requestId}`, {
      auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_B },
    });
    expect(replaced.status).toBe(405);
  });

  it("lets the same teammate ask over the CLI with their own account", async () => {
    const { teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    expect(ask.status).toBe(201);
    const cli = await login({}, "uid-2");
    const viaCli = await call("GET", `/api/cli/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: cli.access_token });
    expect(viaCli.status).toBe(202);
    expect(viaCli.body.status).toBe("pending");
    /* The machine cannot fetch a teammate's request: it is not theirs. */
    const foreign = await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: await idToken() });
    expect(foreign.status).toBe(404);
  });

  it("refuses while the consent is off, even though the session is listed", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { id, share_url: `https://shell.online/s/${id}`, command: "claude", encrypted: true },
    });
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: { role: "member" } });
    const teammate = await idToken({ sub: "uid-2", email: "teammate@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: teammate });
    /* Listing works... */
    expect((await call("GET", "/api/sessions", { auth: teammate })).body.sessions).toHaveLength(1);
    /* ...but a listing is not a connection. */
    expect((await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(403);
  });

  it("refuses another organization, a closed session, and unknown sessions", async () => {
    const { tokens, teammate } = await setup();
    const stranger = await idToken({ sub: "uid-9", email: "stranger@elsewhere.com" });
    expect((await call("POST", `/api/sessions/${id}/mcp/team`, { auth: stranger, body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(404);
    expect((await call("POST", `/api/sessions/${id}/mcp/team`, { auth: await idToken(), body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(201);
    expect((await call("POST", `/api/sessions/nope_session_999/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(404);
    await call("PATCH", `/api/sessions/${id}`, { auth: tokens.access_token, body: { exit_code: 0 } });
    expect((await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(404);
  });

  it("lets an admin ask, and the owner ask for their own session", async () => {
    const { teammate } = await setup("admin");
    expect((await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(201);
    expect((await call("POST", `/api/sessions/${id}/mcp/team`, { auth: await idToken(), body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(201);
  });

  it("bounds pending requests per session", async () => {
    const { teammate } = await setup();
    for (let i = 0; i < 4; i += 1) {
      expect((await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } })).status).toBe(201);
    }
    const limited = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("too many pending team MCP requests");
  });

  it("keeps the host's work list to the session's own machine", async () => {
    const { tokens, teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    const otherMachine = await login({ label: "other machine" });
    expect((await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: otherMachine.access_token })).status).toBe(403);
    const teammateCli = await login({}, "uid-2");
    expect((await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: teammateCli.access_token })).status).toBe(404);
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: teammateCli.access_token,
      body: report(),
    })).status).toBe(404);
    /* Unauthenticated and unparseable reports are refused before the store. */
    expect((await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`)).status).toBe(401);
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: { grantId: "short", expiresAt: Date.now() + 3600_000, bearer },
    })).status).toBe(400);
  });

  it("revokes live requests when the consent turns off, and the machine acks", async () => {
    const { tokens, teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: report(),
    });
    /* A pending request dies with the consent too. */
    const pending = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    await call("PUT", `/api/cli/sessions/${id}/automation`, {
      auth: tokens.access_token,
      body: { mcpTeamAccess: false },
    });
    expect((await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate })).status).toBe(410);
    expect((await call("GET", `/api/sessions/${id}/mcp/team/${pending.body.requestId}`, { auth: teammate })).status).toBe(410);
    const work = await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: tokens.access_token });
    expect(work.body.issues).toEqual([]);
    expect(work.body.revocations).toEqual([{ requestId: ask.body.requestId, requesterUid: "uid-2", action: "revoke", grantId }]);
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/revoke-ack`, {
      auth: tokens.access_token,
    })).status).toBe(200);
    expect((await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: tokens.access_token })).body.revocations).toEqual([]);
    /* A second ack finds nothing: the record is gone, and that is fine. */
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/revoke-ack`, {
      auth: tokens.access_token,
    })).status).toBe(404);
  });

  it("revokes a member's live requests when they leave the organization", async () => {
    const { tokens, teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: report(),
    });
    expect((await call("DELETE", "/api/org/members/uid-2", { auth: await idToken() })).status).toBe(200);
    /* Their next call starts a fresh organization of one: the session is not in it. */
    expect((await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate })).status).toBe(404);
    const work = await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: tokens.access_token });
    expect(work.body.revocations).toEqual([{ requestId: ask.body.requestId, requesterUid: "uid-2", action: "revoke", grantId }]);
  });

  it("revokes a session's requests when the session is deleted", async () => {
    const { tokens, teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: report(),
    });
    const membership = (await store.membershipOf("uid-1"))!;
    await store.deleteSession(membership.orgId, id);
    const work = await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: tokens.access_token });
    expect(work.status).toBe(404);
    /* The revocation is still answerable once the session is back. */
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { id, share_url: `https://shell.online/s/${id}`, command: "claude", encrypted: true },
    });
    const again = await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: tokens.access_token });
    expect(again.body.revocations).toEqual([{ requestId: ask.body.requestId, requesterUid: "uid-2", action: "revoke", grantId }]);
  });

  it("treats a retried grant report as idempotent and a foreign one as a no-op upgrade", async () => {
    const { tokens, teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    const first = report();
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: first,
    })).status).toBe(200);
    /* The same report again: stored, and the first grant still stands. */
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: first,
    })).status).toBe(200);
    const got = await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate });
    expect(got.body.bearer).not.toContain(bearer);
    /* A re-minted grant is accepted as a report, but the row stays issued with
     * the first grant -- and the credential, already delivered, is not served twice. */
    const second = { ...report(), grantId: "ZYXwvu0123456789_-ZyxQ" };
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: second,
    })).status).toBe(200);
    const delivered = await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate });
    expect(delivered.status).toBe(410);
    /* A report for a request that was never made is a miss. */
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/mcp_deadbeefdeadbeefdeadbeefdeadbeef/grant`, {
      auth: tokens.access_token,
      body: report(),
    })).status).toBe(404);
  });

  it("serves a request made on one instance from the host on another", async () => {
    const { tokens, teammate } = await setup();
    const ask = await call("POST", `/api/sessions/${id}/mcp/team`, { auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A } });
    const otherInstance = createApp({ store, verifyIdToken: verifyIdToken as never, allowedOrigins: [ORIGIN] });
    const work = await call("GET", `/api/cli/sessions/${id}/mcp/team-requests`, { auth: tokens.access_token }, otherInstance);
    expect(work.body.issues).toHaveLength(1);
    expect((await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${ask.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: report(),
    }, otherInstance)).status).toBe(200);
    expect((await call("GET", `/api/sessions/${id}/mcp/team/${ask.body.requestId}`, { auth: teammate })).status).toBe(200);
  });
});

describe("internal team-authorized check (live use-time authorization)", () => {
  const id = "authz_session_123";
  const grantId = "AbCdEf0123456789_-AbCQ";
  const TOKEN = "team-check-".padEnd(40, "0");
  const path = (session: string, requester: string) =>
    `/api/internal/mcp/team-authorized?session=${encodeURIComponent(session)}&requester=${encodeURIComponent(requester)}&grant=${grantId}`;

  /* An app instance the DO can talk to, plus the owner's session with consent on and one teammate. */
  async function setup() {
    const teamApp = createApp({ store, verifyIdToken: verifyIdToken as never, allowedOrigins: [ORIGIN], mcpTeamCheckToken: TOKEN });
    const tokens = await login();
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { id, share_url: `https://shell.online/s/${id}`, command: "claude", encrypted: true },
    });
    await call("PUT", `/api/cli/sessions/${id}/automation`, { auth: tokens.access_token, body: { mcpTeamAccess: true } });
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: { role: "member" } });
    const teammate = await idToken({ sub: "uid-2", email: "teammate@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: teammate });
    const asked = await call("POST", `/api/sessions/${id}/mcp/team`, {
      auth: teammate, body: { recipientPublicKey: P256_PUBLIC_KEY_A },
    });
    await call("POST", `/api/cli/sessions/${id}/mcp/team-requests/${asked.body.requestId}/grant`, {
      auth: tokens.access_token,
      body: { grantId, expiresAt: Date.now() + 3600_000, bearer: "a..b.c.d" },
    });
    return { teamApp, tokens, teammate };
  }

  it("does not exist when the token is not configured", async () => {
    await setup();
    const answer = await call("GET", path(id, "uid-2"), { auth: TOKEN });
    expect(answer.status).toBe(404);
  });

  it("refuses the wrong or missing token before it answers", async () => {
    const { teamApp } = await setup();
    expect((await call("GET", path(id, "uid-2"), { auth: "wrong".padEnd(40, "0") }, teamApp)).status).toBe(401);
    expect((await call("GET", path(id, "uid-2"), {}, teamApp)).status).toBe(401);
  });

  it("refuses a question that names no session or requester", async () => {
    const { teamApp } = await setup();
    expect((await call("GET", "/api/internal/mcp/team-authorized?session=" + id, { auth: TOKEN }, teamApp)).status).toBe(400);
    expect((await call("GET", "/api/internal/mcp/team-authorized?requester=uid-2", { auth: TOKEN }, teamApp)).status).toBe(400);
  });

  it("answers yes for a member while the session is open and consenting", async () => {
    const { teamApp } = await setup();
    const answer = await call("GET", path(id, "uid-2"), { auth: TOKEN }, teamApp);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ authorized: true });
  });

  it("answers no the moment the consent turns off", async () => {
    const { teamApp, tokens } = await setup();
    expect((await call("GET", path(id, "uid-2"), { auth: TOKEN }, teamApp)).body).toEqual({ authorized: true });
    await call("PUT", `/api/cli/sessions/${id}/automation`, { auth: tokens.access_token, body: { mcpTeamAccess: false } });
    expect((await call("GET", path(id, "uid-2"), { auth: TOKEN }, teamApp)).body).toEqual({ authorized: false });
  });

  it("answers no when the member leaves, even though the host has not polled", async () => {
    const { teamApp } = await setup();
    expect((await call("GET", path(id, "uid-2"), { auth: TOKEN }, teamApp)).body).toEqual({ authorized: true });
    await call("DELETE", "/api/org/members/uid-2", { auth: await idToken() });
    expect((await call("GET", path(id, "uid-2"), { auth: TOKEN }, teamApp)).body).toEqual({ authorized: false });
  });

  it("answers no for a closed session, an unknown session, and a non-member", async () => {
    const { teamApp, tokens } = await setup();
    await call("PATCH", `/api/sessions/${id}`, { auth: tokens.access_token, body: { exit_code: 0 } });
    expect((await call("GET", path(id, "uid-2"), { auth: TOKEN }, teamApp)).body).toEqual({ authorized: false });
    expect((await call("GET", path("nope_session_999", "uid-2"), { auth: TOKEN }, teamApp)).body).toEqual({ authorized: false });
    /* uid-9 never joined the organization: no membership row, no access. */
    expect((await call("GET", path(id, "uid-9"), { auth: TOKEN }, teamApp)).body).toEqual({ authorized: false });
  });
});

describe("session registry", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    command: "claude",
    encrypted: true,
  };

  it("publishes bounded owner-only content without exposing it in session lists", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const path = `/api/cli/sessions/${session.id}`;
    const disabled = await call("GET", `${path}/content-policy`, { auth: tokens.access_token });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    await call("PUT", `${path}/automation`, { auth: tokens.access_token, body: { dailyBriefingEnabled: true } });
    const policy = await call("GET", `${path}/content-policy`, { auth: tokens.access_token });
    const body = { generation: policy.body.generation, observedAt: 1000, senderPublicKey: P256_PUBLIC_KEY_A, sealed: `sc1.${SESSION_SHARE_A}` };
    expect((await call("PUT", `${path}/content`, { auth: tokens.access_token, body })).status).toBe(200);
    expect((await call("PUT", `${path}/content`, { auth: tokens.access_token, body })).status).toBe(200);
    expect((await call("PUT", `${path}/content`, { auth: tokens.access_token, body: { ...body, observedAt: 1001 } })).status).toBe(429);
    expect((await call("GET", `/api/sessions/${session.id}/content`, { auth: await idToken() })).body).toEqual(body);
    expect(JSON.stringify((await call("GET", "/api/sessions", { auth: await idToken() })).body)).not.toContain(body.sealed);
    expect((await call("PUT", `${path}/content`, { auth: tokens.access_token, body: { ...body, sealed: `sc1.${base64url(Buffer.alloc(16 * 1024 + 1))}` } })).status).toBe(400);
    expect((await call("PUT", `${path}/content`, { auth: tokens.access_token, body: { ...body, sealed: `v2.${SESSION_SHARE_A}` } })).status).toBe(400);
    expect((await call("PUT", `${path}/content`, { auth: tokens.access_token, body: { ...body, title: "plaintext" } })).status).toBe(400);
    const otherMachine = await login({ label: "another machine" });
    expect((await call("GET", `${path}/content-policy`, { auth: otherMachine.access_token })).status).toBe(404);
    await call("PUT", `${path}/automation`, { auth: tokens.access_token, body: { dailyBriefingEnabled: false } });
    expect((await call("GET", `/api/sessions/${session.id}/content`, { auth: await idToken() })).status).toBe(404);
    await call("PUT", `${path}/automation`, { auth: tokens.access_token, body: { dailyBriefingEnabled: true } });
    expect((await call("PUT", `${path}/content`, { auth: tokens.access_token, body })).status).toBe(409);
  });

  it("registers from the CLI and lists in the web app", async () => {
    const tokens = await login();
    const created = await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    expect(created.status).toBe(201);
    /* Counted for the dashboard: the login linked a machine, the registration a session. */
    expect(await store.appEvents(0)).toEqual([{ event: "machine_linked", count: 1 }, { event: "session_registered", count: 1 }]);

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(1);
    expect(listed.body.sessions[0].command).toBe("claude");
    /* The list now carries who else is in the organization. */
    expect(listed.body.members).toHaveLength(1);
    expect(listed.body.you.role).toBe("owner");
  });

  it("projects the relay's authoritative state into session lists and details", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const one = vi.fn(async () => ({ relayStatus: "disconnected" as const, relayCheckedAt: 123 }));
    const many = vi.fn(async () => new Map([
      [session.id, { relayStatus: "disconnected" as const, relayCheckedAt: 123 }],
    ]));
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      sessionLiveness: { one, many },
    });

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });

    expect(listed.body.sessions[0]).toMatchObject({ relayStatus: "disconnected", relayCheckedAt: 123 });
    expect(detail.body.session).toMatchObject({ relayStatus: "disconnected", relayCheckedAt: 123 });
    expect(many).toHaveBeenCalledTimes(1);
    expect(one).toHaveBeenCalledWith(session.id);
  });

  /*
   * The reboot and power-cut case: the machine never got to PATCH the session,
   * so nothing ever closed the row and the browser went on offering it. Once
   * the relay has given up on the session there is nothing left to come back,
   * and the service writes the end down itself.
   */
  it("closes a session the relay no longer has", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const state = { relayStatus: "missing" as const, relayCheckedAt: 5_000, hostLastSeenAt: 4_000 };
    const many = vi.fn(async () => new Map([[session.id, state]]));
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      sessionLiveness: { one: vi.fn(async () => state), many },
    });

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });

    /* Answered as finished straight away, not only on the next poll. */
    expect(listed.body.sessions[0].closedAt).toBe(4_000);
    expect(listed.body.sessions[0].relayStatus).toBeUndefined();
    /* And written down, so it is not asked about again. */
    expect((await store.sessionInOrg(listed.body.you.orgId, session.id))?.closedAt).toBe(4_000);
  });

  it("leaves a machine that is merely away open to reconnecting", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const state = { relayStatus: "disconnected" as const, relayCheckedAt: 5_000, hostLastSeenAt: 4_000 };
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      sessionLiveness: { one: vi.fn(async () => state), many: vi.fn(async () => new Map([[session.id, state]])) },
    });

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });

    expect(listed.body.sessions[0].closedAt).toBeUndefined();
    /* The browser decides when this has gone on too long; see hostGone. */
    expect(listed.body.sessions[0]).toMatchObject({ relayStatus: "disconnected", hostLastSeenAt: 4_000 });
  });

  it("does not query relay liveness after the CLI has reported an exit", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    await call("PATCH", `/api/sessions/${session.id}`, {
      auth: tokens.access_token,
      body: { exit_code: 0 },
    });
    const one = vi.fn();
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      sessionLiveness: { one, many: vi.fn(async () => new Map()) },
    });

    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });

    expect(detail.body.session.closedAt).toEqual(expect.any(Number));
    expect(detail.body.session.relayStatus).toBeUndefined();
    expect(one).not.toHaveBeenCalled();
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

    /* A different account is a different organization, so it sees nothing. */
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

describe("GET /api/cli/sessions", () => {
  const mine = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t#salt=AAAAAAAAAAAAAAAAAAAAAA",
    command: "npm run dev",
    name: "web app",
    host: "ana-mbp",
    encrypted: true,
  };

  it("lists every session this account published, with its name", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: mine });
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { ...mine, id: "Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4", name: undefined, command: "htop" },
    });
    await call("PATCH", `/api/sessions/Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4`, {
      auth: tokens.access_token,
      body: { exit_code: 0 },
    });

    const listed = await call("GET", "/api/cli/sessions", { auth: tokens.access_token });
    expect(listed.status).toBe(200);
    const byId = Object.fromEntries(
      (listed.body.sessions as { id: string; closedAt?: number }[]).map((entry) => [entry.id, entry]),
    );
    expect(byId[mine.id]).toMatchObject({ name: "web app", command: "npm run dev", host: "ana-mbp" });
    expect(byId.Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4).toMatchObject({ command: "htop", exitCode: 0 });
    expect(byId.Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4.closedAt).toBeTypeOf("number");
    expect(JSON.stringify(listed.body)).not.toContain("keyShares");
  });

  it("does not list another account's sessions", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: mine });
    const other = await login({}, "uid-2");
    const listed = await call("GET", "/api/cli/sessions", { auth: other.access_token });
    expect(listed.body.sessions).toEqual([]);
  });

  it("hands back the newest sessions only, so a long-lived account still gets a reply", async () => {
    const tokens = await login();
    const { orgId } = (await call("GET", "/api/team-key", { auth: await idToken() })).body.you;
    for (let index = 0; index < 505; index += 1) {
      await store.upsertSession({
        id: `s${String(index).padStart(30, "0")}`,
        uid: "uid-1",
        orgId,
        ownerUid: "uid-1",
        shareUrl: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
        command: "htop",
        readOnly: false,
        encrypted: true,
        persistent: false,
        host: "ana-mbp",
        startedAt: 1000 + index,
      });
    }
    const listed = await call("GET", "/api/cli/sessions", { auth: tokens.access_token });
    expect(listed.body.sessions).toHaveLength(500);
    /* Newest first, so the ones cut are the oldest. */
    expect(listed.body.sessions[0].startedAt).toBe(1504);
  });

  it("needs a machine token, not a browser sign-in", async () => {
    expect((await call("GET", "/api/cli/sessions")).status).toBe(401);
    expect((await call("GET", "/api/cli/sessions", { auth: await idToken() })).status).toBe(401);
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

describe("signing in again on the same machine", () => {
  /*
   * The reason any of this exists: `shell auth` run three times on one laptop
   * used to leave three identical entries in the device list.
   */
  it("updates the machine's entry instead of adding another", async () => {
    const first = await login({ machine_id: "machine-a", label: "laptop" });
    const before = await devices();
    const second = await login({ machine_id: "machine-a", label: "laptop-renamed" });
    const after = await devices();

    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].createdAt).toBe(before[0].createdAt);
    expect(after[0].label).toBe("laptop-renamed");
    expect(second.refresh_token).not.toBe(first.refresh_token);
  });

  it("hands out working credentials and retires the ones it replaced", async () => {
    const first = await login({ machine_id: "machine-a" });
    const second = await login({ machine_id: "machine-a" });

    expect((await call("GET", "/api/cli/me", { auth: second.access_token })).status).toBe(200);
    const renewed = await call("POST", "/api/cli/refresh", {
      body: { refresh_token: second.refresh_token },
    });
    expect(renewed.status).toBe(200);

    /* A copy of the earlier credentials is no longer a way into the account. */
    const stale = await call("POST", "/api/cli/refresh", {
      body: { refresh_token: first.refresh_token },
    });
    expect(stale.status).toBe(401);
    expect((await call("GET", "/api/cli/me", { auth: first.access_token })).status).toBe(401);
  });

  it("keeps two machines apart", async () => {
    await login({ machine_id: "machine-a" });
    await login({ machine_id: "machine-b" });
    expect(await devices()).toHaveLength(2);
  });

  it("records a machine per login when the CLI names none", async () => {
    await login();
    await login();
    expect(await devices()).toHaveLength(2);
  });

  it("treats an unusable machine id as none rather than refusing the login", async () => {
    const first = await login({ machine_id: "not a machine id" });
    expect(first.access_token).toMatch(/^sha_/);
    await login({ machine_id: "not a machine id" });
    expect(await devices()).toHaveLength(2);
  });

  it("never lets one account's machine id reach another's device", async () => {
    await login({ machine_id: "machine-a" });
    await login({ machine_id: "machine-a" }, "uid-2");
    expect(await devices()).toHaveLength(1);
    expect(await devices("uid-2")).toHaveLength(1);
    expect((await devices())[0].id).not.toBe((await devices("uid-2"))[0].id);
  });

  it("gives an unlinked machine a new entry rather than reviving the old one", async () => {
    await login({ machine_id: "machine-a" });
    const [linked] = await devices();
    const removed = await call("DELETE", `/api/devices/${linked.id}`, { auth: await idToken() });
    expect(removed.status).toBe(200);

    await login({ machine_id: "machine-a" });
    const relinked = await devices();
    expect(relinked).toHaveLength(1);
    expect(relinked[0].id).not.toBe(linked.id);
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
    expect((await store.appEvents(0)).find((entry) => entry.event === "command_sent")?.count).toBe(1);

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

  it("will not let an organization member stop its owner's process", async () => {
    const { tokens } = await withDevice();
    const sessionId = "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t";
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: sessionId,
        share_url: `https://shell.online/s/${sessionId}`,
        command: "top",
      },
    });

    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: {},
    });
    const colleagueAuth = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleagueAuth });

    const colleagueTokens = await login({}, "uid-2");
    const [colleagueDevice] = await devices("uid-2");
    await call("GET", "/api/agent/commands", { auth: colleagueTokens.access_token });
    const result = await call("POST", "/api/commands", {
      auth: colleagueAuth,
      body: { device_id: colleagueDevice.id, kind: "kill", session_id: sessionId },
    });
    expect(result.status).toBe(403);
  });

  /*
   * The caller names a session, not a machine. Which machine that reaches is
   * the session's business, so a browser holding the wrong device id cannot
   * send a stop anywhere except to the machine actually running it.
   */
  it("stops a session on its own machine whatever device the caller names", async () => {
    const { tokens } = await withDevice();
    const sessionId = "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t";
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: sessionId,
        share_url: `https://shell.online/s/${sessionId}`,
        command: "top",
      },
    });

    const otherTokens = await login({ machine_id: "second-machine", label: "desktop" });
    const [otherDevice] = await devices();
    await call("GET", "/api/agent/commands", { auth: otherTokens.access_token });

    /* Naming the wrong machine does not misdirect it, and does not fail. */
    const queued = await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: otherDevice.id, kind: "kill", session_id: sessionId },
    });
    expect(queued.status).toBe(202);

    /* The other machine is handed nothing. */
    const wrongAgent = await call("GET", "/api/agent/commands", { auth: otherTokens.access_token });
    expect(wrongAgent.body.commands).toEqual([]);

    /* The machine that registered it gets the kill. */
    const claimed = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    expect(claimed.body.commands[0]).toMatchObject({ kind: "kill", sessionId });
  });

  /*
   * A session reports its own exit using the credentials it started with.
   * Unlinking revokes those, so a session started before that can never
   * report anything again: the process dies on the machine and the row stays
   * open here, which reads as a stop button that did nothing. The machine
   * confirming the kill is the same fact on credentials that still work.
   */
  it("closes the session when the machine confirms it carried out the stop", async () => {
    const tokens = await login({ machine_id: "machine-1" });
    await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const sessionId = "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t";
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: sessionId,
        share_url: `https://shell.online/s/${sessionId}`,
        command: "top",
      },
    });

    await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: "ignored", kind: "kill", session_id: sessionId },
    });
    const claimed = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const command = claimed.body.commands[0];

    /* Still running until the machine says otherwise. */
    let listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].closedAt).toBeUndefined();

    await call("POST", `/api/agent/commands/${command.id}`, {
      auth: tokens.access_token,
      body: {},
    });

    listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].closedAt).toEqual(expect.any(Number));
  });

  it("leaves the session running when the machine reports the stop failed", async () => {
    const tokens = await login({ machine_id: "machine-1" });
    await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const sessionId = "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t";
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: sessionId,
        share_url: `https://shell.online/s/${sessionId}`,
        command: "top",
      },
    });
    await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: "ignored", kind: "kill", session_id: sessionId },
    });
    const claimed = await call("GET", "/api/agent/commands", { auth: tokens.access_token });

    await call("POST", `/api/agent/commands/${claimed.body.commands[0].id}`, {
      auth: tokens.access_token,
      body: { error: "no such session" },
    });

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].closedAt).toBeUndefined();
  });

  /*
   * The bug this replaced: unlinking a machine revokes its device row, and
   * signing in again deliberately makes a new one, so every session started
   * before that names a row the account no longer lists. Stopping answered
   * "no such machine" about a machine sitting there polling under a new id.
   */
  it("follows a relinked machine, so stopping still reaches it", async () => {
    /* A machine that can name itself, which is what lets it be followed. */
    const tokens = await login({ machine_id: "machine-1" });
    await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const [first] = await devices();
    const original = first.id as string;
    const sessionId = "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t";
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        id: sessionId,
        share_url: `https://shell.online/s/${sessionId}`,
        command: "top",
      },
    });

    /* Unlink, then sign the same machine in again: a new device row. */
    expect((await call("DELETE", `/api/devices/${original}`, { auth: await idToken() })).status).toBe(200);
    const relinked = await login({ machine_id: "machine-1" });
    const [current] = await devices();
    expect(current.id).not.toBe(original);
    await call("GET", "/api/agent/commands", { auth: relinked.access_token });

    const queued = await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: original, kind: "kill", session_id: sessionId },
    });
    expect(queued.status).toBe(202);

    const claimed = await call("GET", "/api/agent/commands", { auth: relinked.access_token });
    expect(claimed.body.commands[0]).toMatchObject({ kind: "kill", sessionId });
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

describe("a name chosen in the browser", () => {
  it("is cleaned before it is queued for the machine", async () => {
    const tokens = await login();
    const device = (await devices())[0];
    await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    const queued = await call("POST", "/api/commands", {
      auth: await idToken(),
      body: { device_id: device.id, kind: "start", command: "claude", name: "deploy\nnow\u202Egnuf" },
    });
    /* 202 when the machine has not polled since it was queued; either accepts it. */
    expect([201, 202]).toContain(queued.status);
    const claimed = await call("GET", "/api/agent/commands", { auth: tokens.access_token });
    /*
     * The CLI turns this into an environment variable and refuses to start
     * with a name it cannot print, so a browser must not be able to send one.
     */
    expect(claimed.body.commands[0].name).toBe("deploy now gnuf");
  });
});

describe("starting on a machine that is not reachable", () => {
  async function deviceWithoutAgent() {
    await login();
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    return listed.body.devices[0].id as string;
  }

  it("refuses, and says what would make the machine reachable", async () => {
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
    /* Naming the machine and the fix, so the message is actionable. */
    expect(result.body.error).toContain("shell auth");
    expect(result.body.error).toContain("not reachable");
  });

  it("accepts once the machine has polled", async () => {
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
    await call("GET", `/api/agent/commands?key=${P256_PUBLIC_KEY_A}`, {
      auth: tokens.access_token,
    });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    expect(listed.body.devices[0].agentPublicKey).toBe(P256_PUBLIC_KEY_A);
  });

  it("refuses a malformed agent key instead of publishing it", async () => {
    const tokens = await login();
    const result = await call("GET", "/api/agent/commands?key=not-a-p256-key", {
      auth: tokens.access_token,
    });
    expect(result.status).toBe(400);
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    expect(listed.body.devices[0].agentPublicKey).toBeUndefined();
    expect(listed.body.devices[0].agentSeenAt).toBeUndefined();
  });

  it("records the harnesses a polling agent found on its machine", async () => {
    const tokens = await login();
    await call("GET", `/api/agent/commands?key=${P256_PUBLIC_KEY_A}&harnesses=claude-code,openclaw`, {
      auth: tokens.access_token,
    });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    expect(listed.body.devices[0].harnesses).toEqual(["claude-code", "openclaw"]);
  });

  it("stores none of an id it does not know", async () => {
    const tokens = await login();
    await call("GET", "/api/agent/commands?harnesses=claude-code,rm%20-rf,made-up", {
      auth: tokens.access_token,
    });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    /* The recognised half survives; the rest is dropped, not stored. */
    expect(listed.body.devices[0].harnesses).toEqual(["claude-code"]);
  });

  it("says nothing about a machine that has never reported its harnesses", async () => {
    const tokens = await login();
    await call("GET", `/api/agent/commands?key=${P256_PUBLIC_KEY_A}`, { auth: tokens.access_token });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    /* Undefined is "not known", which the browser must not read as "absent". */
    expect(listed.body.devices[0].harnesses).toBeUndefined();
  });

  it("takes an agent's report of having none of them", async () => {
    const tokens = await login();
    await call("GET", "/api/agent/commands?harnesses=", { auth: tokens.access_token });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    expect(listed.body.devices[0].harnesses).toEqual([]);
  });

  it("takes a new key when the agent restarts", async () => {
    const tokens = await login();
    await call("GET", `/api/agent/commands?key=${P256_PUBLIC_KEY_A}`, { auth: tokens.access_token });
    await call("GET", `/api/agent/commands?key=${P256_PUBLIC_KEY_B}`, { auth: tokens.access_token });
    const listed = await call("GET", "/api/devices", { auth: await idToken() });
    expect(listed.body.devices[0].agentPublicKey).toBe(P256_PUBLIC_KEY_B);
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

describe("organizations", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    command: "claude",
  };

  async function orgFor(sub: string, email: string) {
    const result = await call("GET", "/api/org", { auth: await idToken({ sub, email }) });
    return result.body;
  }

  it("gives a new account its own organization, named from the work domain", async () => {
    const body = await orgFor("uid-1", "alex@vulturelabs.io");
    expect(body.organization.name).toBe("Vulturelabs");
    expect(body.you.role).toBe("owner");
    expect(body.members).toHaveLength(1);
  });

  it("does not put two unrelated accounts in one organization", async () => {
    const first = await orgFor("uid-1", "a@one.com");
    const second = await orgFor("uid-2", "b@two.com");
    expect(first.organization.id).not.toBe(second.organization.id);
  });

  it("refuses a malformed browser public key", async () => {
    const result = await call("GET", "/api/org?key=not-a-p256-key", {
      auth: await idToken(),
    });
    expect(result.status).toBe(400);
    expect((await store.membershipOf("uid-1"))?.publicKey).toBeUndefined();
  });

  it("puts someone who follows an invite into that organization", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: { role: "member" },
    });

    const joined = await call(
      `GET`,
      `/api/org?invite=${invite.body.invite.id}`,
      { auth: await idToken({ sub: "uid-2", email: "new@acme.com" }) },
    );
    expect(joined.body.joined).toBe(true);
    expect(joined.body.you.role).toBe("member");
    expect(joined.body.members).toHaveLength(2);
    /* Both halves counted for the dashboard, with nothing about who. */
    expect(await store.appEvents(0)).toEqual([{ event: "invite_accepted", count: 1 }, { event: "invite_created", count: 1 }]);
  });

  it("shows colleagues each other's sessions", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });

    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member" },
    });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });

    /* This is the point of the feature. */
    const seen = await call("GET", "/api/sessions", { auth: colleague });
    expect(seen.body.sessions).toHaveLength(1);
    expect(seen.body.sessions[0].command).toBe("claude");
  });

  it("still shows nothing to someone in another organization", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const stranger = await call("GET", "/api/sessions", {
      auth: await idToken({ sub: "uid-9", email: "stranger@elsewhere.com" }),
    });
    expect(stranger.body.sessions).toEqual([]);
  });

  it("refuses an invite that was issued for another address", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: { role: "member", email: "wanted@acme.com" },
    });
    const wrong = await call(`GET`, `/api/org?invite=${invite.body.invite.id}`, {
      auth: await idToken({ sub: "uid-3", email: "someone@else.com" }),
    });
    /* They still get an organization, and are told why it is not the one. */
    expect(wrong.body.joined).toBe(false);
    expect(wrong.body.inviteError).toContain("different email");
  });

  it("requires a verified identity before accepting an email-targeted invite", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: { role: "member", email: "wanted@acme.com" },
    });
    const attempted = await call("GET", `/api/org?invite=${invite.body.invite.id}`, {
      auth: await idToken({
        sub: "uid-unverified",
        email: "wanted@acme.com",
        email_verified: false,
      }),
    });
    expect(attempted.body.joined).toBe(false);
    expect(attempted.body.inviteError).toContain("Verify that email");
  });

  it("keeps open-link invites available to unverified identities", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: { role: "member" },
    });
    const joined = await call("GET", `/api/org?invite=${invite.body.invite.id}`, {
      auth: await idToken({ sub: "uid-unverified", email_verified: false }),
    });
    expect(joined.body.joined).toBe(true);
  });

  it("cannot use one invite twice", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: {},
    });
    const link = `/api/org?invite=${invite.body.invite.id}`;
    const first = await call("GET", link, { auth: await idToken({ sub: "uid-2", email: "a@acme.com" }) });
    const second = await call("GET", link, { auth: await idToken({ sub: "uid-3", email: "b@acme.com" }) });
    expect(first.body.joined).toBe(true);
    expect(second.body.joined).toBe(false);
    expect(second.body.inviteError).toContain("already been used");
  });

  it("lets exactly one concurrent request consume a single-use invite", async () => {
    await call("GET", "/api/org", { auth: await idToken() });
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: {},
    });
    const link = `/api/org?invite=${invite.body.invite.id}`;
    const [first, second] = await Promise.all([
      call("GET", link, {
        auth: await idToken({ sub: "uid-racer-1", email: "one@example.com" }),
      }),
      call("GET", link, {
        auth: await idToken({ sub: "uid-racer-2", email: "two@example.com" }),
      }),
    ]);
    expect([first.body.joined, second.body.joined].filter(Boolean)).toHaveLength(1);
  });

  it("describes an invite before anyone signs in", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: {},
    });
    const preview = await call("GET", `/api/invites/${invite.body.invite.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body.organization.name).toBe("Acme");
    expect(preview.body.usable).toBe(true);
  });

  it("does not let a member invite, remove or rename", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: {},
    });
    const member = await idToken({ sub: "uid-2", email: "member@acme.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: member });

    expect((await call("POST", "/api/org/invites", { auth: member, body: {} })).status).toBe(403);
    expect((await call("PATCH", "/api/org", { auth: member, body: { name: "Mine" } })).status).toBe(403);
    expect((await call("DELETE", "/api/org/members/uid-1", { auth: member })).status).toBe(403);
  });

  it("does not let anyone remove the owner", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: { role: "admin" },
    });
    const admin = await idToken({ sub: "uid-2", email: "admin@acme.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: admin });

    const attempt = await call("DELETE", "/api/org/members/uid-1", { auth: admin });
    expect(attempt.status).toBe(403);
  });

  it("lets the owner rename the organization", async () => {
    await orgFor("uid-1", "owner@acme.com");
    const renamed = await call("PATCH", "/api/org", {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
      body: { name: "Acme Rockets" },
    });
    expect(renamed.body.organization.name).toBe("Acme Rockets");
  });
});

describe("session ownership and handoff", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    command: "claude",
  };

  async function orgWithColleague() {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member" },
    });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    return { colleague, tokens };
  }

  it("assigns a new session to whoever started it", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].ownerUid).toBe("uid-1");
    expect(listed.body.sessions[0].assigneeUid).toBe("uid-1");
  });

  it("lets the owner hand it to a colleague", async () => {
    await orgWithColleague();
    const handed = await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uid: "uid-2" },
    });
    expect(handed.status).toBe(200);
    expect(handed.body.session.assigneeUid).toBe("uid-2");
    /* The owner does not change; responsibility does. */
    expect(handed.body.session.ownerUid).toBe("uid-1");
  });

  it("assigns a session to several teammates in one update", async () => {
    await orgWithColleague();
    const handed = await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uids: ["uid-1", "uid-2", "uid-2"] },
    });
    expect(handed.status).toBe(200);
    expect(handed.body.session.assigneeUids).toEqual(["uid-1", "uid-2"]);
    expect(handed.body.session.assigneeUid).toBe("uid-1");
  });

  it("returns only the caller's password copy after a handoff", async () => {
    const { colleague } = await orgWithColleague();
    const path = `/api/sessions/${session.id}/keys`;
    await call("PUT", path, {
      auth: await idToken(),
      body: {
        shares: [
          { uid: "uid-1", sender_public_key: P256_PUBLIC_KEY_A, sealed: SESSION_SHARE_A },
          { uid: "uid-2", sender_public_key: P256_PUBLIC_KEY_B, sealed: SESSION_SHARE_B },
        ],
      },
    });

    const handed = await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uids: ["uid-2"] },
    });
    expect(handed.status).toBe(200);
    expect(handed.body.session.keyShare).toEqual({
      uid: "uid-1",
      senderPublicKey: P256_PUBLIC_KEY_A,
      sealed: SESSION_SHARE_A,
    });
    expect(handed.body.session.keyShares).toBeUndefined();
    expect(handed.body.session.sharedWith).toEqual(["uid-2"]);

    const colleagueView = await call("GET", `/api/sessions/${session.id}`, { auth: colleague });
    expect(colleagueView.body.session.keyShare).toMatchObject({
      uid: "uid-2",
      sealed: SESSION_SHARE_B,
    });
    expect(colleagueView.body.session.keyShares).toBeUndefined();
    expect(colleagueView.body.session.sharedWith).toBeUndefined();
  });

  it("lets the owner rename a session, and a blank name clear it", async () => {
    await orgWithColleague();
    const renamed = await call("PUT", `/api/sessions/${session.id}/name`, {
      auth: await idToken(),
      body: { name: "  nightly build " },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.session.name).toBe("nightly build");
    expect(renamed.body.session.keyShares).toBeUndefined();

    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.name).toBe("nightly build");

    const cleared = await call("PUT", `/api/sessions/${session.id}/name`, {
      auth: await idToken(),
      body: { name: "" },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.session.name).toBeUndefined();
  });

  it("lets an assignee rename a session, and not a colleague who is not one", async () => {
    const { colleague } = await orgWithColleague();
    const path = `/api/sessions/${session.id}/name`;
    expect((await call("PUT", path, { auth: colleague, body: { name: "mine" } })).status).toBe(403);
    await call("PUT", `/api/sessions/${session.id}/assignee`, { auth: await idToken(), body: { uids: ["uid-2"] } });
    const renamed = await call("PUT", path, { auth: colleague, body: { name: "handed over" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.session.name).toBe("handed over");
  });

  it("keeps a name given in the browser when the machine re-registers", async () => {
    const { tokens } = await orgWithColleague();
    await call("PUT", `/api/sessions/${session.id}/name`, { auth: await idToken(), body: { name: "renamed" } });
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.name).toBe("renamed");
  });

  it("allows a session to be left unassigned", async () => {
    await orgWithColleague();
    const handed = await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uids: [] },
    });
    expect(handed.status).toBe(200);
    expect(handed.body.session.assigneeUids).toEqual([]);
    expect(handed.body.session.assigneeUid).toBeUndefined();
  });

  it("lets a colleague keep their own copy of a key, and nobody else's", async () => {
    const { colleague } = await orgWithColleague();
    const path = `/api/sessions/${session.id}/keys`;
    const share = { sender_public_key: P256_PUBLIC_KEY_A, sealed: `v2.${SESSION_SHARE_A}` };

    const forOwner = await call("PUT", path, { auth: colleague, body: { shares: [{ uid: "uid-1", ...share }] } });
    expect(forOwner.status).toBe(403);

    /* A password they typed and saw work, sealed to their own vault. */
    const own = await call("PUT", path, { auth: colleague, body: { shares: [{ uid: "uid-2", ...share }] } });
    expect(own.status).toBe(200);
    const listed = await call("GET", "/api/sessions", { auth: colleague });
    expect(listed.body.sessions[0].keyShare).toMatchObject({ sealed: `v2.${SESSION_SHARE_A}` });
  });

  it("tells the owner, and only the owner, who holds a copy", async () => {
    const { colleague } = await orgWithColleague();
    await call("PUT", `/api/sessions/${session.id}/keys`, {
      auth: await idToken(),
      body: { shares: [{ uid: "uid-2", sender_public_key: P256_PUBLIC_KEY_A, sealed: SESSION_SHARE_A }] },
    });
    const owner = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(owner.body.sessions[0].sharedWith).toEqual(["uid-2"]);
    const other = await call("GET", "/api/sessions", { auth: colleague });
    expect(other.body.sessions[0].sharedWith).toBeUndefined();
  });

  it("lets only the owner share a session key, and only with current members", async () => {
    const { colleague } = await orgWithColleague();
    const path = `/api/sessions/${session.id}/keys`;
    const shares = [{
      uid: "uid-2",
      sender_public_key: P256_PUBLIC_KEY_A,
      sealed: SESSION_SHARE_A,
    }];

    const shared = await call("PUT", path, { auth: await idToken(), body: { shares } });
    expect(shared).toMatchObject({ status: 200, body: { shared: 1 } });

    const listed = await call("GET", "/api/sessions", { auth: colleague });
    expect(listed.body.sessions[0].keyShare).toMatchObject({
      senderPublicKey: P256_PUBLIC_KEY_A,
      sealed: SESSION_SHARE_A,
    });

    /* A colleague may keep their own copy, but cannot write one for anyone else. */
    const overwritten = await call("PUT", path, {
      auth: colleague,
      body: { shares: [{ ...shares[0], uid: "uid-1" }] },
    });
    expect(overwritten.status).toBe(403);

    const outsider = await call("PUT", path, {
      auth: await idToken(),
      body: {
        shares: [{
          uid: "uid-outside",
          sender_public_key: P256_PUBLIC_KEY_A,
          sealed: SESSION_SHARE_A,
        }],
      },
    });
    expect(outsider.status).toBe(400);
  });

  it("records the handoff in the audit log", async () => {
    await orgWithColleague();
    await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uid: "uid-2" },
    });
    const log = await call("GET", `/api/audit/${session.id}`, { auth: await idToken() });
    expect(log.body.events.at(-1)).toMatchObject({
      kind: "handoff",
      text: "assigned to colleague@example.com",
    });
  });

  it("does not let a plain member reassign someone else's session", async () => {
    const { colleague } = await orgWithColleague();
    const attempt = await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: colleague,
      body: { uid: "uid-2" },
    });
    expect(attempt.status).toBe(403);
  });

  it("will not assign to someone outside the organization", async () => {
    await orgWithColleague();
    const attempt = await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uid: "uid-stranger" },
    });
    expect(attempt.status).toBe(404);
  });

  it("keeps another organization outside every session mutation path", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const stranger = await idToken({ sub: "uid-9", email: "stranger@elsewhere.com" });

    expect((await call("GET", `/api/sessions/${session.id}`, { auth: stranger })).status).toBe(404);
    expect((await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: stranger,
      body: { uids: ["uid-9"] },
    })).status).toBe(404);
    expect((await call("PUT", `/api/sessions/${session.id}/keys`, {
      auth: stranger,
      body: {
        shares: [{ uid: "uid-9", sender_public_key: "STRANGER_KEY", sealed: "STRANGER_SHARE" }],
      },
    })).status).toBe(404);
    expect((await call("DELETE", `/api/sessions/${session.id}`, { auth: stranger })).status).toBe(404);
    expect((await call("POST", "/api/commands", {
      auth: stranger,
      body: { kind: "kill", session_id: session.id },
    })).status).toBe(404);
  });

  it("keeps an assignment when a persistent session re-registers", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: {} });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, {
      auth: await idToken({ sub: "uid-2", email: "colleague@example.com" }),
    });
    await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uid: "uid-2" },
    });

    /* A restart re-registers with the owner as assignee; that must not win. */
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].assigneeUid).toBe("uid-2");
  });
});

describe("session automation settings", () => {
  it("does not re-enable team access when an unrelated stale save finishes later", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const auth = await idToken();
    const route = `/api/sessions/${session.id}/automation`;
    await call("PUT", route, { auth, body: { mcpTeamAccess: true } });
    const persist = store.setSessionAutomationConsent.bind(store);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const registered = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(store, "setSessionAutomationConsent").mockImplementation(async (...args) => {
      if (args[3].dailyBriefingEnabled === true) {
        entered();
        await held;
      }
      return persist(...args);
    });
    const briefing = call("PUT", route, { auth, body: { dailyBriefingEnabled: true } });
    try {
      await registered;
      expect((await call("PUT", route, { auth, body: { mcpTeamAccess: false } })).status).toBe(200);
    } finally {
      release();
    }
    expect((await briefing).status).toBe(200);
    spy.mockRestore();
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth });
    expect(detail.body.session).toMatchObject({ mcpTeamAccess: false, dailyBriefingEnabled: true });
  });

  const session = {
    id: "aUto9m4t10nSess10nIdXyZ012345",
    share_url: "https://shell.online/s/aUto9m4t10nSess10nIdXyZ012345",
    command: "claude",
  };
  const path = `/api/sessions/${session.id}/automation`;

  /* Registers the session and returns a signed-in colleague in the same org. */
  async function orgWithColleague() {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member" },
    });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    return { colleague, tokens };
  }

  it("starts a session with every automation switch off", async () => {
    await orgWithColleague();
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.mcpTeamAccess).toBe(false);
    expect(detail.body.session.dailyBriefingEnabled).toBe(false);
    expect(detail.body.session.dailyBriefingTeamAccess).toBe(false);
  });

  it("lets the owner turn a switch on, and back off again", async () => {
    await orgWithColleague();
    const on = await call("PUT", path, {
      auth: await idToken(),
      body: { mcpTeamAccess: true },
    });
    expect(on.status).toBe(200);
    expect(on.body.session.mcpTeamAccess).toBe(true);
    expect(on.body.session.dailyBriefingEnabled).toBe(false);

    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.mcpTeamAccess).toBe(true);

    const off = await call("PUT", path, {
      auth: await idToken(),
      body: { mcpTeamAccess: false, dailyBriefingTeamAccess: true },
    });
    expect(off.status).toBe(200);
    expect(off.body.session.mcpTeamAccess).toBe(false);
    expect(off.body.session.dailyBriefingTeamAccess).toBe(true);
  });

  it("sets all three switches in one update", async () => {
    await orgWithColleague();
    const all = await call("PUT", path, {
      auth: await idToken(),
      body: { mcpTeamAccess: true, dailyBriefingEnabled: true, dailyBriefingTeamAccess: true },
    });
    expect(all.status).toBe(200);
    expect(all.body.session.mcpTeamAccess).toBe(true);
    expect(all.body.session.dailyBriefingEnabled).toBe(true);
    expect(all.body.session.dailyBriefingTeamAccess).toBe(true);
  });

  it("does not let a colleague who is not the owner change the settings", async () => {
    const { colleague } = await orgWithColleague();
    const denied = await call("PUT", path, {
      auth: colleague,
      body: { mcpTeamAccess: true },
    });
    expect(denied.status).toBe(403);
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.mcpTeamAccess).toBe(false);
  });

  it("does not let an organization admin substitute for the owner", async () => {
    const { colleague } = await orgWithColleague();
    const promoted = await call("PATCH", "/api/org/members/uid-2", {
      auth: await idToken(),
      body: { role: "admin" },
    });
    expect(promoted.status).toBe(200);
    const denied = await call("PUT", path, {
      auth: colleague,
      body: { dailyBriefingEnabled: true },
    });
    expect(denied.status).toBe(403);
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.dailyBriefingEnabled).toBe(false);
  });

  it("does not let an assignee substitute for the owner", async () => {
    const { colleague } = await orgWithColleague();
    await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uid: "uid-2" },
    });
    const denied = await call("PUT", path, {
      auth: colleague,
      body: { mcpTeamAccess: true },
    });
    expect(denied.status).toBe(403);
  });

  it("cannot reach a session that is not in the caller's organization", async () => {
    await orgWithColleague();
    /* A different account, and therefore a different organization. */
    const outsider = await idToken({ sub: "uid-3", email: "outsider@example.com" });
    const denied = await call("PUT", path, {
      auth: outsider,
      body: { mcpTeamAccess: true },
    });
    expect(denied.status).toBe(404);
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.mcpTeamAccess).toBe(false);
  });

  it("refuses a field that is not one of the three switches", async () => {
    await orgWithColleague();
    const denied = await call("PUT", path, {
      auth: await idToken(),
      body: { mcpTeamAccess: true, autoRename: true },
    });
    expect(denied.status).toBe(400);
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.mcpTeamAccess).toBe(false);
  });

  it("refuses a switch that is not a strict boolean", async () => {
    await orgWithColleague();
    for (const value of ["true", 1, null, { on: true }]) {
      const denied = await call("PUT", path, {
        auth: await idToken(),
        body: { mcpTeamAccess: value },
      });
      expect(denied.status).toBe(400);
    }
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.mcpTeamAccess).toBe(false);
  });

  it("refuses an update that changes nothing", async () => {
    await orgWithColleague();
    const denied = await call("PUT", path, { auth: await idToken(), body: {} });
    expect(denied.status).toBe(400);
  });

  it("reports the switches in the list and detail the owner polls", async () => {
    await orgWithColleague();
    await call("PUT", path, {
      auth: await idToken(),
      body: { mcpTeamAccess: true, dailyBriefingEnabled: true },
    });
    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].mcpTeamAccess).toBe(true);
    expect(listed.body.sessions[0].dailyBriefingEnabled).toBe(true);
    expect(listed.body.sessions[0].dailyBriefingTeamAccess).toBe(false);
  });

  it("keeps the owner's consent when the machine re-registers", async () => {
    const { tokens } = await orgWithColleague();
    await call("PUT", path, {
      auth: await idToken(),
      body: { mcpTeamAccess: true, dailyBriefingTeamAccess: true },
    });
    /* A restart re-registers the same session; that is not a consent change. */
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.mcpTeamAccess).toBe(true);
    expect(detail.body.session.dailyBriefingTeamAccess).toBe(true);
  });
});

describe("CLI daily-briefing preference", () => {
  const firstSession = {
    id: "Br1ef1ngF1rstSess10nIdXyZ01",
    share_url: "https://shell.online/s/Br1ef1ngF1rstSess10nIdXyZ01",
    command: "claude",
  };
  const secondSession = {
    id: "Br1ef1ngS3c0ndSess10nIdXyZ0",
    share_url: "https://shell.online/s/Br1ef1ngS3c0ndSess10nIdXyZ0",
    command: "pytest -x",
  };

  it("refuses a preference request without a CLI token", async () => {
    expect((await call("GET", "/api/cli/briefings")).status).toBe(401);
    expect((await call("PUT", "/api/cli/briefings", { body: { enabled: true } })).status).toBe(401);
  });

  it("reads as off for an account that never set it", async () => {
    const tokens = await login();
    const result = await call("GET", "/api/cli/briefings", { auth: tokens.access_token });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ enabled: false });
  });

  it("saves the default and reports it back", async () => {
    const tokens = await login();
    const saved = await call("PUT", "/api/cli/briefings", {
      auth: tokens.access_token,
      body: { enabled: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ enabled: true, applied: 0 });
    const read = await call("GET", "/api/cli/briefings", { auth: tokens.access_token });
    expect(read.body).toEqual({ enabled: true });
  });

  it("refuses a body that is not exactly the preference", async () => {
    const tokens = await login();
    for (const body of [
      {},
      { enabled: "true" },
      { enabled: 1 },
      { enabled: null },
      { apply_to_existing: true },
      { enabled: true, apply_to_existing: "yes" },
      { enabled: true, role: "owner" },
      { enabled: true, dailyBriefingTeamAccess: true },
    ]) {
      const denied = await call("PUT", "/api/cli/briefings", {
        auth: tokens.access_token,
        body,
      });
      expect(denied.status).toBe(400);
    }
    expect((await call("GET", "/api/cli/briefings", { auth: tokens.access_token })).body).toEqual({
      enabled: false,
    });
  });

  it("applies the default to the owner's sessions and nothing else", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: firstSession });
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: secondSession });
    /* The owner's own switch on one session, to prove the bulk update leaves it alone. */
    await call("PUT", `/api/sessions/${firstSession.id}/automation`, {
      auth: await idToken(),
      body: { mcpTeamAccess: true, dailyBriefingTeamAccess: true },
    });

    const saved = await call("PUT", "/api/cli/briefings", {
      auth: tokens.access_token,
      body: { enabled: true, apply_to_existing: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ enabled: true, applied: 2 });

    const detail = await call("GET", `/api/sessions/${firstSession.id}`, { auth: await idToken() });
    expect(detail.body.session).toMatchObject({
      mcpTeamAccess: true,
      dailyBriefingEnabled: true,
      dailyBriefingTeamAccess: true,
    });
  });

  it("leaves a colleague's sessions and a merely-assigned session alone", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: firstSession });
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member" },
    });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    const colleagueTokens = await login({}, "uid-2");
    await call("POST", "/api/sessions", { auth: colleagueTokens.access_token, body: secondSession });
    /* The owner hands one of their sessions to the colleague. */
    await call("PUT", `/api/sessions/${firstSession.id}/assignee`, {
      auth: await idToken(),
      body: { uid: "uid-2" },
    });

    const saved = await call("PUT", "/api/cli/briefings", {
      auth: colleagueTokens.access_token,
      body: { enabled: true, apply_to_existing: true },
    });
    expect(saved.body).toEqual({ enabled: true, applied: 1 });

    /* The colleague's own session is on; the assigned one is still the owner's to switch. */
    const theirs = await call("GET", `/api/sessions/${secondSession.id}`, { auth: colleague });
    expect(theirs.body.session.dailyBriefingEnabled).toBe(true);
    const assigned = await call("GET", `/api/sessions/${firstSession.id}`, { auth: await idToken() });
    expect(assigned.body.session.dailyBriefingEnabled).toBe(false);
  });

  it("does not reach a session in another organization", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: firstSession });
    const outsiderTokens = await login({}, "uid-2");
    await call("POST", "/api/sessions", { auth: outsiderTokens.access_token, body: secondSession });

    const saved = await call("PUT", "/api/cli/briefings", {
      auth: outsiderTokens.access_token,
      body: { enabled: true, apply_to_existing: true },
    });
    expect(saved.body).toEqual({ enabled: true, applied: 1 });

    const detail = await call("GET", `/api/sessions/${firstSession.id}`, { auth: await idToken() });
    expect(detail.body.session.dailyBriefingEnabled).toBe(false);
  });

  it("starts a new session with the saved default, and nothing else", async () => {
    const tokens = await login();
    await call("PUT", "/api/cli/briefings", { auth: tokens.access_token, body: { enabled: true } });
    const created = await call("POST", "/api/sessions", { auth: tokens.access_token, body: firstSession });
    expect(created.status).toBe(201);
    const detail = await call("GET", `/api/sessions/${firstSession.id}`, { auth: await idToken() });
    expect(detail.body.session.dailyBriefingEnabled).toBe(true);
    expect(detail.body.session.mcpTeamAccess).toBe(false);
    expect(detail.body.session.dailyBriefingTeamAccess).toBe(false);
  });

  it("does not trust a registration field to grant the default", async () => {
    const tokens = await login();
    const created = await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { ...firstSession, daily_briefing_enabled: true, mcp_team_access: true },
    });
    expect(created.status).toBe(201);
    const detail = await call("GET", `/api/sessions/${firstSession.id}`, { auth: await idToken() });
    expect(detail.body.session.dailyBriefingEnabled).toBe(false);
    expect(detail.body.session.mcpTeamAccess).toBe(false);
  });

  it("keeps an explicit opt-out when the session re-registers with the default on", async () => {
    const tokens = await login();
    await call("PUT", "/api/cli/briefings", { auth: tokens.access_token, body: { enabled: true } });
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: firstSession });
    await call("PUT", `/api/sessions/${firstSession.id}/automation`, {
      auth: await idToken(),
      body: { dailyBriefingEnabled: false },
    });
    /* A restart re-registers the same session; that is not a consent change. */
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: firstSession });
    const detail = await call("GET", `/api/sessions/${firstSession.id}`, { auth: await idToken() });
    expect(detail.body.session.dailyBriefingEnabled).toBe(false);
  });

  it("keeps the default through a re-login and a credential refresh", async () => {
    const tokens = await login();
    await call("PUT", "/api/cli/briefings", { auth: tokens.access_token, body: { enabled: true } });

    /* The browser signs in again: the membership row is rewritten. */
    await call("GET", "/api/org", { auth: await idToken() });
    expect(
      (await call("GET", "/api/cli/briefings", { auth: tokens.access_token })).body,
    ).toEqual({ enabled: true });

    /* The CLI renews its token: the account is re-described. */
    const refreshed = await call("POST", "/api/cli/refresh", {
      body: { refresh_token: tokens.refresh_token },
    });
    expect(refreshed.status).toBe(200);
    expect(
      (await call("GET", "/api/cli/briefings", { auth: refreshed.body.access_token })).body,
    ).toEqual({ enabled: true });
  });

  it("keeps each account's own default", async () => {
    const tokens = await login();
    const colleagueTokens = await login({}, "uid-2");
    await call("PUT", "/api/cli/briefings", { auth: tokens.access_token, body: { enabled: true } });
    expect(
      (await call("GET", "/api/cli/briefings", { auth: colleagueTokens.access_token })).body,
    ).toEqual({ enabled: false });
  });
});

describe("CLI session automation settings", () => {
  const session = {
    id: "Cl11Au4o9m4t10nSess10nIdXyZ",
    share_url: "https://shell.online/s/Cl11Au4o9m4t10nSess10nIdXyZ",
    command: "claude",
  };
  const cliPath = `/api/cli/sessions/${session.id}/automation`;
  const webPath = `/api/sessions/${session.id}/automation`;

  /* Registers the session and returns a signed-in colleague in the same org. */
  async function orgWithColleague() {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member" },
    });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    const colleagueTokens = await login({}, "uid-2");
    return { colleague, colleagueTokens, tokens };
  }

  it("refuses a request without a CLI token", async () => {
    await orgWithColleague();
    expect((await call("GET", cliPath)).status).toBe(401);
    expect((await call("PUT", cliPath, { body: { mcpTeamAccess: true } })).status).toBe(401);
  });

  it("reads the three switches and nothing else", async () => {
    const { tokens } = await orgWithColleague();
    const result = await call("GET", cliPath, { auth: tokens.access_token });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      mcpTeamAccess: false,
      dailyBriefingEnabled: false,
      dailyBriefingTeamAccess: false,
    });
  });

  it("cannot read a session that is not in the caller's organization", async () => {
    const { tokens } = await orgWithColleague();
    /* A different account, and therefore a different organization. */
    const outsiderTokens = await login({}, "uid-3");
    expect((await call("GET", cliPath, { auth: outsiderTokens.access_token })).status).toBe(404);
    expect(
      (await call("PUT", cliPath, { auth: outsiderTokens.access_token, body: { mcpTeamAccess: true } })).status,
    ).toBe(404);
    expect((await call("GET", cliPath, { auth: tokens.access_token })).status).toBe(200);
  });

  it("cannot reach a made-up session id", async () => {
    const { tokens } = await orgWithColleague();
    const missing = cliPath.replace(session.id, "N07Succ3ss10nIdXyZ01234567");
    expect((await call("GET", missing, { auth: tokens.access_token })).status).toBe(404);
  });

  it("does not let a colleague who is not the owner read or change the settings", async () => {
    const { tokens, colleagueTokens } = await orgWithColleague();
    expect((await call("GET", cliPath, { auth: colleagueTokens.access_token })).status).toBe(403);
    const denied = await call("PUT", cliPath, {
      auth: colleagueTokens.access_token,
      body: { mcpTeamAccess: true },
    });
    expect(denied.status).toBe(403);
    const read = await call("GET", cliPath, { auth: tokens.access_token });
    expect(read.body.mcpTeamAccess).toBe(false);
  });

  it("does not let an organization admin substitute for the owner", async () => {
    const { tokens, colleagueTokens } = await orgWithColleague();
    const promoted = await call("PATCH", "/api/org/members/uid-2", {
      auth: await idToken(),
      body: { role: "admin" },
    });
    expect(promoted.status).toBe(200);
    const denied = await call("PUT", cliPath, {
      auth: colleagueTokens.access_token,
      body: { dailyBriefingEnabled: true },
    });
    expect(denied.status).toBe(403);
    const read = await call("GET", cliPath, { auth: tokens.access_token });
    expect(read.body.dailyBriefingEnabled).toBe(false);
  });

  it("does not let an assignee substitute for the owner", async () => {
    const { tokens, colleagueTokens } = await orgWithColleague();
    await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uid: "uid-2" },
    });
    const denied = await call("PUT", cliPath, {
      auth: colleagueTokens.access_token,
      body: { mcpTeamAccess: true },
    });
    expect(denied.status).toBe(403);
    const read = await call("GET", cliPath, { auth: tokens.access_token });
    expect(read.body.mcpTeamAccess).toBe(false);
  });

  it("updates the switches the caller names and preserves the rest", async () => {
    const { tokens } = await orgWithColleague();
    await call("PUT", webPath, {
      auth: await idToken(),
      body: { mcpTeamAccess: true, dailyBriefingEnabled: true, dailyBriefingTeamAccess: true },
    });
    const updated = await call("PUT", cliPath, {
      auth: tokens.access_token,
      body: { dailyBriefingEnabled: false },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({
      mcpTeamAccess: true,
      dailyBriefingEnabled: false,
      dailyBriefingTeamAccess: true,
    });
  });

  it("refuses a body that is not exactly the switches", async () => {
    const { tokens } = await orgWithColleague();
    for (const body of [
      {},
      { mcpTeamAccess: "true" },
      { mcpTeamAccess: 1 },
      { mcpTeamAccess: true, autoRename: true },
      { dailyBriefingEnabled: true, enabled: true },
    ]) {
      const denied = await call("PUT", cliPath, { auth: tokens.access_token, body });
      expect(denied.status).toBe(400);
    }
  });

  it("sees a change the web app made", async () => {
    const { tokens } = await orgWithColleague();
    await call("PUT", webPath, {
      auth: await idToken(),
      body: { mcpTeamAccess: true, dailyBriefingTeamAccess: true },
    });
    const read = await call("GET", cliPath, { auth: tokens.access_token });
    expect(read.body).toEqual({
      mcpTeamAccess: true,
      dailyBriefingEnabled: false,
      dailyBriefingTeamAccess: true,
    });
  });

  it("is seen by the web app when the CLI makes a change", async () => {
    const { tokens } = await orgWithColleague();
    const updated = await call("PUT", cliPath, {
      auth: tokens.access_token,
      body: { mcpTeamAccess: true, dailyBriefingEnabled: true },
    });
    expect(updated.status).toBe(200);
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session).toMatchObject({
      mcpTeamAccess: true,
      dailyBriefingEnabled: true,
      dailyBriefingTeamAccess: false,
    });
    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0]).toMatchObject({
      mcpTeamAccess: true,
      dailyBriefingEnabled: true,
    });
  });

  it("keeps a per-session opt-out through re-registration and re-login with the default on", async () => {
    const { tokens } = await orgWithColleague();
    await call("PUT", "/api/cli/briefings", {
      auth: tokens.access_token,
      body: { enabled: true, apply_to_existing: true },
    });
    expect(
      (await call("GET", cliPath, { auth: tokens.access_token })).body.dailyBriefingEnabled,
    ).toBe(true);
    await call("PUT", cliPath, {
      auth: tokens.access_token,
      body: { dailyBriefingEnabled: false },
    });
    /* A restart re-registers the same session; the browser signs in again. */
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    await call("GET", "/api/org", { auth: await idToken() });
    const read = await call("GET", cliPath, { auth: tokens.access_token });
    expect(read.body.dailyBriefingEnabled).toBe(false);
    const detail = await call("GET", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(detail.body.session.dailyBriefingEnabled).toBe(false);
  });
});

describe("audit log", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    command: "claude",
  };

  async function withSession() {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    return tokens;
  }

  it("records the removal of a session and keeps the entry after the row is gone", async () => {
    await withSession();
    const removed = await call("DELETE", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(removed.status).toBe(200);

    /* The session is gone from the lists. */
    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions).toEqual([]);

    /*
     * The entry is not. Read from the team's trail rather than the session's,
     * because the session is the thing that just stopped existing.
     */
    const log = await call("GET", "/api/audit", { auth: await idToken() });
    const kinds = log.body.events
      .filter((event: { sessionId: string }) => event.sessionId === session.id)
      .map((event: { kind: string }) => event.kind);
    expect(kinds).toEqual(["deleted"]);
  });

  it("refuses to remove a session belonging to somebody else", async () => {
    await withSession();
    const other = await idToken({ sub: "uid-outsider", email: "outsider@example.com" });
    const result = await call("DELETE", `/api/sessions/${session.id}`, { auth: other });
    expect([401, 403, 404]).toContain(result.status);
  });

  it("has nothing to remove twice", async () => {
    await withSession();
    await call("DELETE", `/api/sessions/${session.id}`, { auth: await idToken() });
    const again = await call("DELETE", `/api/sessions/${session.id}`, { auth: await idToken() });
    expect(again.status).toBe(404);
  });

  /*
   * An entry shaped the way the browser seals one: a real P-256 sender key and
   * a body of nonce and ciphertext. The service can only check the shape, so
   * random bytes of the right length stand in for the ciphertext.
   */
  async function sealedEntry(bodyBytes = 40) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const sender = base64url(Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)));
    return `a1.1.${sender}.${base64url(randomBytes(bodyBytes))}`;
  }

  /*
   * What people type into a session is recorded for their team. That is the
   * operator's choice, made deliberately: it was removed once and put back on
   * their instruction, and the terms say so. What changed is who can read it.
   * The browser seals each entry to the team's audit key before sending it,
   * and the service refuses anything it could read. This test is where that
   * is written down, so that accepting plaintext again is a decision somebody
   * takes rather than a regression.
   */
  it("records typed input only as ciphertext sealed for the team", async () => {
    await withSession();
    const plaintext = await call("POST", "/api/audit", {
      auth: await idToken(),
      body: {
        entries: [
          { session_id: session.id, kind: "input", text: "refactor the parser", at: 1000 },
          { session_id: session.id, kind: "interrupt", text: "", at: 1001 },
        ],
      },
    });
    expect(plaintext.body).toEqual({ written: 0, refused: 2 });

    const input = await sealedEntry();
    const interrupt = await sealedEntry(28);
    const sealed = await call("POST", "/api/audit", {
      auth: await idToken(),
      body: {
        entries: [
          { session_id: session.id, kind: "input", text: input, at: 2000 },
          { session_id: session.id, kind: "interrupt", text: interrupt, at: 2001 },
          /* The time is bound into the ciphertext, so an entry without one cannot be stored as sealed. */
          { session_id: session.id, kind: "input", text: await sealedEntry() },
        ],
      },
    });
    expect(sealed.body).toEqual({ written: 2, refused: 1 });

    const log = await call("GET", `/api/audit/${session.id}`, { auth: await idToken() });
    expect(
      log.body.events.map((event: { kind: string; text: string; at: number }) => [event.kind, event.text, event.at]),
    ).toEqual([
      ["input", input, 2000],
      ["interrupt", interrupt, 2001],
    ]);
  });

  it("does not let a browser forge service-owned audit events", async () => {
    await withSession();
    const forged = await call("POST", "/api/audit", {
      auth: await idToken(),
      body: {
        entries: [
          { session_id: session.id, kind: "handoff", text: "assigned to attacker@example.com" },
          { session_id: session.id, kind: "stopped", text: "stopped" },
          { session_id: session.id, kind: "deleted", text: "deleted" },
        ],
      },
    });
    expect(forged.body).toEqual({ written: 0, refused: 3 });
    const log = await call("GET", `/api/audit/${session.id}`, { auth: await idToken() });
    expect(log.body.events).toEqual([]);
  });

  it("accepts terminal input only from an owner or assignee", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const invite = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member" },
    });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    const input = { session_id: session.id, kind: "input", text: await sealedEntry(), at: 2000 };

    const watching = await call("POST", "/api/audit", {
      auth: colleague,
      body: { entries: [input] },
    });
    expect(watching.body).toEqual({ written: 0, refused: 1 });

    await call("PUT", `/api/sessions/${session.id}/assignee`, {
      auth: await idToken(),
      body: { uids: ["uid-2"] },
    });
    const assigned = await call("POST", "/api/audit", {
      auth: colleague,
      body: { entries: [input] },
    });
    expect(assigned.body).toEqual({ written: 1, refused: 0 });
  });

  /* Longer than the old plaintext cap: trimming ciphertext would destroy it. */
  it("stores a long sealed entry whole", async () => {
    await withSession();
    const long = await sealedEntry(4000 + 28);
    const result = await call("POST", "/api/audit", {
      auth: await idToken(),
      body: { entries: [{ session_id: session.id, kind: "input", text: long, at: 3000 }] },
    });
    expect(result.body.written).toBe(1);
    const log = await call("GET", `/api/audit/${session.id}`, { auth: await idToken() });
    expect(log.body.events[0].text).toBe(long);
  });

  it("filters and pages by who, what and when, and leaves text search to the browser", async () => {
    await withSession();
    await call("POST", "/api/audit", {
      auth: await idToken(),
      body: {
        entries: [
          { session_id: session.id, kind: "input", text: await sealedEntry(), at: 1000 },
          { session_id: session.id, kind: "interrupt", text: await sealedEntry(28), at: 2000 },
          { session_id: session.id, kind: "input", text: await sealedEntry(), at: 3000 },
        ],
      },
    });

    /* The service cannot search ciphertext, so a text query changes nothing. */
    const searched = await call("GET", "/api/audit?q=npm", { auth: await idToken() });
    expect(searched.body.total).toBe(3);

    const first = await call("GET", "/api/audit?kind=input&limit=1&page=1", { auth: await idToken() });
    const second = await call("GET", "/api/audit?kind=input&limit=1&page=2", { auth: await idToken() });
    expect(first.body).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(first.body.events.map((entry: { at: number }) => entry.at)).toEqual([3000]);
    expect(second.body.events.map((entry: { at: number }) => entry.at)).toEqual([1000]);

    const recent = await call("GET", "/api/audit?since_at=2500", { auth: await idToken() });
    expect(recent.body.total).toBe(1);
  });

  it("will not read another organization's log", async () => {
    await withSession();
    const read = await call("GET", `/api/audit/${session.id}`, {
      auth: await idToken({ sub: "uid-9", email: "stranger@elsewhere.com" }),
    });
    expect(read.status).toBe(404);
  });

});

describe("accepting an invite when you already have an organization", () => {
  async function orgFor(sub: string, email: string) {
    const result = await call("GET", "/api/org", { auth: await idToken({ sub, email }) });
    return result.body;
  }

  async function inviteFrom(sub: string, email: string, forEmail?: string) {
    await orgFor(sub, email);
    const created = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub, email }),
      body: { role: "member", email: forEmail },
    });
    return created.body.invite.id as string;
  }

  it("moves someone who is alone in the organization made for them", async () => {
    /* Signing in creates one; an invite arriving later must still work. */
    const solo = await orgFor("uid-2", "joiner@example.com");
    const inviteId = await inviteFrom("uid-1", "owner@acme.com");

    const joined = await call("GET", `/api/org?invite=${inviteId}`, {
      auth: await idToken({ sub: "uid-2", email: "joiner@example.com" }),
    });
    expect(joined.body.joined).toBe(true);
    expect(joined.body.organization.id).not.toBe(solo.organization.id);
    expect(joined.body.members).toHaveLength(2);
  });

  it("refuses to strand people in an organization the joiner owns", async () => {
    await orgFor("uid-2", "boss@own.com");
    const theirInvite = await call("POST", "/api/org/invites", {
      auth: await idToken({ sub: "uid-2", email: "boss@own.com" }),
      body: {},
    });
    await call("GET", `/api/org?invite=${theirInvite.body.invite.id}`, {
      auth: await idToken({ sub: "uid-3", email: "staff@own.com" }),
    });

    const inviteId = await inviteFrom("uid-1", "owner@acme.com");
    const attempt = await call("GET", `/api/org?invite=${inviteId}`, {
      auth: await idToken({ sub: "uid-2", email: "boss@own.com" }),
    });
    expect(attempt.body.joined).toBe(false);
    expect(attempt.body.inviteError).toContain("Hand ownership over");
  });

  it("says so when the invite is for the organization you are already in", async () => {
    const inviteId = await inviteFrom("uid-1", "owner@acme.com");
    const attempt = await call("GET", `/api/org?invite=${inviteId}`, {
      auth: await idToken({ sub: "uid-1", email: "owner@acme.com" }),
    });
    expect(attempt.body.inviteError).toContain("already in that organization");
  });

  it("leaves the joiner where they were when the invite is bad", async () => {
    const before = await orgFor("uid-2", "joiner@example.com");
    const attempt = await call("GET", "/api/org?invite=inv_00000000000000000000000000000000", {
      auth: await idToken({ sub: "uid-2", email: "joiner@example.com" }),
    });
    expect(attempt.body.organization.id).toBe(before.organization.id);
    expect(attempt.body.inviteError).toBeTruthy();
  });
});

describe("cross-origin preflight", () => {
  it("allows every method the app actually uses", async () => {
    /* PUT was missing, so assigning a session failed in the browser only. */
    const result = await call("GET", "/api/health", { origin: ORIGIN });
    const allowed = result.headers["Access-Control-Allow-Methods"] ?? "";
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(allowed).toContain(method);
    }
  });
});

describe("being told a colleague started a session", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    command: "htop",
  };

  async function orgWithColleague() {
    const tokens = await login();
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: {} });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    return { tokens, colleague };
  }

  it("notifies the rest of the organization, but not the person who started it", async () => {
    const { tokens, colleague } = await orgWithColleague();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });

    const theirs = await call("GET", "/api/notifications", { auth: colleague });
    expect(theirs.body.notifications).toHaveLength(1);
    expect(theirs.body.notifications[0]).toMatchObject({ kind: "shared", body: "htop" });

    const mine = await call("GET", "/api/notifications", { auth: await idToken() });
    expect(mine.body.notifications).toEqual([]);
  });

  it("counts as quiet, so the badge does not shout for it", async () => {
    /* Only an assignment makes the badge solid. */
    const { tokens, colleague } = await orgWithColleague();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const theirs = await call("GET", "/api/notifications", { auth: colleague });
    expect(theirs.body.unread).toBe(1);
    expect(theirs.body.unreadAssignments).toBe(0);
  });

  it("does not notify again when a persistent session re-registers", async () => {
    const { tokens, colleague } = await orgWithColleague();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });

    const theirs = await call("GET", "/api/notifications", { auth: colleague });
    expect(theirs.body.notifications).toHaveLength(1);
  });

  it("does not reach another organization", async () => {
    const tokens = await login();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
    const stranger = await call("GET", "/api/notifications", {
      auth: await idToken({ sub: "uid-9", email: "stranger@elsewhere.com" }),
    });
    expect(stranger.body.notifications).toEqual([]);
  });

  /*
   * The client draws each notification as a person doing something, so a reply
   * without the roster is a reply it cannot render. Marking everything read
   * returned one without it, and the page went blank.
   */
  it("carries the roster on every reply, not only on the read", async () => {
    const { tokens, colleague } = await orgWithColleague();
    await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });

    const listed = await call("GET", "/api/notifications", { auth: colleague });
    expect(listed.body.members.length).toBeGreaterThan(0);

    const one = await call("POST", "/api/notifications/read", {
      auth: colleague,
      body: { id: listed.body.notifications[0].id },
    });
    expect(one.body.members).toEqual(listed.body.members);

    const all = await call("POST", "/api/notifications/read", { auth: colleague, body: {} });
    expect(all.body.members).toEqual(listed.body.members);
    expect(all.body.unread).toBe(0);
  });
});

describe("guarding the service itself", () => {
  it("answers liveness without touching the store", async () => {
    /* A store that throws stands in for a database that is unreachable. */
    const broken = new Proxy({} as Store, {
      get: () => () => Promise.reject(new Error("connection refused")),
    });
    const guarded = createApp({
      store: broken,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      log: () => {},
    });
    const request = { method: "GET", url: "/api/health", headers: {}, socket: {}, on: () => {}, destroy() {} };
    let status = 0;
    const response = {
      writeHead(code: number) { status = code; return response; },
      setHeader() {},
      end() {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await guarded(request as any, response as any);
    expect(status).toBe(200);
  });

  it("reports itself unready when the store cannot answer", async () => {
    const broken = new Proxy({} as Store, {
      get: () => () => Promise.reject(new Error("connection refused")),
    });
    handle = createApp({
      store: broken,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      log: () => {},
    });
    const result = await call("GET", "/api/ready");
    expect(result.status).toBe(503);
  });

  it("is ready when the store answers", async () => {
    expect((await call("GET", "/api/ready")).status).toBe(200);
  });

  /*
   * A driver's message describes this service's schema. The caller who caused
   * the fault gets a status; the detail goes to the log.
   */
  it("does not describe an internal fault to the caller", async () => {
    const messages: string[] = [];
    handle = createApp({
      store: new Proxy({} as Store, {
        get: () => () => Promise.reject(new Error('relation "cli_tokens" does not exist')),
      }),
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      log: (message) => messages.push(message),
    });
    const result = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("cli_tokens");
    expect(messages.join(" ")).toContain("/api/sessions");
  });

  it("still explains a mistake the caller made", async () => {
    const result = await call("POST", "/api/cli/authorize", {
      auth: await idToken(),
      body: { redirect_uri: "https://evil.example.com/callback", code_challenge_method: "S256" },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("loopback");
  });

  it("sends the sandboxing headers on every response", async () => {
    const result = await call("GET", "/api/health");
    expect(result.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(result.headers["X-Frame-Options"]).toBe("DENY");
    expect(result.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("refuses a flood of credential attempts and says when to come back", async () => {
    let refused: { status: number; headers: Record<string, string> } | null = null;
    for (let attempt = 0; attempt < 40 && !refused; attempt += 1) {
      const result = await call("POST", "/api/cli/token", {
        body: { code: `shc_${attempt}`, code_verifier: verifier, redirect_uri: REDIRECT },
        address: "203.0.113.7",
      });
      if (result.status === 429) refused = result;
    }
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("holds one caller's flood against that caller alone", async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await call("POST", "/api/cli/token", {
        body: { code: `shc_${attempt}`, code_verifier: verifier, redirect_uri: REDIRECT },
        address: "203.0.113.8",
      });
    }
    const elsewhere = await call("POST", "/api/cli/authorize", {
      auth: await idToken(),
      address: "198.51.100.4",
      body: {
        redirect_uri: REDIRECT,
        code_challenge: deriveChallenge(verifier),
        code_challenge_method: "S256",
      },
    });
    expect(elsewhere.status).toBe(200);
  });

  /*
   * An agent polls every two seconds and a browser keeps several panes open.
   * Neither may ever meet the limiter.
   */
  it("lets an ordinary signed-in session poll freely", async () => {
    const auth = await idToken();
    for (let poll = 0; poll < 200; poll += 1) {
      expect((await call("GET", "/api/sessions", { auth })).status).toBe(200);
    }
  });

  it("does not believe a forwarded address unless a proxy is trusted", async () => {
    /*
     * Without this, a caller sets X-Forwarded-For to a new value per request
     * and the limiter never sees the same caller twice.
     */
    handle = createApp({
      store: deferred(MemoryStore.memory()),
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      log: () => {},
    });
    let refused = false;
    for (let attempt = 0; attempt < 40 && !refused; attempt += 1) {
      const result = await call("POST", "/api/cli/token", {
        body: { code: `shc_${attempt}`, code_verifier: verifier, redirect_uri: REDIRECT },
        address: "203.0.113.9",
      });
      refused = result.status === 429;
    }
    expect(refused).toBe(true);
  });
});

describe("inviting someone by email", () => {
  function withMailer() {
    const sent: { to: string; subject: string; html: string; text: string }[] = [];
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      webOrigin: "https://app.example.com",
      mailer: { send: async (message) => void sent.push(message) },
      log: () => {},
    });
    return sent;
  }

  it("sends the invitation, with a link that opens this deployment", async () => {
    const sent = withMailer();
    const created = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member", email: "bruno@example.com" },
    });
    expect(created.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("bruno@example.com");
    /* Built from the configured origin, not from whatever host was asked. */
    expect(sent[0].html).toContain(`https://app.example.com/join/${created.body.invite.id}`);
    expect(sent[0].text).toContain(`https://app.example.com/join/${created.body.invite.id}`);
  });

  /* An open link is for handing out in person; there is nowhere to send it. */
  it("sends nothing when the invite has no address", async () => {
    const sent = withMailer();
    const created = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member" },
    });
    expect(created.status).toBe(201);
    expect(sent).toEqual([]);
  });

  /*
   * The link exists whether or not the mail goes out. Failing the request
   * would throw away a perfectly good invite the inviter can still copy.
   */
  it("still creates the invite when the mail provider refuses", async () => {
    const complaints: string[] = [];
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      webOrigin: "https://app.example.com",
      mailer: { send: async () => { throw new Error("from address is not verified"); } },
      log: (message) => complaints.push(message),
    });
    const created = await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member", email: "bruno@example.com" },
    });
    expect(created.status).toBe(201);
    expect(created.body.invite.id).toBeTruthy();
    /* Silence here would mean nobody ever learns the mail is not going out. */
    expect(complaints.join(" ")).toContain("bruno@example.com");
  });

  it("names the organization and the person inviting", async () => {
    const sent = withMailer();
    await call("POST", "/api/org/invites", {
      auth: await idToken(),
      body: { role: "member", email: "bruno@example.com" },
    });
    expect(sent[0].subject).toContain("Ana Ferreira");
    expect(sent[0].html).toMatch(/Join [^<]*<\/a>/);
  });
});

describe("session vault", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t#salt=AAAAAAAAAAAAAAAAAAAAAA",
    command: "claude",
    encrypted: true,
  };

  async function vaultBody(uid = "uid-1") {
    const made = await createVault(uid);
    return {
      made,
      body: {
        public_key: made.bundle.publicKey,
        encrypted_private_key: made.bundle.encryptedPrivateKey,
        recovery_wrap: made.bundle.recoveryWrap,
      },
    };
  }

  /* A token from a sign-in that just happened, which is what a reset asks for. */
  const freshSignIn = (claims: Record<string, unknown> = {}) =>
    idToken({ auth_time: Math.floor(Date.now() / 1000), ...claims });

  it("has none until one is set up", async () => {
    const result = await call("GET", "/api/vault", { auth: await idToken() });
    expect(result).toMatchObject({ status: 200, body: { vault: null } });
  });

  it("keeps the vault it is given and hands it back whole", async () => {
    const { body } = await vaultBody();
    const created = await call("POST", "/api/vault", { auth: await idToken(), body });
    expect(created.status).toBe(201);
    expect((await store.appEvents(0)).find((entry) => entry.event === "vault_created")?.count).toBe(1);
    const fetched = await call("GET", "/api/vault", { auth: await idToken() });
    expect(fetched.body.vault).toMatchObject({
      publicKey: body.public_key,
      encryptedPrivateKey: body.encrypted_private_key,
      recoveryWrap: body.recovery_wrap,
      version: 1,
    });
  });

  it("updates unlock methods without replacing the account key", async () => {
    const { body } = await vaultBody();
    await call("POST", "/api/vault", { auth: await idToken(), body });
    const passwordVault = await createVault("uid-1", "a deliberately long vault password");

    const updated = await call("PATCH", "/api/vault", {
      auth: await freshSignIn(),
      body: { recovery_wrap: passwordVault.bundle.recoveryWrap, version: 1 },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.vault).toMatchObject({
      publicKey: body.public_key,
      encryptedPrivateKey: body.encrypted_private_key,
      recoveryWrap: passwordVault.bundle.recoveryWrap,
      version: 1,
    });
  });

  it("requires a recent sign-in and the current version to change unlock methods", async () => {
    const { body } = await vaultBody();
    await call("POST", "/api/vault", { auth: await idToken(), body });
    const next = await createVault("uid-1", "another deliberately long password");
    const staleAuth = await call("PATCH", "/api/vault", {
      auth: await idToken({ auth_time: Math.floor(Date.now() / 1000) - 3600 }),
      body: { recovery_wrap: next.bundle.recoveryWrap, version: 1 },
    });
    expect(staleAuth).toMatchObject({ status: 403, body: { reauthenticate: true } });
    const staleVersion = await call("PATCH", "/api/vault", {
      auth: await freshSignIn(),
      body: { recovery_wrap: next.bundle.recoveryWrap, version: 9 },
    });
    expect(staleVersion.status).toBe(409);
  });

  it("will not overwrite a vault by setting one up again", async () => {
    await call("POST", "/api/vault", { auth: await idToken(), body: (await vaultBody()).body });
    const again = await call("POST", "/api/vault", { auth: await idToken(), body: (await vaultBody()).body });
    expect(again.status).toBe(409);
  });

  it("refuses a vault that is not shaped like one", async () => {
    const { body } = await vaultBody();
    const result = await call("POST", "/api/vault", {
      auth: await idToken(),
      body: { ...body, recovery_wrap: "too-short" },
    });
    expect(result.status).toBe(400);
  });

  it("keeps each person's vault to themselves", async () => {
    await call("POST", "/api/vault", { auth: await idToken(), body: (await vaultBody()).body });
    const other = await call("GET", "/api/vault", { auth: await idToken({ sub: "uid-2" }) });
    expect(other.body.vault).toBeNull();
  });

  /*
   * A reset puts a new key where colleagues and machines seal passwords, so a
   * token that has merely been refreshed must not be enough for it.
   */
  it("refuses a reset without a recent sign-in", async () => {
    await call("POST", "/api/vault", { auth: await idToken(), body: (await vaultBody()).body });
    const stale = await call("POST", "/api/vault", {
      auth: await idToken({ auth_time: Math.floor(Date.now() / 1000) - 3600 }),
      body: { ...(await vaultBody()).body, replace_version: 1 },
    });
    expect(stale).toMatchObject({ status: 403, body: { reauthenticate: true } });
    const unknown = await call("POST", "/api/vault", {
      auth: await idToken(),
      body: { ...(await vaultBody()).body, replace_version: 1 },
    });
    expect(unknown.status).toBe(403);
  });

  it("replaces the vault on a reset from a fresh sign-in, and counts it", async () => {
    await call("POST", "/api/vault", { auth: await idToken(), body: (await vaultBody()).body });
    const { body } = await vaultBody();
    const reset = await call("POST", "/api/vault", {
      auth: await freshSignIn(),
      body: { ...body, replace_version: 1 },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.vault).toMatchObject({ publicKey: body.public_key, version: 2 });
  });

  it("refuses to reset a vault that changed since the page loaded", async () => {
    await call("POST", "/api/vault", { auth: await idToken(), body: (await vaultBody()).body });
    const reset = await call("POST", "/api/vault", {
      auth: await freshSignIn(),
      body: { ...(await vaultBody()).body, replace_version: 4 },
    });
    expect(reset.status).toBe(409);
  });

  it("tells a linked machine which key to seal to, once there is one", async () => {
    const tokens = await login();
    const before = await call("GET", "/api/account/key", { auth: tokens.access_token });
    expect(before.status).toBe(404);

    const { body } = await vaultBody();
    await call("POST", "/api/vault", { auth: await idToken(), body });
    const after = await call("GET", "/api/account/key", { auth: tokens.access_token });
    expect(after.body).toEqual({ public_key: body.public_key, version: 1 });
  });

  it("does not hand the key to a caller that is not a linked machine", async () => {
    const result = await call("GET", "/api/account/key", { auth: await idToken() });
    expect(result.status).toBe(401);
  });

  it("keeps the CLI's sealed copy of a password as the owner's", async () => {
    const tokens = await login();
    const { made, body } = await vaultBody();
    await call("POST", "/api/vault", { auth: await idToken(), body });
    const share = await sealToAccount(made.bundle.publicKey, session.id, "uid-1", "Kw9eHbru");

    const registered = await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { ...session, owner_share: { sender_public_key: share.senderPublicKey, sealed: share.sealed } },
    });
    expect(registered.status).toBe(201);

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].keyShare).toMatchObject(share);
  });

  it("replaces stale vault copies when the CLI rotates an active password", async () => {
    const tokens = await login();
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: { role: "member" } });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    const { made, body } = await vaultBody();
    await call("POST", "/api/vault", { auth: await idToken(), body });
    const oldShare = await sealToAccount(made.bundle.publicKey, session.id, "uid-1", "old-pass");
    await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { ...session, owner_share: { sender_public_key: oldShare.senderPublicKey, sealed: oldShare.sealed } },
    });
    await call("PUT", `/api/sessions/${session.id}/keys`, {
      auth: await idToken(),
      body: { shares: [{ uid: "uid-2", sender_public_key: "old-sender", sealed: "old-copy" }] },
    });

    const freshShare = await sealToAccount(made.bundle.publicKey, session.id, "uid-1", "new-pass");
    const rotated = await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: {
        ...session,
        share_url: `${session.share_url.slice(0, -22)}BBBBBBBBBBBBBBBBBBBBBB`,
        credential_rotation: true,
        owner_share: { sender_public_key: freshShare.senderPublicKey, sealed: freshShare.sealed },
      },
    });
    expect(rotated.status).toBe(201);
    const owner = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(owner.body.sessions[0].keyShare).toMatchObject(freshShare);
    const other = await call("GET", "/api/sessions", { auth: colleague });
    expect(other.body.sessions[0].keyShare).toBeUndefined();
  });

  it("still registers a session whose sealed copy is not shaped like one", async () => {
    const tokens = await login();
    const registered = await call("POST", "/api/sessions", {
      auth: tokens.access_token,
      body: { ...session, owner_share: { sender_public_key: "junk", sealed: "junk" } },
    });
    expect(registered.status).toBe(201);
    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    expect(listed.body.sessions[0].keyShare).toBeUndefined();
  });

  it("gives colleagues each member's vault key to seal to", async () => {
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: { role: "member" } });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    const { body } = await vaultBody("uid-2");
    await call("POST", "/api/vault", { auth: colleague, body });

    const listed = await call("GET", "/api/sessions", { auth: await idToken() });
    const member = listed.body.members.find((entry: { uid: string }) => entry.uid === "uid-2");
    expect(member.accountKey).toBe(body.public_key);
  });
});

describe("DELETE /api/account", () => {
  /* A token from a sign-in that just happened, which deletion asks for. */
  const freshSignIn = (claims: Record<string, unknown> = {}) =>
    idToken({ auth_time: Math.floor(Date.now() / 1000), ...claims });

  async function remove(claims: Record<string, unknown> = {}, confirm = "ana@example.com") {
    return call("DELETE", "/api/account", { auth: await freshSignIn(claims), body: { confirm } });
  }

  it("asks for the account's email address, typed back", async () => {
    await call("GET", "/api/org", { auth: await idToken() });
    const result = await remove({}, "someone@else.com");
    expect(result.status).toBe(400);
    expect((await call("GET", "/api/org", { auth: await idToken() })).status).toBe(200);
  });

  it("asks for a recent sign-in", async () => {
    const stale = await call("DELETE", "/api/account", {
      auth: await idToken({ auth_time: Math.floor(Date.now() / 1000) - 3600 }),
      body: { confirm: "ana@example.com" },
    });
    expect(stale).toMatchObject({ status: 403, body: { reauthenticate: true } });
  });

  it("removes a lone account with its team and machines", async () => {
    const tokens = await login();
    expect(await devices()).toHaveLength(1);

    const result = await remove();
    expect(result).toMatchObject({ status: 200, body: { deleted: true, owner: null } });

    expect(await devices()).toEqual([]);
    expect((await call("GET", "/api/cli/me", { auth: tokens.access_token })).status).toBe(401);
  });

  it("does not build a new team for a token that outlived its account", async () => {
    await call("GET", "/api/org", { auth: await idToken() });
    await remove();

    expect((await call("GET", "/api/org", { auth: await idToken() })).status).toBe(401);
    expect((await call("GET", "/api/sessions", { auth: await idToken() })).status).toBe(401);
  });

  it("hands the team to its longest-standing admin", async () => {
    const owner = await idToken();
    const forMember = await call("POST", "/api/org/invites", { auth: owner, body: { role: "member" } });
    const forAdmin = await call("POST", "/api/org/invites", { auth: owner, body: { role: "admin" } });
    const member = await idToken({ sub: "uid-2", email: "bo@example.com" });
    const admin = await idToken({ sub: "uid-3", email: "cy@example.com" });
    await call("GET", `/api/org?invite=${forMember.body.invite.id}`, { auth: member });
    await call("GET", `/api/org?invite=${forAdmin.body.invite.id}`, { auth: admin });

    const result = await remove();
    expect(result.body.owner).toMatchObject({ uid: "uid-3", email: "cy@example.com" });

    const view = await call("GET", "/api/org", { auth: admin });
    expect(view.body.you.role).toBe("owner");
    const uids = view.body.members.map((entry: { uid: string }) => entry.uid).sort();
    expect(uids).toEqual(["uid-2", "uid-3"]);
  });

  it("succeeds again when the browser retries", async () => {
    await call("GET", "/api/org", { auth: await idToken() });
    expect((await remove()).status).toBe(200);
    expect((await remove()).status).toBe(200);
  });
});

describe("team audit key", () => {
  const session = {
    id: "qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    share_url: "https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZgF6t",
    command: "claude",
  };

  async function publicKey() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    return base64url(Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)));
  }

  /* A copy the service accepts: t1. and about the size of a sealed PKCS#8 key. */
  function sealedCopy() {
    return `t1.${base64url(randomBytes(166))}`;
  }

  async function sealedEntry() {
    return `a1.1.${await publicKey()}.${base64url(randomBytes(40))}`;
  }

  async function withColleague() {
    await call("GET", "/api/org", { auth: await idToken() });
    const invite = await call("POST", "/api/org/invites", { auth: await idToken(), body: { role: "member" } });
    const colleague = await idToken({ sub: "uid-2", email: "colleague@example.com" });
    await call("GET", `/api/org?invite=${invite.body.invite.id}`, { auth: colleague });
    return colleague;
  }

  async function giveVault(auth: string, uid: string) {
    const made = await createVault(uid);
    await call("POST", "/api/vault", {
      auth,
      body: {
        public_key: made.bundle.publicKey,
        encrypted_private_key: made.bundle.encryptedPrivateKey,
        recovery_wrap: made.bundle.recoveryWrap,
      },
    });
    return made.bundle.publicKey;
  }

  async function makeKey(shares: { uid: string; sealed: string }[]) {
    return call("POST", "/api/team-key", {
      auth: await idToken(),
      body: { public_key: await publicKey(), shares },
    });
  }

  it("has none until a member makes one", async () => {
    const result = await call("GET", "/api/team-key", { auth: await idToken() });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ teamKey: null, share: null, missing: [] });
    expect(result.body.you).toMatchObject({ uid: "uid-1", role: "owner" });
    expect(typeof result.body.you.orgId).toBe("string");
  });

  /* Two browsers making one at once must not both believe theirs is the team's. */
  it("is made once, with the maker's own copy", async () => {
    const copy = sealedCopy();
    const created = await makeKey([{ uid: "uid-1", sealed: copy }]);
    expect(created.status).toBe(201);
    expect(created.body.teamKey).toMatchObject({ version: 1, createdBy: "uid-1" });

    const again = await makeKey([{ uid: "uid-1", sealed: sealedCopy() }]);
    expect(again.status).toBe(409);

    const read = await call("GET", "/api/team-key", { auth: await idToken() });
    expect(read.body.teamKey.publicKey).toBe(created.body.teamKey.publicKey);
    expect(read.body.share).toEqual({ senderUid: "uid-1", sealed: copy, version: 1 });
  });

  it("refuses a key without the maker's copy, with a copy for an outsider, or of the wrong shape", async () => {
    await withColleague();
    expect((await makeKey([{ uid: "uid-2", sealed: sealedCopy() }])).status).toBe(400);
    expect((await makeKey([{ uid: "uid-1", sealed: sealedCopy() }, { uid: "uid-outside", sealed: sealedCopy() }])).status)
      .toBe(400);
    expect((await makeKey([{ uid: "uid-1", sealed: "not a sealed key" }])).status).toBe(400);
    const badKey = await call("POST", "/api/team-key", {
      auth: await idToken(),
      body: { public_key: "not-a-key", shares: [{ uid: "uid-1", sealed: sealedCopy() }] },
    });
    expect(badKey.status).toBe(400);
    expect((await call("GET", "/api/team-key", { auth: await idToken() })).body.teamKey).toBeNull();
  });

  it("hands each member only their own copy, and names who still needs one", async () => {
    const colleague = await withColleague();
    await giveVault(await idToken(), "uid-1");
    const colleagueKey = await giveVault(colleague, "uid-2");
    const mine = sealedCopy();
    await makeKey([{ uid: "uid-1", sealed: mine }]);

    const owner = await call("GET", "/api/team-key", { auth: await idToken() });
    expect(owner.body.missing).toEqual([{ uid: "uid-2", accountKey: colleagueKey }]);
    expect((await call("GET", "/api/team-key", { auth: colleague })).body.share).toBeNull();

    const theirs = sealedCopy();
    const shared = await call("PUT", "/api/team-key/shares", {
      auth: await idToken(),
      body: { version: 1, shares: [{ uid: "uid-2", sealed: theirs }] },
    });
    expect(shared.body).toEqual({ shared: 1 });

    expect((await call("GET", "/api/team-key", { auth: colleague })).body.share)
      .toEqual({ senderUid: "uid-1", sealed: theirs, version: 1 });
    const after = await call("GET", "/api/team-key", { auth: await idToken() });
    expect(after.body.share.sealed).toBe(mine);
    expect(after.body.missing).toEqual([]);
  });

  /* A working copy cannot be replaced with one that does not open. */
  it("never replaces a copy that exists", async () => {
    const colleague = await withColleague();
    await makeKey([{ uid: "uid-1", sealed: sealedCopy() }]);
    const first = sealedCopy();
    const put = async (sealed: string) =>
      call("PUT", "/api/team-key/shares", { auth: await idToken(), body: { version: 1, shares: [{ uid: "uid-2", sealed }] } });
    expect((await put(first)).body.shared).toBe(1);
    expect((await put(sealedCopy())).body.shared).toBe(0);
    expect((await call("GET", "/api/team-key", { auth: colleague })).body.share.sealed).toBe(first);

    const overOwner = await call("PUT", "/api/team-key/shares", {
      auth: colleague,
      body: { version: 1, shares: [{ uid: "uid-1", sealed: sealedCopy() }] },
    });
    expect(overOwner.body.shared).toBe(0);
  });

  it("does not let a member without the team key poison missing shares", async () => {
    const colleague = await withColleague();
    await makeKey([{ uid: "uid-1", sealed: sealedCopy() }]);
    const attempt = await call("PUT", "/api/team-key/shares", {
      auth: colleague,
      body: { version: 1, shares: [{ uid: "uid-2", sealed: sealedCopy() }] },
    });
    expect(attempt.status).toBe(403);
    expect((await call("GET", "/api/team-key", { auth: colleague })).body.share).toBeNull();
  });

  it("refuses copies of a key that is not the current one", async () => {
    await withColleague();
    await makeKey([{ uid: "uid-1", sealed: sealedCopy() }]);
    const stale = await call("PUT", "/api/team-key/shares", {
      auth: await idToken(),
      body: { version: 2, shares: [{ uid: "uid-2", sealed: sealedCopy() }] },
    });
    expect(stale.status).toBe(409);
  });

  /*
   * A member re-seals the copy a teammate sent them to themselves. Deleting it
   * first and adding it back is refused, since by then they hold nothing, and
   * that is how every member but the key's maker kept losing their copy.
   */
  it("lets a member replace only their own copy, and only while they hold one", async () => {
    const colleague = await withColleague();
    await makeKey([{ uid: "uid-1", sealed: sealedCopy() }, { uid: "uid-2", sealed: sealedCopy() }]);
    const mine = sealedCopy();
    const replaced = await call("PUT", "/api/team-key/share", { auth: colleague, body: { version: 1, sealed: mine } });
    expect(replaced.status).toBe(200);
    const view = (await call("GET", "/api/team-key", { auth: colleague })).body.share;
    expect(view).toEqual({ senderUid: "uid-2", sealed: mine, version: 1 });
    /* The owner's copy is untouched. */
    expect((await call("GET", "/api/team-key", { auth: await idToken() })).body.share.senderUid).toBe("uid-1");

    await call("DELETE", "/api/team-key/share", { auth: colleague });
    const afterDelete = await call("PUT", "/api/team-key/share", { auth: colleague, body: { version: 1, sealed: sealedCopy() } });
    expect(afterDelete.status).toBe(403);
    expect((await call("GET", "/api/team-key", { auth: colleague })).body.share).toBeNull();
  });

  it("refuses a replacement for a stale version or in the wrong shape", async () => {
    const colleague = await withColleague();
    await makeKey([{ uid: "uid-1", sealed: sealedCopy() }, { uid: "uid-2", sealed: sealedCopy() }]);
    expect((await call("PUT", "/api/team-key/share", { auth: colleague, body: { version: 2, sealed: sealedCopy() } })).status).toBe(409);
    expect((await call("PUT", "/api/team-key/share", { auth: colleague, body: { version: 1, sealed: "plain" } })).status).toBe(400);
  });

  it("lets a member delete only their own copy", async () => {
    const colleague = await withColleague();
    await makeKey([{ uid: "uid-1", sealed: sealedCopy() }, { uid: "uid-2", sealed: sealedCopy() }]);
    expect((await call("DELETE", "/api/team-key/share", { auth: colleague })).body).toEqual({ deleted: true });
    expect((await call("DELETE", "/api/team-key/share", { auth: colleague })).body).toEqual({ deleted: false });
    expect((await call("GET", "/api/team-key", { auth: colleague })).body.share).toBeNull();
    expect((await call("GET", "/api/team-key", { auth: await idToken() })).body.share).not.toBeNull();
  });

  it("takes a removed member's copy away", async () => {
    await withColleague();
    await makeKey([{ uid: "uid-1", sealed: sealedCopy() }, { uid: "uid-2", sealed: sealedCopy() }]);
    const { orgId } = (await call("GET", "/api/team-key", { auth: await idToken() })).body.you;
    const removed = await call("DELETE", "/api/org/members/uid-2", { auth: await idToken() });
    expect(removed.status).toBe(200);
    expect((await store.teamKeyShares(orgId)).map((share) => share.uid)).toEqual(["uid-1"]);
  });

  describe("sealing what was recorded before", () => {
    async function plaintextRow() {
      const tokens = await login();
      await call("POST", "/api/sessions", { auth: tokens.access_token, body: session });
      const { orgId } = (await call("GET", "/api/team-key", { auth: await idToken() })).body.you;
      await store.putAudit({
        id: "aud_plain",
        orgId,
        sessionId: session.id,
        at: 1000,
        actorUid: "uid-1",
        actorEmail: "ana@example.com",
        kind: "input",
        text: "an old command",
      });
      return orgId as string;
    }

    it("is for an owner or admin only", async () => {
      await plaintextRow();
      const colleague = await withColleague();
      expect((await call("GET", "/api/audit/plaintext", { auth: colleague })).status).toBe(403);
      const attempt = await call("POST", "/api/audit/seal", {
        auth: colleague,
        body: { entries: [{ id: "aud_plain", text: await sealedEntry() }] },
      });
      expect(attempt.status).toBe(403);
    });

    it("replaces plaintext with its sealed form once, and refuses anything else", async () => {
      await plaintextRow();
      const listed = await call("GET", "/api/audit/plaintext", { auth: await idToken() });
      expect(listed.body.events.map((entry: { id: string }) => entry.id)).toEqual(["aud_plain"]);

      const seal = async (text: string) =>
        call("POST", "/api/audit/seal", { auth: await idToken(), body: { entries: [{ id: "aud_plain", text }] } });
      expect((await seal("still plaintext")).body).toEqual({ sealed: 0 });

      const envelope = await sealedEntry();
      expect((await seal(envelope)).body).toEqual({ sealed: 1 });
      expect((await seal(await sealedEntry())).body).toEqual({ sealed: 0 });

      expect((await call("GET", "/api/audit/plaintext", { auth: await idToken() })).body.events).toEqual([]);

      /*
       * A re-sealed entry says who sealed it. Their browser was handed the
       * session, the author and the time by the service, so the entry is only
       * as trustworthy as they are, and it must not read as first-hand.
       */
      const firstHand = await sealedEntry();
      await call("POST", "/api/audit", {
        auth: await idToken(),
        body: { entries: [{ session_id: session.id, kind: "input", text: firstHand, at: 4000 }] },
      });
      const trail = await call("GET", `/api/audit/${session.id}`, { auth: await idToken() });
      const resealed = trail.body.events.find((entry: { id: string }) => entry.id === "aud_plain");
      expect(resealed.text).toBe(envelope);
      expect(resealed.sealedBy).toBe("uid-1");
      const fresh = trail.body.events.find((entry: { text: string }) => entry.text === firstHand);
      expect(fresh.sealedBy).toBeUndefined();

      const page = await call("GET", "/api/audit", { auth: await idToken() });
      expect(page.body.events.find((entry: { id: string }) => entry.id === "aud_plain").sealedBy).toBe("uid-1");
    });
  });
});

describe("feedback", () => {
  it("stores shared-terminal reports through the same authenticated feedback endpoint", async () => {
    const body = {
      kind: "problem", body: "The Report control did not respond.", surface: "shared-terminal",
      route: "/feedback", app_version: "test", can_reply: false, context: {},
    };
    expect((await call("POST", "/api/feedback", { body })).status).toBe(401);
    expect(await store.feedback()).toEqual([]);
    const response = await call("POST", "/api/feedback", { auth: await idToken(), body });
    expect(response.status).toBe(201);
    expect(await store.feedback()).toEqual([expect.objectContaining({
      uid: "uid-1", surface: "shared-terminal", route: "/feedback", body: body.body,
      canReply: false, context: {},
    })]);
  });

  const message = {
    kind: "problem",
    body: "The gate never opened.",
    surface: "session-gate",
    route: "/sessions?open=s1#k3y",
    app_version: "0.15.1",
    can_reply: true,
    context: { host: "laptop", status: "ended" },
  };

  it("keeps a message with who sent it and where from", async () => {
    const posted = await call("POST", "/api/feedback", { auth: await idToken(), body: message });
    expect(posted.status).toBe(201);
    expect(posted.body.feedback.id).toMatch(/^fbk_/);
    /* Counted for the dashboard as a thing done, with nothing about who did it. */
    expect(await store.appEvents(0)).toEqual([{ event: "feedback_sent", count: 1 }]);
    /* Counting must never change an answer: a store that cannot count still answers 201. */
    vi.spyOn(store, "recordAppEvent").mockRejectedValueOnce(new Error("db down"));
    const again = await call("POST", "/api/feedback", { auth: await idToken(), body: message });
    expect(again.status).toBe(201);
    const [kept] = await store.feedback();
    expect(kept).toMatchObject({
      uid: "uid-1",
      email: "ana@example.com",
      kind: "problem",
      body: "The gate never opened.",
      surface: "session-gate",
      route: "/sessions",
      appVersion: "0.15.1",
      canReply: true,
      context: { host: "laptop", status: "ended" },
    });
    expect(kept.orgId).toBeTruthy();
  });

  /*
   * The dashboard reports what customers did. A thing done by one of our own
   * accounts is counted apart, so a week of our own testing cannot read as a
   * week of use.
   */
  it("counts a thing one of our own accounts did apart from the rest", async () => {
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      excludedAccounts: ["ours.example"],
    });
    expect((await call("POST", "/api/feedback", { auth: await idToken(), body: message })).status).toBe(201);
    expect((await call("POST", "/api/feedback", {
      auth: await idToken({ sub: "uid-ours", email: "dev@ours.example", name: "Dev" }),
      body: message,
    })).status).toBe(201);
    expect(await store.appEvents(0)).toEqual([{ event: "feedback_sent", count: 1 }]);
  });

  it("refuses without a signed-in user", async () => {
    const posted = await call("POST", "/api/feedback", { body: message });
    expect(posted.status).toBe(401);
    expect(await store.feedback()).toEqual([]);
  });

  it("refuses an empty message", async () => {
    const posted = await call("POST", "/api/feedback", { auth: await idToken(), body: { ...message, body: "  " } });
    expect(posted.status).toBe(400);
    expect(posted.body.error).toBe("write something first");
  });

  it("stops a flood from one person", async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await call("POST", "/api/feedback", { auth: await idToken(), body: message })).status).toBe(201);
    }
    const sixth = await call("POST", "/api/feedback", { auth: await idToken(), body: message });
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers["Retry-After"])).toBeGreaterThan(0);
    /* Another person is not the flood. */
    const other = await call("POST", "/api/feedback", { auth: await idToken({ sub: "uid-2", email: "bo@example.com" }), body: message });
    expect(other.status).toBe(201);
  });
});

describe("account figures for the statistics dashboard", () => {
  const TOKEN = "stats-token-with-thirty-two-characters!";

  it("does not exist until a token is configured", async () => {
    const answer = await call("GET", "/api/stats/accounts", { auth: TOKEN });
    expect(answer.status).toBe(404);
  });

  it("answers only the configured token, with counts and no identifiers", async () => {
    handle = createApp({ store, verifyIdToken: verifyIdToken as never, allowedOrigins: [ORIGIN], statsToken: TOKEN });
    /* One person signs in, which creates their organization and marks the day. */
    expect((await call("GET", "/api/org", { auth: await idToken() })).status).toBe(200);

    expect((await call("GET", "/api/stats/accounts?range=7d")).status).toBe(401);
    expect((await call("GET", "/api/stats/accounts?range=7d", { auth: "stats-token-with-thirty-two-characters?" })).status).toBe(401);
    expect((await call("GET", "/api/stats/accounts?range=7d", { auth: await idToken() })).status).toBe(401);

    await store.recordAppEvent("machine_linked");
    await store.recordAppEvent("machine_linked");
    await store.recordAppEvent("command_sent");
    const answer = await call("GET", "/api/stats/accounts?range=7d", { auth: TOKEN });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ total: 1, newInRange: 1, activeInRange: 1, events: { machine_linked: 2, command_sent: 1 } });
    /* Only the range's days count; the all-time range counts every day kept. */
    await store.recordAppEvent("vault_created", Date.now() - 40 * 24 * 60 * 60_000);
    const week = await call("GET", "/api/stats/accounts?range=7d", { auth: TOKEN });
    expect(week.body.events).toEqual({ machine_linked: 2, command_sent: 1 });
    const all = await call("GET", "/api/stats/accounts?range=all", { auth: TOKEN });
    expect(all.body.events).toEqual({ machine_linked: 2, command_sent: 1, vault_created: 1 });
    expect(answer.body.newByDay).toHaveLength(90);
    expect(answer.body.cohorts).toHaveLength(1);
    expect(answer.body.cohorts[0].size).toBe(1);
    expect(JSON.stringify(answer.body)).not.toContain("uid-1");
    expect(JSON.stringify(answer.body)).not.toContain("ana@example.com");
  });

  /*
   * Our own accounts are the most active there are and were always going to
   * use the product. Left in, a quiet week reads as a good one, so they are
   * out of the counts and only their number is reported.
   */
  it("leaves our own accounts out of the figures, and says how many it left out", async () => {
    handle = createApp({
      store,
      verifyIdToken: verifyIdToken as never,
      allowedOrigins: [ORIGIN],
      statsToken: TOKEN,
      excludedAccounts: ["ours.example"],
    });
    expect((await call("GET", "/api/org", { auth: await idToken() })).status).toBe(200);
    expect((await call("GET", "/api/org", {
      auth: await idToken({ sub: "uid-ours", email: "dev@ours.example", name: "Dev" }),
    })).status).toBe(200);

    const answer = await call("GET", "/api/stats/accounts?range=7d", { auth: TOKEN });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ total: 1, newInRange: 1, activeInRange: 1, excluded: 1 });
    expect(answer.body.cohorts[0].size).toBe(1);
    expect(JSON.stringify(answer.body)).not.toContain("ours.example");
  });
});
