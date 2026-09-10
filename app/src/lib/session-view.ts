import type { Member, SessionRecord } from "./api";

/**
 * The rules deciding what a person may do with a session, and which group it
 * belongs in.
 *
 * Kept apart from the page so they can be tested as what they are: four
 * questions with yes-or-no answers. Importing them from the route pulled in
 * Firebase, which cannot start in a test process, so the rules went untested
 * while the component around them grew.
 */

/**
 * Everyone in the team can watch a session. Typing into it belongs to the
 * person who started it and the people it is assigned to.
 */
export function canEdit(session: SessionRecord, you: Member | null): boolean {
  if (!you) return false;
  if (session.readOnly) return false;
  return session.ownerUid === you.uid || assigneeIds(session).includes(you.uid);
}

/** Reads both the current array and the legacy single-assignee shape. */
export function assigneeIds(session: SessionRecord): string[] {
  const ids = session.assigneeUids?.length
    ? session.assigneeUids
    : session.assigneeUid
      ? [session.assigneeUid]
      : [];
  return [...new Set(ids.filter(Boolean))];
}

/** Handing a session over is the owner's to do, or the team's to arrange. */
export function canHandOff(session: SessionRecord, you: Member | null): boolean {
  if (!you) return false;
  return session.ownerUid === you.uid || you.role === "owner" || you.role === "admin";
}

/*
 * Removing the row is not stopping the process, so it is not tied to owning
 * the machine. The person whose session it is can tidy their own list, and
 * whoever runs the team can tidy anybody's.
 */
export function canRemove(session: SessionRecord, you: Member | null): boolean {
  if (!you) return false;
  return session.ownerUid === you.uid || you.role === "owner" || you.role === "admin";
}

/** Stopping controls the owner's local process, so assignment is not enough. */
export function canStop(session: SessionRecord, you: Member | null): boolean {
  return Boolean(you && session.ownerUid === you.uid && session.deviceId);
}

/*
 * Search covers the name somebody gave a session and the command it runs.
 *
 * Not the host or the person: those are columns you can already scan, and
 * matching them would make a search for "claude" return every session on a
 * machine called claude-box.
 */
export function matches(session: SessionRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    (session.name ?? "").toLowerCase().includes(needle) ||
    session.command.toLowerCase().includes(needle)
  );
}
