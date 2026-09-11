import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Copy, Check, Trash, UserPlus, PencilSimple, Warning, MagnifyingGlass, X } from "@phosphor-icons/react";
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
import { usePageTitle } from "../lib/page-title";
import { COPY_FAILED, useCopy } from "../lib/clipboard";
import { SearchSelect } from "../components/SearchSelect";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const MEMBER_ROLES = [
  { value: "all", label: "All roles", detail: "Owners, admins, and members" },
  { value: "owner", label: "Owners", detail: "Full organization control" },
  { value: "admin", label: "Admins", detail: "Can invite and manage sessions" },
  { value: "member", label: "Members", detail: "Standard team access" },
];

const INVITE_STATES = [
  { value: "all", label: "All invites", detail: "Every invite status" },
  { value: "live", label: "Waiting", detail: "Can still be accepted" },
  { value: "accepted", label: "Accepted", detail: "Already used" },
  { value: "expired", label: "Expired", detail: "Past its expiry time" },
  { value: "revoked", label: "Revoked", detail: "Cancelled by the team" },
];

function inviteStateKey(invite: Invite): string {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt < Date.now()) return "expired";
  return "live";
}

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
  const { state, copy } = useCopy();
  const copied = state === "copied";
  const failed = state === "failed";
  return (
    <>
      <button
        type="button"
        className="session-action"
        onClick={() => void copy(inviteLink(invite))}
      >
        {failed ? (
          <Warning size={14} weight="fill" />
        ) : copied ? (
          <Check size={14} weight="bold" />
        ) : (
          <Copy size={14} />
        )}
        {copied ? "Copied" : "Copy link"}
      </button>
      {/*
        The link is the invite. If the clipboard refused it, saying nothing
        sends somebody away believing they have it, so the address is put on
        screen to be copied by hand.
      */}
      {failed && (
        <span className="copy-fallback" role="status">
          {COPY_FAILED}
          <code>{inviteLink(invite)}</code>
        </span>
      )}
    </>
  );
}

export function Team() {
  usePageTitle("Team");
  const [view, setView] = useState<OrgView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberRole, setMemberRole] = useState("all");
  const [inviteQuery, setInviteQuery] = useState("");
  const [inviteStatus, setInviteStatus] = useState("all");

  const load = useCallback(async () => {
    try {
      /* No browser key is published any more: colleagues seal to the vault. */
      const result = await fetchOrg();
      setView(result);
      setDraftName(result.organization.name);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the team.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const you = view?.you;
  const isOwner = you?.role === "owner";
  const canInvite = you?.role === "owner" || you?.role === "admin";
  const visibleMembers = useMemo(() => {
    const needle = memberQuery.trim().toLocaleLowerCase();
    return (view?.members ?? []).filter((member) => {
      if (memberRole !== "all" && member.role !== memberRole) return false;
      return !needle || [displayName(member), member.email, member.role]
        .some((part) => part.toLocaleLowerCase().includes(needle));
    });
  }, [view, memberQuery, memberRole]);
  const visibleInvites = useMemo(() => {
    const needle = inviteQuery.trim().toLocaleLowerCase();
    return (view?.invites ?? []).filter((invite) => {
      if (inviteStatus !== "all" && inviteStateKey(invite) !== inviteStatus) return false;
      const target = invite.email || "Anyone with the link";
      return !needle || [target, invite.role, inviteState(invite).label]
        .some((part) => part.toLocaleLowerCase().includes(needle));
    });
  }, [view, inviteQuery, inviteStatus]);

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
      title="Team"
      aside={
        view ? (
          <span className="topbar-count">
            {view.members.length} {view.members.length === 1 ? "member" : "members"}
          </span>
        ) : null
      }
    >
      {error && (
        <div className="sessions-alert sessions-error">
          <Alert tone="error">
            <span>{error}</span>
            <button
              type="button"
              className="inline-retry"
              onClick={() => {
                setError("");
                setView(null);
                void load();
              }}
            >
              Retry
            </button>
          </Alert>
        </div>
      )}
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
                  aria-label="Team name"
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
              <div className="team-name">
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
            <div className="list-toolbar">
              <label className="sessions-search">
                <MagnifyingGlass size={15} />
                <input
                  type="search"
                  value={memberQuery}
                  onChange={(event) => setMemberQuery(event.target.value)}
                  placeholder="Search people or email"
                  aria-label="Search team members"
                />
                {memberQuery && (
                  <button type="button" className="search-clear" onClick={() => setMemberQuery("")} aria-label="Clear member search">
                    <X size={12} weight="bold" />
                  </button>
                )}
              </label>
              <SearchSelect
                label="Member role"
                value={memberRole}
                options={MEMBER_ROLES}
                onChange={setMemberRole}
                searchable={false}
                align="right"
              />
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col" className="table-optional">Joined</th>
                  <th scope="col" className="table-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleMembers.map((member) => {
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
                      <td className="table-quiet table-optional">{ago(member.joinedAt, Date.now())}</td>
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
                {visibleMembers.length === 0 && (
                  <tr className="filtered-table-empty">
                    <td colSpan={5}>
                      No members match those filters.{" "}
                      <button type="button" onClick={() => { setMemberQuery(""); setMemberRole("all"); }}>
                        Clear filters
                      </button>
                    </td>
                  </tr>
                )}
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
              <h2 className="invites-heading">Invites</h2>

              {view.invites.length > 0 && (
                <>
                  <div className="list-toolbar invites-toolbar">
                    <label className="sessions-search">
                      <MagnifyingGlass size={15} />
                      <input
                        type="search"
                        value={inviteQuery}
                        onChange={(event) => setInviteQuery(event.target.value)}
                        placeholder="Search invite email"
                        aria-label="Search invites"
                      />
                      {inviteQuery && (
                        <button type="button" className="search-clear" onClick={() => setInviteQuery("")} aria-label="Clear invite search">
                          <X size={12} weight="bold" />
                        </button>
                      )}
                    </label>
                    <SearchSelect
                      label="Invite status"
                      value={inviteStatus}
                      options={INVITE_STATES}
                      onChange={setInviteStatus}
                      searchable={false}
                      align="right"
                    />
                  </div>
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
                    {visibleInvites.map((invite) => {
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
                    {visibleInvites.length === 0 && (
                      <tr className="filtered-table-empty">
                        <td colSpan={4}>
                          No invites match those filters.{" "}
                          <button type="button" onClick={() => { setInviteQuery(""); setInviteStatus("all"); }}>
                            Clear filters
                          </button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                  </table>
                </>
              )}
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}
