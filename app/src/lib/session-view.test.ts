import { describe, expect, it } from "vitest";
import { canEdit, canRemove, canStop, matches } from "./session-view";
import type { Member, SessionRecord } from "./api";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    shareUrl: "https://shell.online/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    command: "htop",
    readOnly: false,
    encrypted: true,
    persistent: false,
    host: "ana-mbp",
    startedAt: 1,
    ownerUid: "uid-1",
    ...over,
  };
}

function member(over: Partial<Member> = {}): Member {
  return {
    orgId: "org_1",
    uid: "uid-1",
    email: "ana@example.com",
    name: "Ana",
    role: "member",
    joinedAt: 1,
    ...over,
  };
}

describe("searching sessions", () => {
  it("matches everything when nothing is typed", () => {
    expect(matches(session(), "")).toBe(true);
    expect(matches(session(), "   ")).toBe(true);
  });

  it("matches the command", () => {
    expect(matches(session({ command: "npm run build" }), "build")).toBe(true);
    expect(matches(session({ command: "npm run build" }), "deploy")).toBe(false);
  });

  it("matches the name somebody gave it", () => {
    expect(matches(session({ name: "Nightly deploy" }), "nightly")).toBe(true);
  });

  it("ignores case and stray whitespace, as from a paste", () => {
    expect(matches(session({ command: "HTOP" }), "  htop ")).toBe(true);
  });

  /*
   * The host is deliberately not searched. A machine called claude-box would
   * otherwise answer a search for "claude" with every session on it.
   */
  it("does not match the host", () => {
    expect(matches(session({ host: "claude-box", command: "htop" }), "claude-box")).toBe(false);
  });

  it("has nothing to match when a session has no name", () => {
    expect(matches(session({ name: undefined, command: "htop" }), "nightly")).toBe(false);
  });
});

describe("which column a session belongs in", () => {
  const you = member();

  it("puts a session you own in write", () => {
    expect(canEdit(session({ ownerUid: "uid-1" }), you)).toBe(true);
  });

  it("puts a session assigned to you in write, even though somebody else owns it", () => {
    expect(canEdit(session({ ownerUid: "uid-2", assigneeUid: "uid-1" }), you)).toBe(true);
  });

  it("lets every assignee write to a multi-assigned session", () => {
    expect(
      canEdit(session({ ownerUid: "uid-3", assigneeUids: ["uid-2", "uid-1"] }), you),
    ).toBe(true);
  });

  it("puts a colleague's session in read", () => {
    expect(canEdit(session({ ownerUid: "uid-2" }), you)).toBe(false);
  });

  /* A read-only share is read-only for its owner too: that is what it means. */
  it("puts a read-only session in read whoever is asking", () => {
    expect(canEdit(session({ ownerUid: "uid-1", readOnly: true }), you)).toBe(false);
  });

  it("gives nobody write access when signed out", () => {
    expect(canEdit(session(), null)).toBe(false);
  });
});

describe("who may remove a row, and who may stop a process", () => {
  /*
   * Two different questions. Stopping reaches a machine, so it belongs to
   * whoever owns that machine. Removing is bookkeeping on a list.
   */
  it("lets the owner remove their own", () => {
    expect(canRemove(session({ ownerUid: "uid-1" }), member())).toBe(true);
  });

  it("lets whoever runs the team remove anybody's", () => {
    expect(canRemove(session({ ownerUid: "uid-2" }), member({ role: "admin" }))).toBe(true);
    expect(canRemove(session({ ownerUid: "uid-2" }), member({ role: "owner" }))).toBe(true);
  });

  it("does not let a member remove a colleague's", () => {
    expect(canRemove(session({ ownerUid: "uid-2" }), member({ role: "member" }))).toBe(false);
  });

  it("does not let an admin stop a process on somebody else's machine", () => {
    const theirs = session({ ownerUid: "uid-2", deviceId: "dev_1" });
    expect(canRemove(theirs, member({ role: "admin" }))).toBe(true);
    expect(canStop(theirs, member({ role: "admin" }))).toBe(false);
  });

  it("needs a machine to stop anything on", () => {
    expect(canStop(session({ ownerUid: "uid-1", deviceId: undefined }), member())).toBe(false);
    expect(canStop(session({ ownerUid: "uid-1", deviceId: "dev_1" }), member())).toBe(true);
  });
});
