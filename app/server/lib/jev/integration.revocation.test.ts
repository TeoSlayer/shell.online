import { describe, expect, it } from "vitest";
import {
  createJevIntegration,
  JEV_ASSESSMENT_TTL_MS,
  type AssessmentSnapshot,
  type JevConsent,
  type JevStoreHooks,
} from "./integration";

const okBody = { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 10, output_tokens: 4 } };

function fakeFetch(handler: (call: number) => unknown | Promise<unknown>) {
  const calls: RequestInit[] = [];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    calls.push(init);
    const result = (await handler(calls.length)) as { status: number; body?: unknown; wait?: Promise<void> };
    if (result.wait) await result.wait;
    return { status: result.status, json: async () => result.body };
  };
  return { fetchImpl, calls };
}

interface Row extends AssessmentSnapshot {
  orgId: string;
  ownerUid: string;
}

function memoryStore() {
  const consents = new Map<string, JevConsent>();
  const rows: Row[] = [];
  const listGate = { gate: null as Promise<void> | null, started: false };
  const live = new Map<string, boolean>();
  const budget = { allow: true, calls: 0, gate: null as Promise<void> | null };
  const dropped: string[] = [];
  const store: JevStoreHooks = {
    getConsent: async (orgId, ownerUid) => consents.get(`${orgId}:${ownerUid}`) ?? null,
    putConsent: async (orgId, ownerUid, consent, expectedUpdatedAt) => {
      const existing = consents.get(`${orgId}:${ownerUid}`);
      if ((existing?.updatedAt ?? null) !== expectedUpdatedAt) return null;
      const saved = { ...consent, updatedAt: Math.max(consent.updatedAt, (existing?.updatedAt ?? 0) + 1) };
      consents.set(`${orgId}:${ownerUid}`, saved);
      return saved;
    },
    liveOwnerSession: async (orgId, ownerUid, sessionId) => live.get(`${orgId}:${ownerUid}:${sessionId}`) ?? false,
    putAssessmentIfConsented: async (orgId, ownerUid, snapshot, expectedUpdatedAt) => {
      const existing = consents.get(`${orgId}:${ownerUid}`);
      if (!existing?.externalAnalysis || existing.updatedAt !== expectedUpdatedAt) return false;
      if (!(live.get(`${orgId}:${ownerUid}:${snapshot.sessionId}`) ?? false)) return false;
      rows.push({ ...snapshot, orgId, ownerUid });
      return true;
    },
    listAssessments: async (orgId, ownerUid) => {
      if (listGate.gate) {
        listGate.started = true;
        await listGate.gate;
      }
      return rows.filter((row) => row.orgId === orgId && row.ownerUid === ownerUid);
    },
    dropAssessments: async (_orgId, _ownerUid, sessionIds) => {
      dropped.push(...sessionIds);
      for (const id of sessionIds) {
        const index = rows.findIndex((row) => row.sessionId === id);
        if (index >= 0) rows.splice(index, 1);
      }
      return sessionIds.length;
    },
    clearAssessments: async (orgId, ownerUid) => {
      const kept = rows.filter((row) => row.orgId !== orgId || row.ownerUid !== ownerUid);
      const removed = rows.length - kept.length;
      dropped.push(...rows.filter((row) => row.orgId === orgId && row.ownerUid === ownerUid).map((row) => row.sessionId));
      rows.splice(0, rows.length, ...kept);
      return removed;
    },
    consumeBudget: async () => {
      budget.calls += 1;
      if (budget.gate) await budget.gate;
      return budget.allow;
    },
  };
  return { store, consents, rows, live, budget, dropped, listGate };
}

