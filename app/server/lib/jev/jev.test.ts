import assert from "node:assert/strict";
import { test } from "vitest";
import { JEV_ASSESSMENT_TTL_MS, JEV_CONSENT_OFF, createJevIntegration, readJevConsent, type AssessmentSnapshot, type JevStoreHooks } from "./integration";
import { JEV_ENDPOINT, choiceQuestion, createJevProvider } from "./provider";

const choice = (name: string, confidence = 0.9) => {
  const rest = (1 - confidence) / 2;
  return {
    type: "choice",
    choice: name,
    probabilities: { yes: name === "yes" ? confidence : rest, no: name === "no" ? confidence : rest, unknown: name === "unknown" ? confidence : rest },
    confidence,
  };
};

const okBody = (answers: Record<string, unknown>) => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 4 } });

function fakeFetch(handler: (url: string, init: any) => unknown) {
  const calls: { url: string; init: any }[] = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init });
    const value = handler(url, init) as { status: number; body?: unknown };
    return { status: value.status, json: async () => value.body };
  };
  fn.calls = calls;
  return fn;
}

function fakeStore(overrides: Partial<JevStoreHooks> = {}) {
  const consents = new Map<string, any>();
  const snapshots: AssessmentSnapshot[] = [];
  const dropped: string[] = [];
  const hooks: JevStoreHooks = {
    getConsent: async (org, uid) => consents.get(`${org}:${uid}`) ?? null,
    putConsent: async (org, uid, consent, expectedUpdatedAt) => {
      const existing = consents.get(`${org}:${uid}`);
      if ((existing?.updatedAt ?? null) !== expectedUpdatedAt) return null;
      const saved = { ...consent, updatedAt: Math.max(consent.updatedAt, (existing?.updatedAt ?? 0) + 1) };
      consents.set(`${org}:${uid}`, saved);
      return saved;
    },
    liveOwnerSession: async () => true,
    putAssessmentIfConsented: async (org, uid, snapshot, expectedUpdatedAt) => {
      const existing = await hooks.getConsent(org, uid);
      if (!existing?.externalAnalysis || existing.updatedAt !== expectedUpdatedAt) return false;
      snapshots.push(snapshot);
      return true;
    },
    listAssessments: async () => [...snapshots],
    dropAssessments: async (_org, _uid, ids) => { dropped.push(...ids); return ids.length; },
    clearAssessments: async () => { const count = snapshots.length; snapshots.length = 0; return count; },
    consumeBudget: async () => true,
  };
  Object.assign(hooks, overrides);
  return { store: hooks, consents, snapshots, dropped };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  orgId: "org-1", ownerUid: "owner-1", sessionId: "session-1", generation: 1,
  excerpt: "The build failed: missing dependency.", observed: { flows: 2, outcomes: { delivered: 1 } },
  ...overrides,
});

function integration(fetchImpl: any, store: JevStoreHooks, extra: Record<string, unknown> = {}) {
  return createJevIntegration({ env: { JEV_API_KEY: "test-key" }, store, fetchImpl, now: () => 1_000_000, ...extra });
}

test("disabled without the deployment secret: no request, unavailable", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody({}) }));
  const { store } = fakeStore();
  const jev = createJevIntegration({ env: {}, store, fetchImpl, now: () => 1_000_000 });
  assert.equal(jev.configured, false);
  assert.deepEqual(await jev.assess(input()), { ok: false, reason: "unavailable" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("fixed destination, redirect refused, server-side bearer only", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 302 }));
  const { store } = fakeStore({ getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }) });
  const jev = integration(fetchImpl, store);
  assert.deepEqual(await jev.assess(input()), { ok: false, reason: "redirect_refused" });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, JEV_ENDPOINT);
  assert.equal(call.init.redirect, "manual");
  assert.equal(call.init.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(call.init.body).model, "jev-1.13.0");
});

test("a hung provider times out on the injected timer", async () => {
  const timers: { fire?: () => void } = {};
  const jev = integration(
    () => new Promise(() => {}),
    fakeStore({ getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }) }).store,
    { setTimeoutImpl: (fn: () => void) => { timers.fire = fn; return 1; }, clearTimeoutImpl: () => {} },
  );
  const pending = jev.assess(input());
  /* Let consent and authorization settle so the provider has registered its timer. */
  await new Promise((resolve) => setTimeout(resolve, 0));
  (timers.fire as (() => void) | undefined)?.();
  assert.deepEqual(await pending, { ok: false, reason: "timeout" });
});

