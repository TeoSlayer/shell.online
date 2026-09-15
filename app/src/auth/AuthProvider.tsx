import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  reauthenticate,
  startSignIn,
  toAuthUser,
  userManager,
  type AuthUser,
} from "../lib/oidc";
import { deleteAccountData } from "../lib/api";
import { forgetAll, setPasswordOwner } from "../lib/session-passwords";
import { clearLocalVault } from "../lib/vault-store";
import { forgetOpenTabs } from "../terminal/tab-store";

interface AuthValue {
  user: AuthUser | null;
  /* True until the stored session has been read, so guards do not flash. */
  initializing: boolean;
  /** Leaves the app for the provider; resolves only if the redirect fails. */
  signIn: (returnTo?: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  /**
   * Deletes the account from shell.online. Signs in again at the provider
   * first, so the service sees a fresh sign-in; the identity itself lives at
   * the provider and is removed there.
   */
  deleteAccount: (confirmEmail: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let live = true;

    const apply = (next: AuthUser | null) => {
      if (!live) return;
      /* Scope any stored session password to whoever is signed in now. */
      setPasswordOwner(next?.uid ?? "");
      setUser(next);
    };

    /*
     * The stored session is read once at startup; after that the manager's
     * events are the only thing that changes it. A renewal that fails ends
     * the session here rather than leaving a signed-in shell whose every
     * request is refused.
     */
    void userManager
      .getUser()
      .then((found) => apply(found && !found.expired ? toAuthUser(found) : null))
      .catch(() => apply(null))
      .finally(() => {
        if (live) setInitializing(false);
      });

    const onLoaded = (next: Parameters<Parameters<typeof userManager.events.addUserLoaded>[0]>[0]) =>
      apply(toAuthUser(next));
    const onUnloaded = () => apply(null);
    const onExpired = () => apply(null);
    const onRenewError = () => apply(null);

    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);
    userManager.events.addAccessTokenExpired(onExpired);
    userManager.events.addSilentRenewError(onRenewError);

    return () => {
      live = false;
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
      userManager.events.removeAccessTokenExpired(onExpired);
      userManager.events.removeSilentRenewError(onRenewError);
    };
  }, []);

  const signIn = useCallback(async (returnTo?: string) => {
    await startSignIn({ returnTo });
  }, []);

  const signOutUser = useCallback(async () => {
    /*
     * Signing out locks the vault in this browser, so a shared computer does
     * not keep an unlocked key for whoever signed out. The vault itself is
     * untouched and the next sign-in unlocks it with the recovery key.
     *
     * Cached session passwords are keyed by account, so they are not exposed
     * to whoever signs in next, and they are only a cache now: the vault holds
     * the copies that matter.
     */
    const current = await userManager.getUser();
    if (current) await clearLocalVault(current.profile.sub);
    /*
     * Ending the provider's session too, not only this app's: a sign-out that
     * left the provider's cookie in place would sign the same person straight
     * back in on the next click, which does not look like signing out.
     */
    try {
      await userManager.signoutRedirect();
    } catch {
      /*
       * A provider with no end-session endpoint, or one that is unreachable,
       * must not leave someone stuck signed in. Dropping the local session is
       * the part this app can always do.
       */
      await userManager.removeUser();
    }
  }, []);

  const deleteAccount = useCallback(async (confirmEmail: string) => {
    const current = await userManager.getUser();
    if (!current || current.expired) throw new Error("Sign in first.");
    const uid = current.profile.sub;
    /*
     * Proof of presence before anything is deleted. The service refuses a
     * sign-in older than ten minutes, so this asks the provider for a fresh
     * one — `prompt=login`, so it is a real sign-in and not the session
     * cookie handed back. The password, if there is one, is typed at the
     * provider; this app has no field for it to type into.
     */
    await reauthenticate();
    /*
     * The service first, then the local state. The other order, interrupted,
     * would leave data behind for an account nobody can sign in to again.
     * This one leaves an empty account, and deleting it again finishes the
     * job: the service treats a second request as nothing left to remove.
     */
    await deleteAccountData(confirmEmail);
    forgetAll();
    forgetOpenTabs(uid);
    await clearLocalVault(uid);
    /*
     * The identity is the provider's, not this app's: a public PKCE client
     * has no standing to delete a user, and nothing in OpenID Connect lets it
     * ask. So the session ends here and the account itself is removed
     * wherever it lives — which is also where it can be removed from every
     * other application that uses it.
     */
    await userManager.removeUser();
  }, []);

  const value = useMemo(
    () => ({ user, initializing, signIn, signOutUser, deleteAccount }),
    [user, initializing, signIn, signOutUser, deleteAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside an AuthProvider.");
  }
  return value;
}
