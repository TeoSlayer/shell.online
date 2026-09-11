import { useId, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { WarningCircle } from "@phosphor-icons/react";
import { AuthShell } from "../components/AuthShell";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { GoogleMark } from "../components/GoogleMark";
import { useAuth } from "../auth/AuthProvider";
import { authErrorMessage } from "../lib/auth-errors";
import { renameOrg } from "../lib/api";
import { usePageTitle } from "../lib/page-title";
import { suggestedTeamName } from "../lib/team-name";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function SignUp() {
  usePageTitle("Create an account");
  const { signUp, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  /*
   * `shell login` sends people here with the authorize request it is waiting
   * on. Landing them on the sessions page instead would leave the terminal
   * hanging on a request they can no longer reach.
   */
  const destination = (location.state as { from?: string } | null)?.from ?? "/sessions";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [team, setTeam] = useState("");
  /*
   * Signing up creates a team. Naming it here rather than leaving a
   * guess derived from the email address means the first thing colleagues see
   * on an invite is a name somebody chose.
   */
  const suggestion = suggestedTeamName(email, name);
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
    if (!team.trim() && !suggestion) {
      next.team = "Give your team a name.";
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
      await nameTheTeam();
      navigate(destination, { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    } finally {
      setPending("none");
    }
  }

  /**
   * Names the team signing up just created.
   *
   * The team is made on the first authenticated call, so this is that
   * call: it establishes one and renames it in a single step. Best effort --
   * an account that exists with a guessed team name is a far better
   * outcome than a sign-up that appears to fail after the account was already
   * created, and the name is editable on the team page.
   */
  async function nameTheTeam() {
    const chosen = team.trim() || suggestion;
    if (!chosen) return;
    try {
      await renameOrg(chosen);
    } catch {
      /* Ignored on purpose; see above. */
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
      await nameTheTeam();
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
          Already have an account?{" "}
          <Link to="/login" state={location.state}>
            Sign in
          </Link>
          .
        </>
      }
      legal={
        <>
          Terminal output stays end-to-end encrypted. What you type into a
          session from the browser is recorded in your team&rsquo;s audit log,
          end-to-end encrypted so your team can read it and shell.online
          cannot. Session details such as the command line are visible to
          your team. The{" "}
          <a href="https://shell.online/security/">security model</a> covers the
          cryptography, and the{" "}
          <Link to="/terms#activity-records">terms</Link> list what is kept.
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
          label="Team"
          value={team}
          onChange={setTeam}
          autoComplete="organization"
          placeholder={suggestion || "Vulture Labs"}
          error={fieldErrors.team}
          note="Your team's space. You can rename it later."
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
              </Link>{" "}
              and have read the{" "}
              <Link to="/privacy" target="_blank" rel="noreferrer">
                privacy policy
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
