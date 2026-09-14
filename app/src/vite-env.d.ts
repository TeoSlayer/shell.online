/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_RELAY_URL?: string;
  readonly VITE_ACCOUNTS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/* Stamped by vite.config.ts; absent under vitest, which is why the type admits it. */
declare const __SHELL_ONLINE_VERSION__: string | undefined;
