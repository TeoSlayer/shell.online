import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { Booting } from "./components/Booting";
import { RequireAuth, RedirectIfAuthed } from "./auth/RequireAuth";
import { SignIn } from "./routes/SignIn";
import AuthCallback from "./routes/AuthCallback";
import { SignUp } from "./routes/SignUp";
import { ResetPassword } from "./routes/ResetPassword";
import { oidcConfigured } from "./lib/oidc";
import { Account } from "./routes/Account";
import { Workspace } from "./routes/Workspace";
import { Machines } from "./routes/Machines";
import { Team } from "./routes/Team";
import { Join } from "./routes/Join";
import { Terms } from "./routes/Terms";
import { Privacy } from "./routes/Privacy";
import { Session } from "./routes/Session";
import { Audit } from "./routes/Audit";
import { CliAuthorize } from "./routes/CliAuthorize";
import { VaultProvider } from "./vault/VaultProvider";
import { TeamKeyProvider } from "./vault/TeamKeyProvider";
import { FeedbackProvider } from "./feedback/FeedbackProvider";
import { Feedback } from "./routes/Feedback";
import { ProductAnalytics } from "./components/ProductAnalytics";

/*
 * The game skin, and the only reference to it anywhere outside src/game.
 *
 * Imported this way on purpose: the keep carries an engine, a sprite atlas and
 * a stylesheet of its own, and none of that belongs in the bundle somebody
 * downloads to look at a list of sessions. The dynamic import puts all of it in
 * a separate chunk that is fetched the first time somebody asks for it, and
 * `npm run verify:bundle` fails the build if it ever leaks back into the entry
 * chunk.
 *
 * The fallback is the app's ordinary Booting card rather than something
 * game-shaped, for the same reason: anything prettier would have to be imported
 * here, and then it would not be in the game's chunk either.
 */
const GameRoute = lazy(() => import("./game/GameRoute"));

/**
 * Everything below sign-in: the providers that need an identity, and the
 * routes.
 *
 * Split out from App so the development QA harness can mount the same tree
 * with a stand-in identity on a machine that has no sign-in provider
 * configured. Production mounts it through App below, under the real provider,
 * and nothing about the guards changes either way.
 */
export function SignedInApp() {
  return (
    <>
        <VaultProvider>
        <TeamKeyProvider>
        <FeedbackProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <SignIn />
              </RedirectIfAuthed>
            }
          />
          {/*
            * Where the provider returns people to, and the target of the
            * hidden iframe that renews a session. Not guarded: it has to run
            * while nobody is signed in yet, which is the whole point of it.
            */}
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/feedback" element={<RequireAuth><Feedback /></RequireAuth>} />
          {/*
            * Registration and password reset happen at the provider now.
            * The paths are kept because they have been linked and bookmarked;
            * /login is where both of them start.
            */}
          <Route path="/signup" element={oidcConfigured ? <Navigate to="/login" replace /> : <SignUp />} />
          <Route path="/reset" element={oidcConfigured ? <Navigate to="/login" replace /> : <ResetPassword />} />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <Account />
              </RequireAuth>
            }
          />
          <Route
            path="/sessions/:sessionId"
            element={
              <RequireAuth>
                <Session />
              </RequireAuth>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireAuth>
                <Audit />
              </RequireAuth>
            }
          />
          <Route
            path="/team"
            element={
              <RequireAuth>
                <Team />
              </RequireAuth>
            }
          />
          {/* Its own guard, so signing in returns to the invite. */}
          <Route path="/join/:inviteId" element={<Join />} />
          {/* Public: it has to be readable before anyone has an account. */}
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route
            path="/machines"
            element={
              <RequireAuth>
                <Machines />
              </RequireAuth>
            }
          />
          <Route
            path="/sessions"
            element={
              <RequireAuth>
                <Workspace />
              </RequireAuth>
            }
          />
          {/* The same product, in armour. See src/game/GameRoute.tsx. */}
          <Route
            path="/game"
            element={
              <RequireAuth>
                <Suspense fallback={<Booting label="Opening the keep" />}>
                  <GameRoute />
                </Suspense>
              </RequireAuth>
            }
          />
          {/*
            No guard here. CliAuthorize handles the signed-out case itself so
            it can send the user back to this exact URL, query string included.
          */}
          <Route path="/cli/authorize" element={<CliAuthorize />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        </FeedbackProvider>
        </TeamKeyProvider>
        </VaultProvider>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ProductAnalytics />
        <SignedInApp />
      </AuthProvider>
    </BrowserRouter>
  );
}
