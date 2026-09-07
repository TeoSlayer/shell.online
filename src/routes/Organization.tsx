import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, Check, Trash, UserPlus, PencilSimple } from "@phosphor-icons/react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import {
  changeMemberRole,
  createInvite,
  fetchOrg,
  removeMember,
  renameOrg,
  revokeInvite,
  type Invite,
  type Member,
  type OrgView,
} from "../lib/api";
import { ago } from "../lib/time";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function inviteLink(invite: Invite): string {
  return `${window.location.origin}/join/${invite.id}`;
}

function InviteRow({
  invite,
  canManage,
  onRevoke,
}: {
  invite: Invite;
  canManage: boolean;
  onRevoke: (invite: Invite) => void;
}) {
  const [copied, setCopied] = useState(false);
  const spent = Boolean(invite.acceptedAt || invite.revokedAt) || invite.expiresAt < Date.now();

  return (
    <li className="session" data-live={!spent}>
      <div className="session-main">
        <span className="session-command">{invite.email || "anyone with the link"}</span>
        <span className="session-meta">
          {ROLE_LABEL[invite.role]}
          {" · "}
          {invite.acceptedAt
            ? `accepted ${ago(invite.acceptedAt, Date.now())}`
            : invite.revokedAt
              ? "revoked"
              : invite.expiresAt < Date.now()
                ? "expired"
                : `expires ${ago(invite.expiresAt, Date.now()).replace(" ago", "")} from now`}
        </span>
      </div>
      <div className="session-actions">
        {!spent && (
          <button
            type="button"
            className="session-copy"
            title="Copy the invite link"
            aria-label={copied ? "Link copied" : "Copy invite link"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(inviteLink(invite));
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              } catch {
                /* clipboard is unavailable outside a secure context */
              }
            }}
          >
            {copied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
          </button>
        )}
        {!spent && canManage && (
          <button type="button" className="session-action" onClick={() => onRevoke(invite)}>
            <Trash size={14} />
            Revoke
          </button>
        )}
      </div>
    </li>
  );
}

export function Organization() {
  const [view, setView] = useState<OrgView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchOrg();
      setView(result);
      setDraftName(result.organization.name);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the organization.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const you = view?.you;
  const isOwner = you?.role === "owner";
  const canInvite = you?.role === "owner" || you?.role === "admin";

  async function act(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
      setNotice(done);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    await act(
      () => createInvite({ role: inviteRole, email: inviteEmail.trim() || undefined }),
      "Invite created. Copy the link and send it.",
    );
    setInviteEmail("");
  }

  return (
    <AppShell
      title="Organization"
      aside={
        view ? (
          <span className="topbar-count">
            {view.members.length} {view.members.length === 1 ? "member" : "members"}
          </span>
        ) : null
      }
    >
      {error && <div className="sessions-alert"><Alert tone="error">{error}</Alert></div>}
      {notice && <div className="sessions-alert"><Alert tone="success">{notice}</Alert></div>}

      {!view ? (
        <div className="sessions-skeleton" aria-hidden="true">
          <span />
          <span />
        </div>
      ) : (
        <>
          <section className="sessions-group">
            <h2>Name</h2>
            {renaming ? (
              <form
                className="org-rename"
                onSubmit={async (event) => {
                  event.preventDefault();
                  await act(() => renameOrg(draftName), "Renamed.");
                  setRenaming(false);
                }}
              >
                <input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  aria-label="Organization name"
                  autoFocus
                />
                <Button type="submit" busy={busy} busyLabel="Saving">
                  Save
                </Button>
                <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="org-name">
                <span>{view.organization.name}</span>
                {isOwner && (
                  <button type="button" className="session-action" onClick={() => setRenaming(true)}>
                    <PencilSimple size={14} />
                    Rename
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="sessions-group">
            <h2>Members</h2>
            <ul className="sessions-list">
              {view.members.map((member) => (
                <MemberRow
                  key={member.uid}
                  member={member}
                  you={you!}
                  busy={busy}
                  onRemove={() =>
                    act(() => removeMember(member.uid), `Removed ${member.email}.`)
                  }
                  onRole={(role) =>
                    act(() => changeMemberRole(member.uid, role), `${member.email} is now ${role}.`)
                  }
                />
              ))}
            </ul>
          </section>

          {canInvite && (
            <section className="sessions-group">
              <h2>Invite someone</h2>
              <form className="org-invite" onSubmit={handleInvite}>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="their@email.com (optional)"
                  aria-label="Email to invite"
                  autoComplete="off"
                />
                <select
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value)}
                  aria-label="Role"
                >
                  <option value="member">Member</option>
                  {isOwner && <option value="admin">Admin</option>}
                </select>
                <Button type="submit" busy={busy} busyLabel="Creating">
                  <UserPlus size={15} weight="bold" />
                  Create invite
                </Button>
              </form>
              <p className="sessions-note">
                An invite link works once and expires in seven days. Leaving the
                email blank lets anyone with the link join, so send it carefully.
              </p>

              {view.invites.length > 0 && (
                <ul className="sessions-list">
                  {view.invites.map((invite) => (
                    <InviteRow
                      key={invite.id}
                      invite={invite}
                      canManage={canInvite}
                      onRevoke={(target) =>
                        act(() => revokeInvite(target.id), "Invite revoked.")
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}

function MemberRow({
  member,
  you,
  busy,
  onRemove,
  onRole,
}: {
  member: Member;
  you: Member;
  busy: boolean;
  onRemove: () => void;
  onRole: (role: string) => void;
}) {
  const isYou = member.uid === you.uid;
  const rank = { owner: 3, admin: 2, member: 1 };
  const canAct = !isYou && rank[you.role] > rank[member.role];

  return (
    <li className="session">
      <div className="session-main">
        <span className="session-command">
          {member.name || member.email}
          {isYou && <span className="member-you">you</span>}
        </span>
        <span className="session-meta">
          {member.email} · {ROLE_LABEL[member.role]} · joined{" "}
          {ago(member.joinedAt, Date.now())}
        </span>
      </div>
      <div className="session-actions">
        {you.role === "owner" && !isYou && member.role !== "owner" && (
          <select
            className="launcher-machine"
            value={member.role}
            onChange={(event) => onRole(event.target.value)}
            disabled={busy}
            aria-label={`Role for ${member.email}`}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        )}
        {canAct && (
          <button type="button" className="session-action" onClick={onRemove} disabled={busy}>
            <Trash size={14} />
            Remove
          </button>
        )}
      </div>
    </li>
  );
}
