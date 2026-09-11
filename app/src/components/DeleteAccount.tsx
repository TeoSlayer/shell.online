import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FirebaseError } from "firebase/app";
import { Button } from "./Button";
import { Field } from "./Field";
import { Alert } from "./Alert";
import { useAuth } from "../auth/AuthProvider";
import { fetchOrg, type OrgView } from "../lib/api";
import { authErrorMessage } from "../lib/auth-errors";
import { emailMatches, successorFor } from "../lib/account-deletion";

/*
 * What deleting an account removes, said before it happens. The list follows
 * what the service does (Store.deleteAccount), and the team lines depend on
 * who else is in it, so the roster is fetched rather than assumed.
 */
export function DeleteAccount({ onCancel }: { onCancel: () => void }) {
  const { user, deleteAccount } = useAuth();
  const navigate = useNavigate();
  const [org, setOrg] = useState<OrgView | null>(null);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOrg()
      .then((view) => {
        if (!cancelled) setOrg(view);
      })
      .catch(() => {
        /* The list still reads correctly without the team's details. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) return null;

  const usesPassword = user.providerData.some((entry) => entry.providerId === "password");
  const teamName = org?.organization.name ?? "your team";
  const others = org ? org.members.filter((entry) => entry.uid !== user.uid) : [];
  const successor = org?.you.role === "owner" ? successorFor(org.members, user.uid) : undefined;
  const ready = emailMatches(confirm, user.email) && (!usesPassword || password.length > 0);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setError("");
    setBusy(true);
    try {
      await deleteAccount(confirm, usesPassword ? password : undefined);
      navigate("/login", { replace: true, state: { deleted: true } });
    } catch (caught) {
      setError(deletionError(caught));
      setBusy(false);
    }
  }

  return (
    <section className="consent-card vault-card account-delete" aria-labelledby="account-delete-title">
      <h2 id="account-delete-title">Delete your account?</h2>
      <p>This cannot be undone. Deleting your account:</p>
      <ul className="account-delete-list">
        <li>removes your sign-in;</li>
        <li>
          unlinks every machine you linked, so <code>shell</code> on them stops
          publishing sessions;
        </li>
        <li>
          deletes your sessions, the passwords sealed to you, your vault, your
          comments and your notifications;
        </li>
        {org && others.length === 0 && (
          <li>deletes {teamName} and everything in it, since nobody else is in it;</li>
        )}
        {others.length > 0 && (
          <li>
            keeps what you typed into sessions in {teamName}&rsquo;s activity
            trail, no longer linked to your email address;
          </li>
        )}
        {successor && (
          <li>
            makes <b>{successor.name || successor.email}</b> the owner of {teamName};
          </li>
        )}
        <li>clears your vault key and cached passwords from this browser.</li>
      </ul>
      <p className="account-delete-note">
        Share links you already gave out keep working until those sessions end.
        The <Link to="/privacy">privacy policy</Link> has the details.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      <form onSubmit={handleSubmit} noValidate>
        <Field
          label="Type your email to confirm"
          type="email"
          value={confirm}
          onChange={setConfirm}
          autoComplete="off"
          placeholder={user.email ?? ""}
          disabled={busy}
        />
        {usesPassword ? (
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            disabled={busy}
          />
        ) : (
          <p className="account-delete-note">You will be asked to sign in with Google once more.</p>
        )}
        <div className="account-delete-actions">
          <Button type="submit" variant="danger" disabled={!ready} busy={busy} busyLabel="Deleting">
            Delete account
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Keep my account
          </Button>
        </div>
      </form>
    </section>
  );
}

function deletionError(error: unknown): string {
  if (
    error instanceof FirebaseError &&
    (error.code === "auth/invalid-credential" || error.code === "auth/wrong-password")
  ) {
    return "That password is not right.";
  }
  return authErrorMessage(error);
}
