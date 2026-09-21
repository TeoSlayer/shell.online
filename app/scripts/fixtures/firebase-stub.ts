// Test-only stand-in for the Firebase module.
//
// api.ts asks `auth.currentUser` for an ID token on every request; with no
// provider configured (`firebaseApp` is null) every call would report
// "signed out" and no route could be exercised. This module is substituted by
// the resolve plugin in app/scripts/test-session-route-ui.mjs, and nothing in
// a build or deployment imports it.
export const firebaseConfigured = true;

export const auth = {
  currentUser: {
    getIdToken: async () => "route-test-token",
  },
};
