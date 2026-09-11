import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth, RedirectIfAuthed } from "./auth/RequireAuth";
import { SignIn } from "./routes/SignIn";
import { SignUp } from "./routes/SignUp";
import { ResetPassword } from "./routes/ResetPassword";
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
import { VaultGate } from "./vault/VaultGate";
import { TeamKeyProvider } from "./vault/TeamKeyProvider";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <VaultProvider>
        <TeamKeyProvider>
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
          <Route
            path="/signup"
            element={
              <RedirectIfAuthed>
                <SignUp />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/reset"
            element={
              <RedirectIfAuthed>
                <ResetPassword />
              </RedirectIfAuthed>
            }
          />
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
                <VaultGate>
                  <Session />
                </VaultGate>
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
                <VaultGate>
                  <Workspace />
                </VaultGate>
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
        </TeamKeyProvider>
        </VaultProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
