import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth, RedirectIfAuthed } from "./auth/RequireAuth";
import { SignIn } from "./routes/SignIn";
import { SignUp } from "./routes/SignUp";
import { ResetPassword } from "./routes/ResetPassword";
import { Account } from "./routes/Account";
import { Workspace } from "./routes/Workspace";
import { Machines } from "./routes/Machines";
import { Organization } from "./routes/Organization";
import { Join } from "./routes/Join";
import { CliAuthorize } from "./routes/CliAuthorize";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
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
            path="/organization"
            element={
              <RequireAuth>
                <Organization />
              </RequireAuth>
            }
          />
          {/* Its own guard, so signing in returns to the invite. */}
          <Route path="/join/:inviteId" element={<Join />} />
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
      </AuthProvider>
    </BrowserRouter>
  );
}
