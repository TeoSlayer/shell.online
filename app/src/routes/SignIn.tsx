import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { GoogleMark } from "../components/GoogleMark";
import { useAuth } from "../auth/AuthProvider";
import { authErrorMessage } from "../lib/auth-errors";

export function SignIn() {
  const { signIn, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const destination =
    (location.state as { from?: string } | null)?.from ?? "/sessions";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState<"none" | "email" | "google">("none");

  function validate() {
    const next: Record<string, string> = {};
    if (!email.trim()) next.email = "Enter your email address.";
    if (!password) next.password = "Enter your password.";
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!validate()) return;

    setPending("email");
    try {
      await signIn(email, password);
      navigate(destination, { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    } finally {
      setPending("none");
    }
  }

  async function handleGoogle() {
    setFormError("");
    setFieldErrors({});
    setPending("google");
    try {
      await signInWithGoogle();
      navigate(destination, { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    } finally {
      setPending("none");
    }
  }

  const busy = pending !== "none";

  return (
    <AuthShell
      title="Welcome back."
      dek={
        <>
          Sign in to manage the sessions you have shared and the links people
          are watching.
        </>
      }
      headLink={{ to: "/signup", label: "Create account" }}
      foot={
        <>
          New here?{" "}
          <Link to="/signup" state={location.state}>
            Create an account
          </Link>
          .
        </>
      }
    >
      {formError && <Alert tone="error">{formError}</Alert>}

      <form onSubmit={handleSubmit} noValidate>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          placeholder="you@company.com"
          error={fieldErrors.email}
          disabled={busy}
          autoFocus
        />

        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          placeholder="Your password"
          error={fieldErrors.password}
          disabled={busy}
          action={<Link to="/reset">Forgot password</Link>}
        />

        <Button type="submit" busy={pending === "email"} busyLabel="Signing in" disabled={busy}>
          Sign in
        </Button>
      </form>

      <div className="divider">
        <span>or</span>
      </div>

      <Button
        type="button"
        variant="ghost"
        onClick={handleGoogle}
        busy={pending === "google"}
        busyLabel="Opening Google"
        disabled={busy}
      >
        <GoogleMark />
        Continue with Google
      </Button>
    </AuthShell>
  );
}
