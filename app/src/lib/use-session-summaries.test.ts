import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "./api";
import type { SessionSummary } from "./session-summary-crypto";

// Same controlled hook scheduler as the session-content hook test.
const harness = vi.hoisted(() => ({
  value: undefined as unknown,
  dependencies: undefined as readonly unknown[] | undefined,
  pending: undefined as (() => void | (() => void)) | undefined,
  cleanup: undefined as (() => void) | undefined,
  request: vi.fn(),
  vault: { uid: "owner", status: "unlocked", version: 1, publicKey: "owner-key", openSummary: vi.fn() },
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    if (harness.value === undefined) harness.value = initial;
    return [harness.value, (value: unknown) => { harness.value = value; }];
  },
  useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => {
    if (!harness.dependencies || dependencies.some((value, index) => value !== harness.dependencies![index])) {
      harness.dependencies = dependencies;
      harness.pending = effect;
    }
  },
}));
vi.mock("./api", () => ({ request: harness.request }));
vi.mock("../vault/VaultProvider", () => ({ useVault: () => harness.vault }));

import { summaryEligible, useSessionSummaries } from "./use-session-summaries";

const summary: SessionSummary = { version: 1, title: "Tests passing", summary: "212 passed.", state: "idle", source: "enclave", observedAt: 1_800_000_000_000 };
const envelope = { generation: "g", observedAt: summary.observedAt, senderPublicKey: "sender", sealed: "ss1.synthetic" };
function session(extra: Partial<SessionRecord> = {}): SessionRecord {
  return { id: "s1", ownerUid: "owner", summariesEnabled: true, shareUrl: "https://example.test/s/s1", command: "npm run dev", readOnly: false, encrypted: true, persistent: false, host: "synthetic", startedAt: 1, ...extra } as SessionRecord;
}
function commit() {
  if (!harness.pending) return;
  harness.cleanup?.();
  const effect = harness.pending;
  harness.pending = undefined;
  harness.cleanup = effect() || undefined;
}
function render(sessions: SessionRecord[] | null, effects = true) {
  const result = useSessionSummaries(sessions);
  if (effects) commit();
  return result;
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers();
  harness.value = undefined; harness.dependencies = undefined; harness.pending = undefined; harness.cleanup = undefined;
  harness.request.mockReset().mockResolvedValue(envelope);
  harness.vault = { uid: "owner", status: "unlocked", version: 1, publicKey: "owner-key", openSummary: vi.fn().mockResolvedValue(summary) };
});
afterEach(() => { harness.cleanup?.(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("session summaries", () => {
  it("are only for the owner who consented, independent of daily briefings", () => {
    expect(summaryEligible(session(), "owner")).toBe(true);
    for (const record of [session({ summariesEnabled: false }), session({ summariesEnabled: undefined, dailyBriefingEnabled: true }),
      session({ ownerUid: "another", assigneeUid: "owner", assigneeUids: ["owner"] })]) expect(summaryEligible(record, "owner")).toBe(false);
    expect(summaryEligible(session(), "")).toBe(false);
  });

  it("makes no request while locked or for sessions that are not eligible", async () => {
    render([session({ summariesEnabled: false }), session({ id: "other", ownerUid: "another" })]); await settle();
    expect(harness.request).not.toHaveBeenCalled();
    harness.vault.status = "locked";
    render([session()]); await settle();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.vault.openSummary).not.toHaveBeenCalled();
  });

  it("reads the published envelope, decrypts it and polls", async () => {
    expect(render([session()])).toEqual({}); await settle();
    expect(render([session()])).toEqual({ s1: summary });
    expect(harness.request).toHaveBeenCalledWith("/api/sessions/s1/summary", expect.anything());
    expect(harness.vault.openSummary).toHaveBeenCalledWith("s1", envelope);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(2);
  });

  it.each(["lock", "disable", "uid", "vault key"])("hides decrypted summaries synchronously on %s", async (change) => {
    render([session()]); await settle();
    expect(render([session()])).toEqual({ s1: summary });
    let records = [session()];
    if (change === "lock") harness.vault.status = "locked";
    if (change === "disable") records = [session({ summariesEnabled: false })];
    if (change === "uid") harness.vault.uid = "someone-else";
    if (change === "vault key") harness.vault.publicKey = "rotated";
    expect(render(records, false)).toEqual({});
  });

  it("shows nothing when the envelope fails to open or the guard rejects it", async () => {
    harness.vault.openSummary.mockResolvedValue(null);
    render([session()]); await settle();
    expect(render([session()])).toEqual({});
  });
});
