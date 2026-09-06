import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth, RedirectIfAuthed } from "./auth/RequireAuth";
import { SignIn } from "./routes/SignIn";
import { SignUp } from "./routes/SignUp";
import { ResetPassword } from "./routes/ResetPassword";
import { Account } from "./routes/Account";

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
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
