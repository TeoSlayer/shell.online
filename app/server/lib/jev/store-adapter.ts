import type { Store } from "../store";
import type { JevStoreHooks } from "./integration";

/**
 * Adapts the service's Store to the narrow hook surface the Jev integration
 * was written against. Every method maps to one store call; the atomic
 * predicates live in the stores, so nothing here re-implements them and no
 * route can accidentally pass a weaker check than the store enforces.
 */
export function jevStoreHooks(store: Store): JevStoreHooks {
  return {
    getConsent: (orgId, ownerUid) => store.jevConsent(orgId, ownerUid),
    putConsent: (orgId, ownerUid, consent, expectedUpdatedAt) =>
      store.putJevConsent(orgId, ownerUid, consent.externalAnalysis, consent.updatedBy, expectedUpdatedAt),
    liveOwnerSession: async (orgId, ownerUid, sessionId) => {
      const session = await store.sessionInOrg(orgId, sessionId);
      return Boolean(
        session &&
          (session.ownerUid ?? session.uid) === ownerUid &&
          session.closedAt === undefined,
      );
    },
    putAssessmentIfConsented: (orgId, ownerUid, snapshot, expectedUpdatedAt) =>
      store.putJevAssessment(orgId, ownerUid, snapshot, expectedUpdatedAt),
    listAssessments: (orgId, ownerUid) => store.listJevAssessments(orgId, ownerUid),
    dropAssessments: (orgId, ownerUid, sessionIds) => store.dropJevAssessments(orgId, ownerUid, sessionIds),
    clearAssessments: (orgId, ownerUid) => store.clearJevAssessments(orgId, ownerUid),
    consumeBudget: (orgId, ownerUid, chars, at) => store.consumeJevBudget(orgId, ownerUid, chars, at),
  };
}
