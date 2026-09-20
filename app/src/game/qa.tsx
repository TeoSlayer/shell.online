import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { SignedInApp } from "../App";
import { AuthContext } from "../auth/AuthProvider";
/* The same stylesheets main.tsx loads, in the same order. */
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/auth.css";
import "../styles/shell.css";
import "../styles/terminal.css";
import "../styles/chat.css";
import "../styles/people.css";
import "../styles/collab.css";
import "../styles/audit.css";
import "../styles/terms.css";
import "../styles/vault.css";
import "../styles/feedback.css";

/**
 * The whole application, signed in, for QA on a machine with no provider.
 *
 * The preview harness next door mounts the game on its own, which is useful
 * while drawing but is not the thing anyone needs to test: the game is a skin
 * over a product, so what has to be exercised is the route inside the app, the
 * controller in the top bar that opens it, and the way back out of it to the
 * session list. None of that exists without a signed-in page to hang it on.
 *
 * So this mounts the real App with a stand-in identity in the auth context.
 * Every guard still asks that context the same question it always asks; the
 * only difference is who answers. The service is not fooled -- it checks a
 * real token and will refuse anything that reaches it -- so the parts of the
 * app that talk to the server will show their error states, which is itself
 * worth seeing.
 *
 * Reached at /qa.html while `npm run dev` is running. Not an input to
 * `vite build`, which builds index.html and nothing else, so it exists in
 * development and in no deployment.
 */
function SignedIn({ children }: { children: React.ReactNode }) {
  const value = useMemo(
    () => ({
      mode: "firebase" as const,
      user: {
        uid: "qa-local",
        email: "qa@shell.online",
        displayName: "QA",
        emailVerified: true,
        providerData: [],
      },
      initializing: false,
      signIn: async () => {},
      signUp: async () => {},
      signInWithGoogle: async () => {},
      signInWithProvider: async () => {},
      resetPassword: async () => {},
      resendVerification: async () => {},
      signOutUser: async () => {},
      deleteAccount: async () => {},
    }),
    [],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SignedIn>
        <SignedInApp />
      </SignedIn>
    </BrowserRouter>
  </StrictMode>,
);
