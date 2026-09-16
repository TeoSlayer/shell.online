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
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "../lib/firebase";
import {
  oidcConfigured,
  reauthenticate as reauthenticateOidc,
  startSignIn,
  toSignedInUser,
  userManager,
} from "../lib/oidc";
import { deleteAccountData } from "../lib/api";
import { forgetAll, setPasswordOwner } from "../lib/session-passwords";
import { clearLocalVault } from "../lib/vault-store";
import { forgetOpenTabs } from "../terminal/tab-store";

export interface UserIdentity {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  providerData?: readonly { providerId: string }[];
}

interface AuthValue {
  mode: "firebase" | "oidc";
  user: UserIdentity | null;
  /* True until the first onAuthStateChanged fires, so guards do not flash. */
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  /** Google under Firebase; the configured provider under OIDC. */
  signInWithProvider: (returnTo?: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  signOutUser: () => Promise<void>;
  /**
   * Deletes the account from shell.online and from Firebase. Signs in again
   * first: with the password for an email account, a Google popup otherwise.
   */
  deleteAccount: (confirmEmail: string, password?: string) => Promise<void>;
}

/*
 * Exported for one reason: the development QA harness at /qa.html mounts the
 * whole application on a machine that has no sign-in provider configured, and
 * supplies a stand-in identity here.
 *
 * This weakens nothing. The production build always mounts a real provider
 * below, every guard still asks this context whether there is a user, and the
 * service on the other side still checks a real token on every request -- a
 * browser that puts a name in here gets a nicely rendered page and a 401 from
 * anything that matters. The harness is not an input to `vite build`.
 */
export const AuthContext = createContext<AuthValue | null>(null);

function FirebaseAuthProvider({ children }: { children: ReactNode }) {
  const firebaseAuth = auth;
  if (!firebaseAuth) throw new Error("Firebase is not configured.");
  const [user, setUser] = useState<UserIdentity | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, (next) => {
      /* Scope any stored session password to whoever is signed in now. */
      setPasswordOwner(next?.uid ?? "");
      setUser(next);
      setInitializing(false);
    });
    return unsubscribe;
  }, [firebaseAuth]);

  const signIn = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
  }, [firebaseAuth]);

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      const credential = await createUserWithEmailAndPassword(
        firebaseAuth,
        email.trim(),
        password,
      );
      const displayName = name.trim();
      if (displayName) {
        await updateProfile(credential.user, { displayName });
      }
      /*
       * Verification is best-effort. A throttled send must not strand a user
       * who already has a working account, so failures are swallowed here and
       * surfaced later through the resend action on the account screen.
       */
      try {
        await sendEmailVerification(credential.user);
      } catch {
        /* resend is available from the account screen */
      }
      setUser({ ...credential.user } as User);
    },
    [firebaseAuth],
  );

  const signInWithGoogle = useCallback(async () => {
    await signInWithPopup(firebaseAuth, googleProvider);
  }, [firebaseAuth]);

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(firebaseAuth, email.trim());
  }, [firebaseAuth]);

  const resendVerification = useCallback(async () => {
    if (!firebaseAuth.currentUser) throw new Error("Sign in first.");
    await sendEmailVerification(firebaseAuth.currentUser);
  }, [firebaseAuth]);

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
    const current = firebaseAuth.currentUser;
    if (current) await clearLocalVault(current.uid);
    await signOut(firebaseAuth);
  }, [firebaseAuth]);

  const deleteAccount = useCallback(async (confirmEmail: string, password?: string) => {
    const current = firebaseAuth.currentUser;
    if (!current) throw new Error("Sign in first.");
    /*
     * Proof of presence before anything is deleted. The service refuses a
     * sign-in older than ten minutes and Firebase refuses to delete a user
     * after about five, so signing in again here, first, means neither can
     * refuse halfway through.
     */
    if (current.providerData.some((entry) => entry.providerId === "password")) {
      if (!password) throw new Error("Enter your password.");
      await reauthenticateWithCredential(
        current,
        EmailAuthProvider.credential(current.email ?? "", password),
      );
    } else {
      await reauthenticateWithPopup(current, googleProvider);
    }
    /* A token that carries the sign-in that just happened. */
    await current.getIdToken(true);
    /*
     * The service first, then the sign-in. The other order, interrupted,
     * would leave data behind for an account nobody can sign in to again.
     * This one leaves an empty account, and deleting it again finishes the
     * job: the service treats a second request as nothing left to remove.
     */
    await deleteAccountData(confirmEmail);
    forgetAll();
    forgetOpenTabs(current.uid);
    await clearLocalVault(current.uid);
    await deleteUser(current);
  }, [firebaseAuth]);

  const value = useMemo(
    () => ({
      mode: "firebase" as const,
      user,
      initializing,
      signIn,
      signUp,
      signInWithGoogle,
      signInWithProvider: async () => signInWithGoogle(),
      resetPassword,
      resendVerification,
      signOutUser,
      deleteAccount,
    }),
    [
      user,
      initializing,
      signIn,
      signUp,
      signInWithGoogle,
      resetPassword,
      resendVerification,
      signOutUser,
      deleteAccount,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function OidcAuthProvider({ children }: { children: ReactNode }) {
  const manager = userManager;
  if (!manager) throw new Error("OpenID Connect is not configured.");
  const [user, setUser] = useState<UserIdentity | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let live = true;
    const apply = (next: UserIdentity | null) => {
      if (!live) return;
      setPasswordOwner(next?.uid ?? "");
      setUser(next);
    };
    void manager.getUser()
      .then((found) => apply(found && !found.expired ? toSignedInUser(found) : null))
      .catch(() => apply(null))
      .finally(() => live && setInitializing(false));
    const onLoaded = (next: Parameters<Parameters<typeof manager.events.addUserLoaded>[0]>[0]) =>
      apply(toSignedInUser(next));
    const unload = () => apply(null);
    manager.events.addUserLoaded(onLoaded);
    manager.events.addUserUnloaded(unload);
    manager.events.addAccessTokenExpired(unload);
    manager.events.addSilentRenewError(unload);
    return () => {
      live = false;
      manager.events.removeUserLoaded(onLoaded);
      manager.events.removeUserUnloaded(unload);
      manager.events.removeAccessTokenExpired(unload);
      manager.events.removeSilentRenewError(unload);
    };
  }, [manager]);

  const unsupported = useCallback(async () => {
    throw new Error("This action is managed by your identity provider.");
  }, []);
  const signInWithProvider = useCallback(async (returnTo?: string) => {
    await startSignIn({ returnTo });
  }, []);
  const signOutUser = useCallback(async () => {
    const current = await manager.getUser();
    if (current) await clearLocalVault(current.profile.sub);
    try {
      await manager.signoutRedirect();
    } catch {
      await manager.removeUser();
    }
  }, [manager]);
  const deleteAccount = useCallback(async (confirmEmail: string) => {
    const current = await manager.getUser();
    if (!current || current.expired) throw new Error("Sign in first.");
    const uid = current.profile.sub;
    await reauthenticateOidc();
    await deleteAccountData(confirmEmail);
    forgetAll();
    forgetOpenTabs(uid);
    await clearLocalVault(uid);
    await manager.removeUser();
  }, [manager]);

  const value = useMemo<AuthValue>(() => ({
    mode: "oidc",
    user,
    initializing,
    signIn: unsupported,
    signUp: unsupported,
    signInWithGoogle: async () => signInWithProvider(),
    signInWithProvider,
    resetPassword: unsupported,
    resendVerification: unsupported,
    signOutUser,
    deleteAccount,
  }), [user, initializing, unsupported, signInWithProvider, signOutUser, deleteAccount]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return oidcConfigured
    ? <OidcAuthProvider>{children}</OidcAuthProvider>
    : <FirebaseAuthProvider>{children}</FirebaseAuthProvider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside an AuthProvider.");
  }
  return value;
}
