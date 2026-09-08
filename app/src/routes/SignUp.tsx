import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { WarningCircle } from "@phosphor-icons/react";
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
  const [accepted, setAccepted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState<"none" | "email" | "google">("none");
  const termsId = useId();

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
    if (!accepted) {
      next.terms = "Accept the terms of service to create an account.";
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
    /*
     * Google creates the account too, so it has to pass the same gate. An
     * acceptance the person can walk around by choosing the other button is
     * not an acceptance, and this is the button most people press.
     */
    if (!accepted) {
      setFieldErrors({ terms: "Accept the terms of service to create an account." });
      return;
    }
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
          Terminal content stays end-to-end encrypted either way. The{" "}
          <a href="https://shell.online/security/">security model</a> covers the
          cryptography; the terms cover what shell.online records, including the
          audit log everyone in your organization can read.
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

        <div
          className="terms-accept"
          data-invalid={fieldErrors.terms ? "true" : "false"}
        >
          <label className="terms-accept-row" htmlFor={termsId}>
            <input
              id={termsId}
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              disabled={busy}
              aria-invalid={fieldErrors.terms ? true : undefined}
              aria-describedby={
                fieldErrors.terms ? `${termsId}-error` : undefined
              }
            />
            <span>
              I accept the{" "}
              <Link to="/terms" target="_blank" rel="noreferrer">
                terms of service
              </Link>
              .
            </span>
          </label>

          {fieldErrors.terms && (
            <p className="field-error" id={`${termsId}-error`}>
              <WarningCircle size={14} weight="bold" />
              <span>{fieldErrors.terms}</span>
            </p>
          )}
        </div>

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
