import type { Member } from "./api";

/**
 * Who a session's password goes to.
 *
 * This is the whole of the access rule. A colleague who was not sealed to
 * holds nothing: not a weaker copy, not a copy the service could hand over,
 * nothing. So the two questions here — who can be offered the password, and
 * who still needs it sealed to them — are worth having on their own rather
 * than inside a component where they cannot be tested.
 */

/**
 * Splits the team into people a password can reach and people it cannot.
 *
 * A member who has not set up their vault has no key to seal to, so there is
 * nowhere to send them anything. Offering them a tick box would be offering
 * something that silently does nothing.
 */
export function shareCandidates(
  members: Member[],
  you: Member | null,
): { reachable: Member[]; unreachable: Member[] } {
  const others = members.filter((member) => member.uid !== you?.uid);
  return {
    reachable: others.filter((member) => Boolean(member.accountKey)),
    unreachable: others.filter((member) => !member.accountKey),
  };
}

/**
 * Who still needs this session's password sealed to them.
 *
 * Chosen, reachable, not you, and not already done. The chosen list used to be
 * missing from this: every session was sealed to the whole team the moment it
 * started, so everyone could open everything and nobody was ever asked.
 */
export function sealTargets(input: {
  members: Member[];
  you: Member | null;
  /** The people picked for this session. */
  chosen: readonly string[];
  /** The people already sealed to in this browser's lifetime. */
  done?: ReadonlySet<string>;
}): Member[] {
  const chosen = new Set(input.chosen);
  const done = input.done ?? new Set<string>();
  return shareCandidates(input.members, input.you).reachable.filter(
    (member) => chosen.has(member.uid) && !done.has(member.uid),
  );
}

/**
 * Assignees whose copy can be sealed without asking anyone.
 *
 * Being made responsible for a session should mean being able to open it. But
 * the list of assignees comes from the service, and a service that could name
 * anyone an assignee and have the password sealed to them would be choosing
 * who reads the session. So only assignees whose key this browser already
 * trusts, because it has sealed to that key before, go without asking. The
 * rest are offered to the owner on the session page, and anyone the owner
 * assigns from their own browser is sealed to there and then.
 */
export function trustedAssignees(input: {
  assignees: readonly string[];
  members: Member[];
  you: Member | null;
  /** Who already holds a copy. */
  holders: readonly string[];
  /** Whether this browser has sealed to this member's current key before. */
  isKnown: (member: Member) => boolean;
}): Member[] {
  const assigned = new Set(input.assignees);
  const holders = new Set(input.holders);
  return shareCandidates(input.members, input.you).reachable.filter(
    (member) => assigned.has(member.uid) && !holders.has(member.uid) && input.isKnown(member),
  );
}
