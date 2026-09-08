import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { useAuth } from "../auth/AuthProvider";
import { usePageTitle } from "../lib/page-title";
import { authErrorMessage } from "../lib/auth-errors";

export function ResetPassword() {
  usePageTitle("Reset your password");
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!email.trim()) {
      setFieldError("Enter the email you signed up with.");
      return;
    }
    setFieldError("");
    setBusy(true);
    try {
      await resetPassword(email);
      setSent(true);
    } catch (error) {
      setFormError(authErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password."
      dek={
        sent
          ? "Open the link in that email to choose a new password. It expires in an hour."
          : "Give us the email on the account and we will send a reset link."
      }
      headLink={{ to: "/login", label: "Sign in" }}
      foot={
        <>
          Remembered it? <Link to="/login">Sign in</Link>.
        </>
      }
    >
      {formError && <Alert tone="error">{formError}</Alert>}

      {sent ? (
        <>
          <Alert tone="success">
            If an account exists for {email.trim()}, a reset link is on its way.
          </Alert>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSent(false);
              setEmail("");
            }}
          >
            Use a different email
          </Button>
        </>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            placeholder="you@company.com"
            error={fieldError}
            disabled={busy}
            autoFocus
          />
          <Button type="submit" busy={busy} busyLabel="Sending link">
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
