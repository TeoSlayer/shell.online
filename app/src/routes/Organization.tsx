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
  type OrgView,
} from "../lib/api";
import { ago } from "../lib/time";
import { Avatar } from "../components/Avatar";
import { displayName } from "../lib/people";
import { publicKey } from "../lib/keypair";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function inviteLink(invite: Invite): string {
  return `${window.location.origin}/join/${invite.id}`;
}

function inviteState(invite: Invite): { label: string; live: boolean } {
  if (invite.acceptedAt) return { label: `Accepted ${ago(invite.acceptedAt, Date.now())}`, live: false };
  if (invite.revokedAt) return { label: "Revoked", live: false };
  if (invite.expiresAt < Date.now()) return { label: "Expired", live: false };
  return { label: "Waiting to be used", live: true };
}

function CopyInvite({ invite }: { invite: Invite }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="session-action"
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
      {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
      {copied ? "Copied" : "Copy link"}
    </button>
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
      const result = await fetchOrg(undefined, await publicKey());
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
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Joined</th>
                  <th scope="col" className="table-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.members.map((member) => {
                  const isYou = member.uid === you!.uid;
                  const rank = { owner: 3, admin: 2, member: 1 } as const;
                  const canAct = !isYou && rank[you!.role] > rank[member.role];
                  return (
                    <tr key={member.uid}>
                      <td>
                        <span className="person">
                          <Avatar person={member} size="md" />
                          <span className="person-text">
                            <span className="member-name">
                              {displayName(member)}
                              {isYou && <span className="member-you">you</span>}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="table-quiet">{member.email}</td>
                      <td>
                        {you!.role === "owner" && !isYou && member.role !== "owner" ? (
                          <select
                            className="row-select"
                            value={member.role}
                            onChange={(event) =>
                              act(
                                () => changeMemberRole(member.uid, event.target.value),
                                `${displayName(member)} is now ${event.target.value}.`,
                              )
                            }
                            disabled={busy}
                            aria-label={`Role for ${displayName(member)}`}
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                        ) : (
                          <span className="role-badge" data-role={member.role}>
                            {ROLE_LABEL[member.role]}
                          </span>
                        )}
                      </td>
                      <td className="table-quiet">{ago(member.joinedAt, Date.now())}</td>
                      <td className="table-end">
                        {canAct && (
                          <button
                            type="button"
                            className="session-action"
                            onClick={() =>
                              act(
                                () => removeMember(member.uid),
                                `Removed ${displayName(member)}.`,
                              )
                            }
                            disabled={busy}
                          >
                            <Trash size={14} />
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
                Give an address and we email them the link. Leaving it blank
                creates a link anyone can use, so send that one carefully.
                Either way it works once and expires in seven days.
              </p>

              <h2 className="invites-heading">Invites</h2>

              {view.invites.length > 0 && (
                <table className="table invites-table">
                  <thead>
                    <tr>
                      <th scope="col">Invited</th>
                      <th scope="col">Role</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="table-end">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.invites.map((invite) => {
                      const state = inviteState(invite);
                      return (
                        <tr key={invite.id} data-live={state.live}>
                          <td>
                            <span className="invite-target" data-open={!invite.email}>
                              {invite.email || "Anyone with the link"}
                            </span>
                          </td>
                          <td>
                            <span className="role-badge" data-role={invite.role}>
                              {ROLE_LABEL[invite.role]}
                            </span>
                          </td>
                          <td className="table-quiet">{state.label}</td>
                          <td className="table-end">
                            {state.live && (
                              <div className="session-actions">
                                <CopyInvite invite={invite} />
                                {canInvite && (
                                  <button
                                    type="button"
                                    className="session-action"
                                    onClick={() =>
                                      act(() => revokeInvite(invite.id), "Invite revoked.")
                                    }
                                    disabled={busy}
                                  >
                                    <Trash size={14} />
                                    Revoke
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
