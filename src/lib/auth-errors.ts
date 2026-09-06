import { FirebaseError } from "firebase/app";

/*
 * Firebase error codes are not user-facing copy. Map the ones a person can
 * actually trigger to plain sentences, and keep a readable fallback for the
 * rest rather than leaking "auth/internal-error" into the UI.
 */
const MESSAGES: Record<string, string> = {
  "auth/invalid-email": "That does not look like a valid email address.",
  "auth/missing-password": "Enter your password.",
  "auth/invalid-credential": "That email and password do not match an account.",
  "auth/wrong-password": "That email and password do not match an account.",
  "auth/user-not-found": "That email and password do not match an account.",
  "auth/user-disabled": "This account has been disabled. Contact support to reopen it.",
  "auth/email-already-in-use": "An account already uses that email. Sign in instead.",
  "auth/weak-password": "Pick a password with at least 8 characters.",
  "auth/too-many-requests":
    "Too many attempts from this device. Wait a few minutes and try again.",
  "auth/network-request-failed": "The network dropped. Check your connection and retry.",
  "auth/popup-closed-by-user": "The Google window closed before sign-in finished.",
  "auth/cancelled-popup-request": "The Google window closed before sign-in finished.",
  "auth/popup-blocked":
    "Your browser blocked the Google window. Allow popups for this site and retry.",
  "auth/account-exists-with-different-credential":
    "That email is already registered with a different sign-in method.",
  "auth/unauthorized-domain":
    "This domain is not authorized for sign-in. Add it in the Firebase console.",
  "auth/operation-not-allowed":
    "That sign-in method is turned off for this project.",
  "auth/requires-recent-login": "Sign in again to complete this change.",
};

export function authErrorMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    return MESSAGES[error.code] ?? "Something went wrong on our side. Try again.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong on our side. Try again.";
}

/* Returns 0-4. Length carries most of the weight; variety breaks ties. */
export function passwordScore(value: string): number {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value) || /[^\w\s]/.test(value)) score += 1;
  return Math.min(score, 4);
}

export const PASSWORD_LABELS = ["", "weak", "fair", "good", "strong"] as const;