const consentOn = (at = 1): JevConsent => ({ externalAnalysis: true, updatedAt: at, updatedBy: "owner" });

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out: ${label}`);
}

function noBudgetStore() {
  const { store, ...rest } = memoryStore();
  const hooks = { ...store } as Record<string, unknown>;
  delete hooks.consumeBudget;
  return { store: hooks as unknown as JevStoreHooks, ...rest };
}
const snapshot = (sessionId: string, at: number): AssessmentSnapshot => ({
  sessionId,
  generation: 0,
  observedAt: at,
  expiresAt: at + JEV_ASSESSMENT_TTL_MS,
  model: { kind: "unknown", reason: "no_signal" },
  observed: {},
  disclaimer: "Advisory model inference, unverified.",
});

const input = { orgId: "org", ownerUid: "owner", sessionId: "s1", generation: 0, excerpt: "visible pane text" };

function integration(fetchImpl: unknown, hooks: JevStoreHooks, extra: Record<string, unknown> = {}) {
  return createJevIntegration({ env: { JEV_API_KEY: "test-key" }, store: hooks, fetchImpl: fetchImpl as never, now: () => 1_000_000, ...extra });
}

describe("revocation and access-loss races", () => {
  it("drops an in-flight assessment when consent is revoked before the provider returns", async () => {
    const { store, consents, live, rows } = memoryStore();
    consents.set("org:owner", consentOn(1));
    live.set("org:owner:s1", true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = async () => {
      await gate;
      return { status: 200, json: async () => okBody };
    };
    const jev = integration(fetchImpl, store);
    const pending = jev.assess(input);
    await jev.putConsent("org", "owner", false, "owner");
    release();
    expect(await pending).toEqual({ ok: false, reason: "consent_revoked" });
    expect(rows).toHaveLength(0);
  });

  it("drops an in-flight assessment when the session stops being live/owned", async () => {
    const { store, consents, live } = memoryStore();
    consents.set("org:owner", consentOn(1));
    live.set("org:owner:s1", true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight!: () => void;
    const called = new Promise<void>((resolve) => (inFlight = resolve));
    const fetchImpl = async () => {
      inFlight();
      await gate;
      return { status: 200, json: async () => okBody };
    };
    const jev = integration(fetchImpl, store);
    const pending = jev.assess(input);
    await called; /* both pre-flight gates passed; the request is in flight */
    live.set("org:owner:s1", false);
    release();
    expect(await pending).toEqual({ ok: false, reason: "access_revoked" });
  });
});

describe("list-time revalidation and purge", () => {
  it("returns nothing and deletes cached rows once consent is off", async () => {
    const { store, consents, live, rows, dropped } = memoryStore();
    live.set("org:owner:s1", true);
    consents.set("org:owner", consentOn(5));
    const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody }));
    const jev = integration(fetchImpl.fetchImpl, store);
    await jev.assess(input);
    expect(rows).toHaveLength(1);
    await jev.putConsent("org", "owner", false, "owner");
    expect(await jev.list("org", "owner")).toEqual([]);
    expect(rows).toHaveLength(0);
    expect(dropped).toContain("s1");
  });

  it("drops cached rows for sessions that are no longer live or owned", async () => {
    const { store, consents, live, rows } = memoryStore();
    live.set("org:owner:s1", true);
    consents.set("org:owner", consentOn(5));
    await store.putAssessmentIfConsented("org", "owner", snapshot("s1", 1_000_000), 5);
    const jev = integration(fakeFetch(() => ({ status: 200, body: okBody })).fetchImpl, store);
    live.set("org:owner:s1", false);
    expect(await jev.list("org", "owner")).toEqual([]);
    expect(rows).toHaveLength(0);
  });
});

describe("disabling consent purges immediately", () => {
  it("deletes cached rows in putConsent(false)", async () => {
    const { store, consents, rows } = memoryStore();
    consents.set("org:owner", consentOn(5));
    await store.putAssessmentIfConsented("org", "owner", snapshot("s1", 1_000_000), 5);
    const jev = integration(fakeFetch(() => ({ status: 200, body: okBody })).fetchImpl, store);
    await jev.putConsent("org", "owner", false, "owner");
    expect(rows).toHaveLength(0);
  });
});

describe("the budget wait is also a revocation window", () => {
  it("dispatches nothing when consent is revoked while the reservation is pending", async () => {
    const { store, consents, live, budget } = memoryStore();
    consents.set("org:owner", consentOn(1));
    live.set("org:owner:s1", true);
    let release!: () => void;
    budget.gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody }));
    const jev = integration(fetchImpl.fetchImpl, store);
    const pending = jev.assess(input);
    await until(() => budget.calls === 1, "budget reservation in flight");
    await jev.putConsent("org", "owner", false, "owner");
    release();
    expect(await pending).toEqual({ ok: false, reason: "consent_revoked" });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("dispatches nothing when the session leaves ownership while the reservation is pending", async () => {
    const { store, consents, live, budget } = memoryStore();
    consents.set("org:owner", consentOn(1));
    live.set("org:owner:s1", true);
    let release!: () => void;
    budget.gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody }));
    const jev = integration(fetchImpl.fetchImpl, store);
    const pending = jev.assess(input);
    await until(() => budget.calls === 1, "budget reservation in flight");
    live.set("org:owner:s1", false);
    release();
    expect(await pending).toEqual({ ok: false, reason: "access_revoked" });
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe("a revoke that lands inside an already-started read", () => {
  it("serves nothing and clears the stored rows", async () => {
    const { store, consents, live, rows, listGate } = memoryStore();
    consents.set("org:owner", consentOn(5));
    live.set("org:owner:s1", true);
    await store.putAssessmentIfConsented("org", "owner", snapshot("s1", 100), 5);
    expect(rows).toHaveLength(1);
    let release!: () => void;
    listGate.gate = new Promise<void>((resolve) => (release = resolve));
    const jev = integration(fakeFetch(() => ({ status: 200, body: okBody })).fetchImpl, store);
    const pending = jev.list("org", "owner");
    await until(() => listGate.started, "list read in flight");
    await jev.putConsent("org", "owner", false, "owner");
    release();
    expect(await pending).toEqual([]);
    expect(rows).toHaveLength(0);
  });
});

describe("distributed budget and strict metadata", () => {
  it("denies before any outbound request when the store budget refuses", async () => {
    const { store, consents, live, budget } = memoryStore();
    consents.set("org:owner", consentOn(5));
    live.set("org:owner:s1", true);
    budget.allow = false;
    const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody }));
    const jev = integration(fetchImpl.fetchImpl, store);
    expect(await jev.assess(input)).toEqual({ ok: false, reason: "budget_exceeded" });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(budget.calls).toBe(1);
  });

  it("refuses, not falls back, when the store cannot enforce the shared budget", async () => {
    const { store, consents, live } = noBudgetStore();
    consents.set("org:owner", consentOn());
    live.set("org:owner:s1", true);
    const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody }));
    const jev = integration(fetchImpl.fetchImpl, store);
    expect(await jev.assess(input)).toEqual({ ok: false, reason: "budget_unavailable" });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("sends only allowlisted bounded metadata, never nested junk", async () => {
    const { store, consents, live } = memoryStore();
    consents.set("org:owner", consentOn(5));
    live.set("org:owner:s1", true);
    const fetchImpl = fakeFetch(() => ({ status: 200, body: okBody }));
    const jev = integration(fetchImpl.fetchImpl, store);
    await jev.assess({
      ...input,
      observed: {
        flows: 3,
        processState: "running",
        secretJunk: "should never leave",
        nested: { command: "rm -rf /", deep: { x: "y" } },
      },
    });
    const body = String(fetchImpl.calls[0].body);
    const outer = JSON.parse(body) as { state: string };
    const state = JSON.parse(outer.state) as { observed: Record<string, unknown> };
    expect(state.observed.flows).toBe(3);
    expect(body).not.toContain("secretJunk");
    expect(body).not.toContain("rm -rf");
  });
});
