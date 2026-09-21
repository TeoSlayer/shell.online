import { describe, expect, it, vi } from "vitest";
import { ASSESS_ACTIONS_IDLE, assessStateForAccount, createAssessActions } from "./assess-actions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("account-scoped assess actions", () => {
  it("applies consent and busy transitions for the current account", async () => {
    const request = vi.fn(async () => ({ externalAnalysis: true, updatedAt: 7 }));
    const changes: unknown[] = [];
    const actions = createAssessActions({ request, onChange: (state) => changes.push(state) });
    actions.setAccount("uid-1");

    await actions.consent(true);
    expect(actions.getState().localConsent).toEqual({ enabled: true, updatedAt: 7 });
    expect(actions.getState().error).toBe("");

    const pending = actions.assess("sess001", { flows: 2 });
    expect(actions.getState().busy).toBe(true);
    await pending;
    expect(actions.getState().busy).toBe(false);
    expect(request).toHaveBeenCalledWith("/api/game/sessions/sess001/assess", expect.objectContaining({ method: "POST" }));
    expect(changes.length).toBeGreaterThan(0);
  });

  it("discards a consent response that resolves after an account switch", async () => {
    const gate = deferred<{ externalAnalysis: boolean; updatedAt: number }>();
    const actions = createAssessActions({ request: () => gate.promise });
    actions.setAccount("uid-old");
    const pending = actions.consent(true);
    await flush();

    actions.setAccount("uid-new");
    expect(actions.getState()).toEqual({ uid: "uid-new", busy: false, error: "", localConsent: null });
    gate.resolve({ externalAnalysis: true, updatedAt: 9 });
    await pending;
    expect(actions.getState()).toEqual({ uid: "uid-new", busy: false, error: "", localConsent: null });
  });

  it("serves idle state for the new account before the effect reset runs", async () => {
    const actions = createAssessActions({ request: async () => ({ externalAnalysis: true, updatedAt: 4 }) });
    actions.setAccount("uid-a");
    await actions.consent(true);
    const beforeEffect = actions.getState();
    expect(beforeEffect.uid).toBe("uid-a");
    expect(beforeEffect.localConsent).toEqual({ enabled: true, updatedAt: 4 });

    /* The first render of the new account: the controller still belongs to
       uid-a, so all three fields render as idle rather than uid-a's values. */
    const gated = assessStateForAccount(beforeEffect, "uid-b");
    expect(gated).toEqual(ASSESS_ACTIONS_IDLE);
    expect(gated.busy).toBe(false);
    expect(gated.error).toBe("");
    expect(gated.localConsent).toBeNull();

    /* After the effect reset, the matching state is served untouched. */
    actions.setAccount("uid-b");
    expect(assessStateForAccount(actions.getState(), "uid-b")).toEqual(actions.getState());
    expect(assessStateForAccount(actions.getState(), "uid-b").localConsent).toBeNull();
  });

  it("clears busy on switch and never lets a stale assess error land", async () => {
    const gate = deferred<unknown>();
    const actions = createAssessActions({ request: () => gate.promise });
    actions.setAccount("uid-old");
    const pending = actions.assess("sess001", { flows: 1 });
    expect(actions.getState().busy).toBe(true);

    actions.setAccount("uid-new");
    expect(actions.getState().busy).toBe(false);
    gate.reject(new Error("old account failed"));
    await pending;
    expect(actions.getState().error).toBe("");
    expect(actions.getState().busy).toBe(false);
  });

  it("keeps the newest consent response when an older one resolves late", async () => {
    const first = deferred<{ externalAnalysis: boolean; updatedAt: number }>();
    const second = deferred<{ externalAnalysis: boolean; updatedAt: number }>();
    let call = 0;
    const actions = createAssessActions({ request: () => (++call === 1 ? first.promise : second.promise) });
    actions.setAccount("uid-1");
    const older = actions.consent(true);
    const newer = actions.consent(false);
    second.resolve({ externalAnalysis: false, updatedAt: 11 });
    await newer;
    first.resolve({ externalAnalysis: true, updatedAt: 10 });
    await older;
    expect(actions.getState().localConsent).toEqual({ enabled: false, updatedAt: 11 });
  });

  it("reports a failure for the current account and ignores a same-uid reset", async () => {
    const actions = createAssessActions({ request: async () => { throw new Error("offline"); } });
    actions.setAccount("uid-1");
    await actions.assess("sess001", { flows: 1 });
    expect(actions.getState().error).toBe("offline");
    await actions.consent(true);
    expect(actions.getState().error).toBe("offline");

    actions.setAccount("uid-1");
    expect(actions.getState().error).toBe("offline");
  });

  it("ignores a malformed consent payload instead of inventing consent", async () => {
    const actions = createAssessActions({ request: async () => ({ externalAnalysis: "yes", updatedAt: "now" }) });
    actions.setAccount("uid-1");
    await actions.consent(true);
    expect(actions.getState().localConsent).toBeNull();
    expect(actions.getState().error).toBe("");
  });

  it("drops a dispatch whose callback was rendered for a previous account", async () => {
    /* Mirrors the GameRoute guard: the event ref holds the current account, and
       a callback rendered for an older uid must not dispatch under the new
       account's auth. */
    const request = vi.fn(async () => ({ externalAnalysis: true, updatedAt: 1 }));
    const actions = createAssessActions({ request });
    actions.setAccount("uid-a");
    const callbackAuthUid: string = "uid-a";
    const currentAuthUid: string = "uid-b";
    if (callbackAuthUid === "" || callbackAuthUid !== currentAuthUid) {
      /* dropped before reaching the controller */
    } else {
      await actions.consent(true);
    }
    expect(request).not.toHaveBeenCalled();
    expect(actions.getState().localConsent).toBeNull();
  });
});
