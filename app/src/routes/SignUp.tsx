import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { GoogleMark } from "../components/GoogleMark";
import { useAuth } from "../auth/AuthProvider";
import { authErrorMessage } from "../lib/auth-errors";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function SignUp() {
  const { signUp, signInWithGoogle } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState<"none" | "email" | "google">("none");

  function validate() {
    const next: Record<string, string> = {};
    if (!name.trim()) {
      next.name = "Tell us what to call you.";
    }
    if (!email.trim()) {
      next.email = "Enter your email address.";
    } else if (!EMAIL_PATTERN.test(email.trim())) {
      next.email = "That does not look like a valid email address.";
    }
    if (password.length < 8) {
      next.password = "Use at least 8 characters.";
    }
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!validate()) return;

    setPending("email");
    try {
      await signUp(name, email, password);
      navigate("/sessions", { replace: true });
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
      navigate("/sessions", { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    } finally {
      setPending("none");
    }
  }

  const busy = pending !== "none";

  return (
    <AuthShell
      title="Create your account."
      dek={
        <>
          Keep your shared sessions in one place. The CLI keeps working exactly
          as it does today, with or without an account.
        </>
      }
      headLink={{ to: "/login", label: "Sign in" }}
      foot={
        <>
          Already have an account? <Link to="/login">Sign in</Link>.
        </>
      }
      legal={
        <>
          By creating an account you agree to the{" "}
          <a href="https://shell.online/security/">security model</a> and the way{" "}
          shell.online handles session metadata. Terminal content stays
          end-to-end encrypted either way.
        </>
      }
    >
      {formError && <Alert tone="error">{formError}</Alert>}

      <form onSubmit={handleSubmit} noValidate>
        <Field
          label="Name"
          value={name}
          onChange={setName}
          autoComplete="name"
          placeholder="Ana Ferreira"
          error={fieldErrors.name}
          disabled={busy}
          autoFocus
        />

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          placeholder="you@company.com"
          error={fieldErrors.email}
          disabled={busy}
        />

        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          note="8 characters minimum. Longer beats complicated."
          error={fieldErrors.password}
          disabled={busy}
          strength
        />

        <Button
          type="submit"
          busy={pending === "email"}
          busyLabel="Creating account"
          disabled={busy}
        >
          Create account
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
