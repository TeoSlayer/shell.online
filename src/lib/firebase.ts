import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  initializeAuth,
  browserPopupRedirectResolver,
} from "firebase/auth";

/*
 * Config is read from the environment so the app can be pointed at a
 * dedicated shell.online Firebase project without touching code. See
 * .env.example for the variable names.
 */
const required = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

const missing = required.filter((key) => !import.meta.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Firebase is not configured. Missing ${missing.join(", ")}. ` +
      "Copy .env.example to .env.local and fill it in.",
  );
}

const options: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

export const firebaseApp = initializeApp(options);

/*
 * initializeAuth over getAuth: it lets us pin persistence and skip the
 * reCAPTCHA/phone machinery we do not use, which keeps the bundle smaller.
 */
export const auth = initializeAuth(firebaseApp, {
  persistence: browserLocalPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
