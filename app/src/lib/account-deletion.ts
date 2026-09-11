import type { Member } from "./api";

/*
 * Mirrors successorFor on the service, so the confirmation can name who takes
 * over before anything is deleted. The service decides for itself; this only
 * predicts what it will decide.
 */
export function successorFor(members: Member[], leavingUid: string): Member | undefined {
  const others = members.filter((entry) => entry.uid !== leavingUid);
  const byTenure = (a: Member, b: Member) =>
    a.joinedAt - b.joinedAt || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  return (
    others.filter((entry) => entry.role === "admin").sort(byTenure)[0] ??
    [...others].sort(byTenure)[0]
  );
}

/** Whether what was typed is the account's email, ignoring case and spaces. */
export function emailMatches(typed: string, email: string | null | undefined): boolean {
  const expected = (email ?? "").trim().toLowerCase();
  return expected !== "" && typed.trim().toLowerCase() === expected;
}
