import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
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

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
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
      </AuthProvider>
    </BrowserRouter>
  );
}
