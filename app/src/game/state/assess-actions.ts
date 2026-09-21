/**
 * The consent/assessment actions, scoped to the signed-in account.
 *
 * These callbacks outlive a render and cross an await, so account switching is
 * the real hazard: a response for the previous account must never land in the
 * new account's panel. Every call captures the generation it started under and
 * a switch bumps that generation and clears transient state, so stale results
 * are discarded rather than applied.
 *
 * It is deliberately not a React hook: this is the handler boundary the game
 * route uses, and it is tested directly with deferred requests.
 */

export interface AssessConsent {
  enabled: boolean;
  updatedAt: number;
}

export interface AssessActionsState {
  /** The account this state belongs to; "" means signed out. */
  uid: string;
  busy: boolean;
  error: string;
  localConsent: AssessConsent | null;
}

export const ASSESS_ACTIONS_IDLE: AssessActionsState = Object.freeze({
  uid: "",
  busy: false,
  error: "",
  localConsent: null,
});

/**
 * The render-time gate: the controller's reset runs in an effect, which is
 * after the first render of a new account. Until that effect runs, the
 * previous account's transient state must not be rendered for the new one, so
 * a uid mismatch serves the idle shape instead.
 */
export function assessStateForAccount(state: AssessActionsState, uid: string): AssessActionsState {
  return state.uid === uid ? state : ASSESS_ACTIONS_IDLE;
}

export type AssessRequest = (
  path: string,
  init?: { method?: string; body?: string },
) => Promise<unknown>;

export function createAssessActions(options: { request: AssessRequest; onChange?: (state: AssessActionsState) => void }) {
  let state: AssessActionsState = { uid: "", busy: false, error: "", localConsent: null };
  let account = "";
  let generation = 0;
  let consentSeq = 0;

  const emit = () => options.onChange?.(state);
  const apply = (at: number, next: Partial<AssessActionsState>) => {
    if (at !== generation) return; // a stale account's response is discarded
    state = { ...state, ...next };
    emit();
  };

  return {
    getState: (): AssessActionsState => state,

    /** Bumps the generation and clears transient state; same uid is a no-op. */
    setAccount(uid: string): void {
      if (uid === account) return;
      account = uid;
      generation += 1;
      state = { uid, busy: false, error: "", localConsent: null };
      emit();
    },

    consent(enabled: boolean): Promise<void> {
      const at = generation;
      const seq = (consentSeq += 1);
      apply(at, { error: "" });
      return options
        .request("/api/game/assessments/consent", { method: "PUT", body: JSON.stringify({ enabled }) })
        .then((raw) => {
          if (at !== generation || seq !== consentSeq) return; // stale account or superseded call
          const saved = (raw ?? {}) as { externalAnalysis?: unknown; updatedAt?: unknown };
          if (saved.externalAnalysis !== true && saved.externalAnalysis !== false) return;
          if (typeof saved.updatedAt !== "number" || !Number.isFinite(saved.updatedAt)) return;
          apply(at, { localConsent: { enabled: saved.externalAnalysis, updatedAt: saved.updatedAt } });
        })
        .catch((error: unknown) => {
          apply(at, { error: error instanceof Error ? error.message : "The service did not answer." });
        });
    },

    assess(sessionId: string, observed: { flows: number }): Promise<void> {
      const at = generation;
      apply(at, { busy: true, error: "" });
      return options
        .request(`/api/game/sessions/${sessionId}/assess`, { method: "POST", body: JSON.stringify({ observed }) })
        .then(() => {
          apply(at, { busy: false });
        })
        .catch((error: unknown) => {
          apply(at, { busy: false, error: error instanceof Error ? error.message : "The service did not answer." });
        });
    },
  };
}

export type AssessActions = ReturnType<typeof createAssessActions>;