test("provider statuses map to distinct reasons", async () => {
  for (const [status, reason] of [[429, "rate_limited"], [529, "overloaded"], [500, "provider_error"]]) {
    const { store } = fakeStore({ getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }) });
    const jev = integration(fakeFetch(() => ({ status })), store);
    assert.deepEqual(await jev.assess(input()), { ok: false, reason });
  }
});

test("an error response closes its unread body and aborts the transport", async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const provider = createJevProvider({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      signal = init.signal as AbortSignal;
      return { status: 429, body, json: async () => assert.fail("must not parse error body") };
    },
  });
  const result = await provider.assess({ state: "short state", questions: {
    attention: choiceQuestion("Needs attention?", { yes: "Yes", no: "No", unknown: "Unknown" }),
  } });
  assert.deepEqual(result, { ok: false, reason: "rate_limited" });
  assert.equal(cancelled, true);
  assert.equal(signal?.aborted, true);
});

test("consent is off by default, strict, and required before any request", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody({}) }));
  const { store } = fakeStore();
  const jev = integration(fetchImpl, store);
  assert.deepEqual(await jev.getConsent("org-1", "owner-1"), JEV_CONSENT_OFF);
  assert.deepEqual(await jev.assess(input()), { ok: false, reason: "consent_required" });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(readJevConsent({ externalAnalysis: "yes", updatedAt: 1, updatedBy: "x" }), null);
  assert.deepEqual(await jev.putConsent("org-1", "owner-1", "yes", "owner-1"), { ok: false, reason: "invalid_consent" });
  const put = await jev.putConsent("org-1", "owner-1", true, "owner-1");
  assert.equal(put.ok, true);
  assert.equal((await jev.getConsent("org-1", "owner-1")).externalAnalysis, true);
});

test("a session that is not live and owned is never assessed", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody({}) }));
  const { store } = fakeStore({
    getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }),
    liveOwnerSession: async () => false,
  });
  assert.deepEqual(await integration(fetchImpl, store).assess(input()), { ok: false, reason: "access_denied" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("a real assessment is labeled inferred-not-verified and stores observed facts unchanged", async () => {
  const fetchImpl = fakeFetch(() => ({
    status: 200,
    body: okBody({ blocker_reported: choice("yes"), human_input_requested: choice("no"), review_claimed_ready: choice("no") }),
  }));
  const { store, snapshots } = fakeStore({ getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }) });
  const jev = integration(fetchImpl, store);
  const result = await jev.assess(input({ excerpt: "The build failed. Authorization: Bearer sk-live-SECRET-123" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.model.kind, "advisory");
  if (result.snapshot.model.kind !== "advisory") return;
  assert.deepEqual(result.snapshot.model.labels, ["needs_attention"]);
  assert.equal(result.snapshot.model.verified, false);
  assert.equal(result.snapshot.expiresAt, 1_000_000 + JEV_ASSESSMENT_TTL_MS);
  assert.deepEqual(result.snapshot.observed, { flows: 2, outcomes: { delivered: 1 } });
  /* Redaction before the provider sees anything, and no secret in the body. */
  const body = fetchImpl.calls[0].init.body as string;
  assert.ok(body.includes("[redacted]"));
  assert.ok(!body.includes("sk-live-SECRET-123"));
  assert.equal(snapshots.length, 1);
  assert.ok(!JSON.stringify(snapshots[0]).includes("sk-live"));
});

test("low confidence and malformed answers are no_signal, never a label", async () => {
  const low = fakeFetch(() => ({ status: 200, body: okBody({ blocker_reported: choice("yes", 0.4) }) }));
  const { store } = fakeStore({ getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }) });
  const lowResult = await integration(low, store).assess(input());
  assert.equal(lowResult.ok, true);
  if (lowResult.ok) assert.deepEqual(lowResult.snapshot.model, { kind: "unknown", reason: "no_signal" });

  const broken = fakeFetch(() => ({ status: 200, body: okBody({ blocker_reported: { type: "choice", choice: "yes", probabilities: { yes: Number.NaN, no: 0.5, unknown: 0.5 }, confidence: 0.9 } }) }));
  const brokenResult = await integration(broken, fakeStore({ getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }) }).store).assess(input());
  assert.equal(brokenResult.ok, true);
  if (brokenResult.ok) assert.equal(brokenResult.snapshot.model.kind, "unknown");
});

