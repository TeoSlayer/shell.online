import { UserManager, WebStorageStateStore, type User as OidcUser } from "oidc-client-ts";

/*
 * Configuration is read from the environment so the app can be pointed at any
 * OpenID provider without touching code. See .env.example for the names.
 *
 * Only the issuer and the client id are required. Everything else is derived:
 * the endpoints come from the provider's OpenID configuration, and the
 * redirect comes from wherever the app is actually being served, so a
 * deployment does not have to state its own address twice.
 */
const required = ["VITE_OIDC_ISSUER", "VITE_OIDC_CLIENT_ID"] as const;

const missing = required.filter((key) => !import.meta.env[key]);
/** Firebase remains the default; setting both OIDC values selects OIDC. */
export const oidcConfigured = missing.length === 0;

export const CALLBACK_PATH = "/auth/callback";

/**
 * Where the provider sends people back to.
 *
 * Taken from the running page rather than configured, because it has to match
 * the address the browser is on: a redirect URI that disagrees with it by so
 * much as a trailing slash is rejected by the provider, and stating it in two
 * places is how they come to disagree.
 */
function redirectUri(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export const userManager = oidcConfigured ? new UserManager({
  authority: import.meta.env.VITE_OIDC_ISSUER,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirect_uri: redirectUri(CALLBACK_PATH),
  /* The same route, opened in a popup, handles a re-authentication. */
  popup_redirect_uri: redirectUri(CALLBACK_PATH),
  post_logout_redirect_uri: redirectUri("/login"),
  /*
   * Authorization code with PKCE. A browser app cannot keep a secret, so it
   * is a public client and the proof key is what stands in for one.
   */
  response_type: "code",
  scope: "openid profile email",
  /*
   * Sessions survive a reload, which is what makes a bookmarked terminal open
   * without signing in again. sessionStorage would end the session with the
   * tab, and this app is one people leave open on a phone.
   */
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  /*
   * Renew in the background from a hidden iframe, so a long-running terminal
   * does not have its API calls start failing an hour in. The provider has to
   * allow the app's origin in its Web Origins for this to work; without it,
   * renewal fails quietly and the session ends at the token's expiry.
   */
  automaticSilentRenew: true,
  silent_redirect_uri: redirectUri(CALLBACK_PATH),
  /* Ask a little early, so a renewal has room to fail and be retried. */
  accessTokenExpiringNotificationTimeInSeconds: 120,
  /*
   * The state left in storage by an abandoned sign-in is not interesting, and
   * clearing it keeps a browser that has been through a few failed attempts
   * from accumulating it.
   */
  monitorSession: false,
}) : null;

/**
 * Who is signed in, as the app shows them.
 *
 * Identity only, and deliberately no credential: the token is read from the
 * manager at the moment a request is made (see api.ts), so there is nothing
 * here that would be a secret if it were written down — which matters,
 * because the uid is written down, as the key that scopes this browser's
 * remembered tabs and passwords to one account.
 */
export interface SignedInUser {
  uid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

/**
 * Maps an OIDC session onto the shape the app was already written against.
 *
 * The app used to hold a Firebase `User`, and the half-dozen fields it reads
 * from one all have standard OIDC claims behind them. Presenting the same
 * shape is what keeps the account, consent and invitation screens from caring
 * which provider is in use.
 */
export function toSignedInUser(user: OidcUser): SignedInUser {
  const profile = user.profile;
  return {
    uid: profile.sub,
    email: profile.email ?? "",
    /*
     * `name` is only sent when the account has both a given and a family
     * name, so a username-only account would otherwise have no display name.
     */
    displayName: profile.name ?? profile.preferred_username ?? "",
    emailVerified: profile.email_verified === true,
  };
}

/**
 * Sends someone to the provider to sign in.
 *
 * There is no separate call for registering or for resetting a password.
 * Both belong to whoever holds the password, and the provider's own sign-in
 * page is where the links to them live — Keycloak shows a "Register" link
 * exactly when the realm allows it, which is a truer answer than anything
 * this app could decide from its own configuration.
 */
export async function startSignIn(options: { returnTo?: string } = {}): Promise<void> {
  if (!userManager) throw new Error("OpenID Connect is not configured.");
  await userManager.signinRedirect({
    /*
     * Where to go afterwards, carried through the provider and handed back by
     * the callback. It has to travel in the request's state rather than in
     * this app's router state, which does not survive leaving the page.
     */
    state: { returnTo: options.returnTo ?? "/sessions" } satisfies SignInState,
  });
}

export interface SignInState {
  returnTo: string;
}

/**
 * Proves the person is still there, for something irreversible.
 *
 * A popup rather than a redirect: the screen that asks is a form with typed
 * confirmation in it, and leaving the app would throw that away and come back
 * to a page that has forgotten what it was about to do. `prompt=login` is
 * what makes it a sign-in rather than the provider's cookie answering
 * instantly, and the new token is what carries the fresh `auth_time` the
 * service checks.
 */
export async function reauthenticate(): Promise<void> {
  if (!userManager) throw new Error("OpenID Connect is not configured.");
  await userManager.signinPopup({ prompt: "login" });
}

/** The return path a sign-in was started with, if it still looks like one. */
export function returnToFrom(state: unknown): string {
  const candidate = (state as SignInState | undefined)?.returnTo;
  /*
   * Only a path on this app. A full URL here would be an open redirect: the
   * value has been through the provider and back, and anyone can start a
   * sign-in carrying whatever they like.
   */
  if (typeof candidate === "string" && /^\/(?!\/)/.test(candidate)) return candidate;
  return "/sessions";
}
