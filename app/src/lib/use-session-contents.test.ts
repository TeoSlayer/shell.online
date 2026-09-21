import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "./api";
import type { SessionContent } from "./session-content-crypto";

// A controlled hook scheduler exercises the actual effect and async callbacks
// without adding a DOM dependency. Renders and passive-effect commits are
// separate so privacy gating is tested before cleanup has had a chance to run.
const harness = vi.hoisted(() => ({
  value: undefined as unknown,
  dependencies: undefined as readonly unknown[] | undefined,
  pending: undefined as (() => void | (() => void)) | undefined,
  cleanup: undefined as (() => void) | undefined,
  request: vi.fn(),
  vault: { uid: "owner", status: "unlocked", version: 1, publicKey: "owner-key", openContent: vi.fn() },
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

import { contentEligible, useSessionContents, withSessionContent } from "./use-session-contents";
import { sessionTitle } from "./session-title";

const content: SessionContent = { version: 1, suggestedTitle: "Existing conversation title", description: "Synthetic completed response", source: "opencode-launch", observedAt: 1_800_000_000_000 };
const envelope = { generation: "generation-1", observedAt: content.observedAt, senderPublicKey: "sender", sealed: "sc1.synthetic" };
function session(extra: Partial<SessionRecord> = {}): SessionRecord {
  return { id: "s1", ownerUid: "owner", dailyBriefingEnabled: true, shareUrl: "https://example.test/s/s1", command: "opencode", readOnly: false, encrypted: true, persistent: false, host: "synthetic", startedAt: 1, ...extra };
}
function commit() {
  if (!harness.pending) return;
  harness.cleanup?.();
  const effect = harness.pending;
  harness.pending = undefined;
  harness.cleanup = effect() || undefined;
}
function RenderHarness(sessions: SessionRecord[] | null, effects = true) {
  const result = useSessionContents(sessions);
  if (effects) commit();
  return result;
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.value = undefined; harness.dependencies = undefined; harness.pending = undefined; harness.cleanup = undefined;
  harness.request.mockReset().mockResolvedValue(envelope);
  harness.vault = { uid: "owner", status: "unlocked", version: 1, publicKey: "owner-key", openContent: vi.fn().mockResolvedValue(content) };
});
afterEach(() => { harness.cleanup?.(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("session content eligibility and projection", () => {
  it("requires actual ownership and explicit consent", () => {
    expect(contentEligible(session(), "owner")).toBe(true);
    expect(contentEligible(session({ ownerUid: undefined, uid: "owner" }), "owner")).toBe(true);
    for (const record of [session({ dailyBriefingEnabled: false }), session({ dailyBriefingEnabled: undefined }),
      session({ ownerUid: "another", uid: "owner", assigneeUid: "owner", assigneeUids: ["owner"] }),
      session({ ownerUid: undefined, uid: undefined })]) expect(contentEligible(record, "owner")).toBe(false);
    expect(contentEligible(session(), "admin")).toBe(false);
    expect(contentEligible(session(), "")).toBe(false);
  });
  it("preserves manual names, input records, source and observation provenance", () => {
    const record = session({ name: "Manual title" });
    const projected = withSessionContent(record, content);
    expect(sessionTitle(projected)).toBe("Manual title");
    expect(projected).toMatchObject({ name: "Manual title", suggestedTitle: content.suggestedTitle, description: content.description, contentSource: "opencode-launch", contentObservedAt: content.observedAt });
    expect(record.suggestedTitle).toBeUndefined();
    expect(withSessionContent(record)).toBe(record);
    expect(withSessionContent(record, { ...content, source: "generic" }).contentSource).toBe("generic");
  });
});

describe("session content hook privacy lifecycle", () => {
  it("makes no content request for locked, unconsented or non-owner sessions", async () => {
    RenderHarness([session({ dailyBriefingEnabled: false }), session({ id: "other", ownerUid: "another", assigneeUid: "owner" })]);
    await settle();
    expect(harness.request).not.toHaveBeenCalled();
    harness.vault.status = "locked";
    RenderHarness([session()]); await settle();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.vault.openContent).not.toHaveBeenCalled();
  });
  it("decrypts eligible envelopes and polls without restarting for new session objects", async () => {
    expect(RenderHarness([session()])).toEqual({}); await settle();
    expect(RenderHarness([session()])).toEqual({ s1: content });
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.vault.openContent).toHaveBeenCalledWith("s1", envelope);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(2);
  });
  it.each(["lock", "disable", "owner", "uid", "remove", "version", "share", "vault key", "sender key"])("hides decrypted values synchronously on %s and aborts prior requests", async (change) => {
    const initial = session({ keyShare: { senderPublicKey: "sender", sealed: "v2.first" } });
    RenderHarness([initial]); await settle();
    expect(RenderHarness([initial])).toEqual({ s1: content });
    const signal = harness.request.mock.calls[0][1].signal as AbortSignal;
    let records = [initial];
    if (change === "lock") harness.vault.status = "locked";
    if (change === "disable") records = [{ ...initial, dailyBriefingEnabled: false }];
    if (change === "owner") records = [{ ...initial, ownerUid: "someone-else" }];
    if (change === "uid") harness.vault.uid = "someone-else";
    if (change === "remove") records = [];
    if (change === "version") harness.vault.version = 2;
    if (change === "vault key") harness.vault.publicKey = "rotated-owner-key";
    if (change === "sender key") records = [{ ...initial, keyShare: { senderPublicKey: "rotated-sender", sealed: "v2.first" } }];
    if (change === "share") records = [{ ...initial, keyShare: { senderPublicKey: "sender", sealed: "v2.rotated" } }];
    expect(RenderHarness(records, false)).toEqual({});
    expect(signal.aborted).toBe(false);
    commit(); expect(signal.aborted).toBe(true);
  });
  it.each(["disable", "lock", "uid"])("does not restore plaintext when decryption completes after %s", async (change) => {
    const pending = deferred<SessionContent>();
    harness.vault.openContent.mockReturnValue(pending.promise);
    RenderHarness([session()]); await settle();
    expect(harness.vault.openContent).toHaveBeenCalledTimes(1);
    const disabled = [session({ dailyBriefingEnabled: change !== "disable" })];
    if (change === "lock") harness.vault.status = "locked";
    if (change === "uid") harness.vault.uid = "new-owner";
    expect(RenderHarness(disabled)).toEqual({});
    pending.resolve(content); await settle();
    expect(RenderHarness(disabled)).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
  it("replaces stale decrypted content with empty state after a failed refresh", async () => {
    RenderHarness([session()]); await settle(); expect(RenderHarness([session()])).toEqual({ s1: content });
    harness.request.mockRejectedValue(new Error("revoked"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(RenderHarness([session()])).toEqual({});
  });
  it("caps eligible sessions at 32 and limits in-flight requests to four", async () => {
    const pending = deferred<typeof envelope>(); harness.request.mockReturnValue(pending.promise);
    const sessions = Array.from({ length: 50 }, (_, index) => session({ id: `s${index}` }));
    RenderHarness(sessions); expect(harness.request).toHaveBeenCalledTimes(4);
    pending.resolve(envelope);
    for (let i = 0; i < 10; i++) await settle();
    expect(harness.request).toHaveBeenCalledTimes(32);
    expect(Object.keys(RenderHarness(sessions))).toHaveLength(32);
  });
});