test("a rate cap refuses further calls in the window", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody({ blocker_reported: choice("no") }) }));
  const { store } = fakeStore({ getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }) });
  const jev = integration(fetchImpl, store, { limits: { maxRequests: 1, windowMs: 60_000 } });
  const first = await jev.assess(input());
  const second = await jev.assess(input());
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "rate_capped" });
  assert.equal(fetchImpl.calls.length, 1);
});

test("listing drops expired snapshots and cleans them up", async () => {
  const { store, snapshots, dropped } = fakeStore({
    getConsent: async () => readJevConsent({ externalAnalysis: true, updatedAt: 1, updatedBy: "owner-1" }),
  });
  snapshots.push(
    { sessionId: "session-live", generation: 1, observedAt: 1, expiresAt: 1_000_001, model: { kind: "unknown", reason: "no_signal" }, observed: {}, disclaimer: "" },
    { sessionId: "session-expired", generation: 1, observedAt: 1, expiresAt: 999_999, model: { kind: "unknown", reason: "no_signal" }, observed: {}, disclaimer: "" },
  );
  const jev = integration(fakeFetch(() => ({ status: 200 })), store);
  const rows = await jev.list("org-1", "owner-1");
  assert.deepEqual(rows.map((row) => row.sessionId), ["session-live"]);
  assert.deepEqual(dropped, ["session-expired"]);
});

test("the integration exports no action-shaped surface", async () => {
  const module = await import("./integration");
  for (const name of Object.keys(module)) {
    assert.ok(!/(send|input|approve|deploy|grant|revoke|restart|kill|permission|write|press)/i.test(name), `action-shaped export: ${name}`);
  }
});

test("a held response body is bounded by the same deadline and the slot is released", async () => {
  let cancelled = false;
  const held = new ReadableStream<Uint8Array>({
    start() { /* never enqueues, never closes: the body is held open */ },
    cancel() { cancelled = true; },
  });
  let mode: "held" | "ok" = "held";
  const fetchImpl = async () => (mode === "held"
    ? { status: 200, body: held, json: async () => ({}) }
    : { status: 200, body: null, json: async () => okBody({}) });
  const provider = createJevProvider({
    apiKey: "test-key",
    fetchImpl,
    now: () => 1_000_000,
    limits: { timeoutMs: 30, maxResponseBytes: 1024 },
  });
  const questions = { blocker_reported: choiceQuestion("Blocked?", { yes: "y", no: "n", unknown: "u" }) };
  const first = await provider.assess({ state: "short state", questions });
  assert.deepEqual(first, { ok: false, reason: "timeout" });
  assert.equal(cancelled, true, "the held upstream body must be cancelled");
  mode = "ok";
  const second = await provider.assess({ state: "short state", questions });
  assert.equal(second.ok, true, "the in-flight slot must be released after a timeout");
});

test("an oversized response body is refused, aborted and the slot is released", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(64).fill(0x61);
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  let mode: "big" | "ok" = "big";
  const fetchImpl = async () => (mode === "big"
    ? { status: 200, body: oversized, json: async () => ({}) }
    : { status: 200, body: null, json: async () => okBody({}) });
  const provider = createJevProvider({
    apiKey: "test-key",
    fetchImpl,
    now: () => 1_000_000,
    limits: { maxResponseBytes: 32 },
  });
  const questions = { blocker_reported: choiceQuestion("Blocked?", { yes: "y", no: "n", unknown: "u" }) };
  const first = await provider.assess({ state: "short state", questions });
  assert.deepEqual(first, { ok: false, reason: "oversize" });
  assert.equal(cancelled, true, "the oversized upstream body must be cancelled");
  mode = "ok";
  const second = await provider.assess({ state: "short state", questions });
  assert.equal(second.ok, true, "the in-flight slot must be released after an oversize refusal");
});
