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
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "../lib/firebase";
import { setPasswordOwner } from "../lib/session-passwords";

interface AuthValue {
  user: User | null;
  /* True until the first onAuthStateChanged fires, so guards do not flash. */
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  signOutUser: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (next) => {
      /* Scope any stored session password to whoever is signed in now. */
      setPasswordOwner(next?.uid ?? "");
      setUser(next);
      setInitializing(false);
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  }, []);

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      const credential = await createUserWithEmailAndPassword(
        auth,
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
    [],
  );

  const signInWithGoogle = useCallback(async () => {
    await signInWithPopup(auth, googleProvider);
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  }, []);

  const resendVerification = useCallback(async () => {
    if (!auth.currentUser) throw new Error("Sign in first.");
    await sendEmailVerification(auth.currentUser);
  }, []);

  const signOutUser = useCallback(async () => {
    /*
     * Stored session passwords are keyed by account, so signing out does not
     * expose them to whoever signs in next. They are deliberately kept: they
     * are how this person reopens their own sessions, and how they share them
     * with colleagues who join later.
     */
    await signOut(auth);
  }, []);

  const value = useMemo(
    () => ({
      user,
      initializing,
      signIn,
      signUp,
      signInWithGoogle,
      resetPassword,
      resendVerification,
      signOutUser,
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
    ],
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
