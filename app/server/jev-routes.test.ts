import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type KeyObject } from "jose";
import { createApp } from "./app";
import { MemoryStore } from "./lib/store-memory";
import { deferred } from "./lib/store-deferred";
import type { Store } from "./lib/store";
import { createVerifier, localKeySet } from "./lib/firebase-token";
import type { SessionRecord } from "./lib/types";

const PROJECT = "test-firebase-project";
const ORIGIN = "http://localhost:5173";

let privateKey: KeyObject;
let verifyIdToken: (token: string) => Promise<{ ok: boolean }>;
let store: Store;

async function idToken(sub = "uid-1") {
  return new SignJWT({ email: "ana@example.com", name: "Ana Ferreira", email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(`https://securetoken.google.com/${PROJECT}`)
    .setAudience(PROJECT)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function call(
  handle: ReturnType<typeof createApp>,
  method: string,
  path: string,
  options: { body?: unknown; auth?: string } = {},
) {
  const chunks: Buffer[] = [];
  if (options.body !== undefined) chunks.push(Buffer.from(JSON.stringify(options.body)));
  const request = {
    method,
    url: path,
    headers: options.auth ? { authorization: `Bearer ${options.auth}` } : {},
    socket: { remoteAddress: "10.0.0.1" },
    on(event: string, handler: (arg?: unknown) => void) {
      if (event === "data") chunks.forEach((chunk) => handler(chunk));
      if (event === "end") handler();
      return request;
    },
    destroy() {},
  };
  let status = 0;
  let payload = "";
  const response = {
    writeHead(code: number) {
      status = code;
      return response;
    },
    setHeader() {},
    end(body?: string) {
      payload = body ?? "";
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handle(request as any, response as any);
  return { status, body: payload ? JSON.parse(payload) : null };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess001",
    uid: "uid-1",
    orgId: "org_1",
    ownerUid: "uid-1",
    assigneeUid: "uid-1",
    shareUrl: "https://shell.online/s/s1",
    command: "htop",
    readOnly: false,
    encrypted: true,
    persistent: false,
    host: "laptop",
    startedAt: 1000,
    ...overrides,
  };
}

const choice = (name: string, confidence = 0.9) => {
  const rest = (1 - confidence) / 2;
  return {
    type: "choice",
    choice: name,
    probabilities: { yes: name === "yes" ? confidence : rest, no: name === "no" ? confidence : rest, unknown: name === "unknown" ? confidence : rest },
    confidence,
  };
};

const okBody = { model: "jev-1.13.0", answers: { blocker_reported: choice("yes") }, usage: { input_tokens: 1, output_tokens: 1 } };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as KeyObject;
  const jwk = await exportJWK(pair.publicKey);
  verifyIdToken = createVerifier(PROJECT, localKeySet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] })) as never;
});

beforeEach(() => {
  store = deferred(MemoryStore.memory());
  vi.unstubAllGlobals();
});

function app(jevApiKey: string | null = "test-key") {
  return createApp({ store, verifyIdToken: verifyIdToken as never, allowedOrigins: [ORIGIN], jevApiKey });
}

describe("external-analysis consent route", () => {
  it("is off by default, validates the body, and persists a revoke", async () => {
    const handle = app();
    const auth = await idToken();
    const before = await call(handle, "GET", "/api/game/assessments", { auth });
    expect(before.status).toBe(200);
    expect(before.body.consent).toEqual({ externalAnalysis: false, updatedAt: 0 });
    expect(before.body.assessments).toEqual([]);

    const bad = await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: "yes" } });
    expect(bad.status).toBe(400);

    const enabled = await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: true } });
    expect(enabled.status).toBe(200);
    expect(enabled.body.externalAnalysis).toBe(true);

    const revoked = await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: false } });
    expect(revoked.status).toBe(200);
    expect(revoked.body.externalAnalysis).toBe(false);
  });
});

describe("user-initiated assessment route", () => {
  async function provision() {
    const handle = app();
    const auth = await idToken();
    /* One authenticated call creates the membership; the session has to live
       in that same organization for the owner check to see it. */
    await call(handle, "GET", "/api/game/assessments", { auth });
    const membership = await store.membershipOf("uid-1");
    const orgId = membership!.orgId;
    await store.upsertSession(session({ orgId }));
    return { handle, auth, orgId };
  }

  it("refuses without consent, and refuses a session the caller does not own", async () => {
    const { handle, auth, orgId } = await provision();
    const noConsent = await call(handle, "POST", "/api/game/sessions/sess001/assess", { auth, body: {} });
    expect(noConsent.status).toBe(403);
    expect(noConsent.body.error).toBe("consent_required");

    await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: true } });
    await store.upsertSession(session({ id: "sess002", uid: "uid-2", ownerUid: "uid-2", orgId }));
    const foreign = await call(handle, "POST", "/api/game/sessions/sess002/assess", { auth, body: {} });
    expect(foreign.status).toBe(404);
  });

  it("answers unavailable when the deployment has no secret", async () => {
    const handle = app(null);
    const auth = await idToken();
    await call(handle, "GET", "/api/game/assessments", { auth });
    const membership = await store.membershipOf("uid-1");
    await store.upsertSession(session({ orgId: membership!.orgId }));
    await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: true } });
    const result = await call(handle, "POST", "/api/game/sessions/sess001/assess", { auth, body: {} });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("unavailable");
  });

  it("stores an inferred snapshot on a synthetic provider answer and serves it with its source age", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => okBody }));
    vi.stubGlobal("fetch", fetchImpl);
    const { handle, auth } = await provision();
    await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: true } });

    const result = await call(handle, "POST", "/api/game/sessions/sess001/assess", {
      auth,
      body: { excerpt: "The build failed: Authorization: Bearer sk-live-SECRET", observed: { flows: 1 } },
    });
    expect(result.status).toBe(200);
    expect(result.body.assessment.sessionId).toBe("sess001");
    expect(result.body.assessment.model.verified).toBe(false);
    expect(result.body.assessment.model.labels).toEqual(["needs_attention"]);
    expect(result.body.assessment.observed).toEqual({ flows: 1 });

    const list = await call(handle, "GET", "/api/game/assessments", { auth });
    expect(list.body.assessments).toHaveLength(1);
    expect(list.body.assessments[0].observedAt).toBeGreaterThan(0);

    /* Revocation clears the served set and refuses the next request. */
    await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: false } });
    const after = await call(handle, "GET", "/api/game/assessments", { auth });
    expect(after.body.assessments).toEqual([]);
    const refused = await call(handle, "POST", "/api/game/sessions/sess001/assess", { auth, body: {} });
    expect(refused.status).toBe(403);
  });

  it("rejects malformed bodies without reaching a provider", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const { handle, auth } = await provision();
    await call(handle, "PUT", "/api/game/assessments/consent", { auth, body: { enabled: true } });
    for (const body of [{ extra: 1 }, { excerpt: 42 }, { generation: -1 }, { observed: [] }]) {
      const result = await call(handle, "POST", "/api/game/sessions/sess001/assess", { auth, body });
      expect(result.status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
