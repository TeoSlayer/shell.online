import { kindForCommand } from "../../lib/session-kinds";
import type { Member, SessionRecord } from "../../lib/api";
import { workFor, type Work } from "../world/work";
import type { HeroInput, SoldierInput } from "../world/sim";

export { workFor };
export type { Work };

/**
 * The team and its sessions, as the field needs them.
 *
 * The join this whole file exists for: **a soldier belongs to the hero who owns
 * its session.** Ten Claude Code sessions and three OpenClaw sessions owned by
 * one person are thirteen soldiers of two classes, all of them hers.
 *
 * `kindForCommand` is reused rather than reimplemented. It already knows that
 * `claude --resume abc` is Claude Code and that `npm run claude-thing` is not,
 * including how to see through the `sh -c` wrapper a browser-started session
 * arrives in. A second copy of that knowledge here would drift, and the game
 * would start disagreeing with the session list about what things are.
 */

export interface Roster {
  heroes: HeroInput[];
  soldiers: SoldierInput[];
  youUid?: string;
}

/**
 * Whether a session is still running, and so still has a soldier.
 *
 * A closed session is work that is finished. It counts towards experience,
 * which the service works out separately; it does not stand on the field.
 */
export function isOnTheField(session: SessionRecord): boolean {
  return session.closedAt === undefined;
}

/**
 * Whose session this is.
 *
 * Rows from before sessions recorded an owner have none, and a soldier with no
 * hero is a figure standing in open country with nobody to follow. So: the
 * owner if there is one, else whoever it was handed to, else the person looking
 * at it -- who can only be seeing it because it is theirs or their team's, and
 * of those two the first is much the likelier for a row this old.
 */
export function ownerOf(session: SessionRecord, viewerUid: string): string {
  return (
    session.ownerUid ??
    session.assigneeUids?.[0] ??
    session.assigneeUid ??
    viewerUid
  );
}

/** What to call somebody: their name, or the part of their address before the @. */
export function nameOf(member: { name?: string; email?: string; uid: string }): string {
  const named = member.name?.trim();
  if (named) return named;
  const email = member.email ?? "";
  const local = email.slice(0, email.indexOf("@"));
  return local || member.uid.slice(0, 8);
}

/**
 * Which class a hero is drawn as.
 *
 * The harness they run most. Their own chosen class is in their own saved game,
 * which this account cannot read for anybody else -- and asking the service to
 * publish it would be storing a second fact that can disagree with the first.
 * What everybody *can* see is what a colleague is running, so that is what
 * decides how they are drawn, and it has the advantage of being true.
 *
 * Your own choice still wins for your own hero; `GameRoute` applies it, because
 * only your browser knows it.
 */
export function classFor(sessions: SessionRecord[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const kind = kindForCommand(session.command).id;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let best = "terminal";
  let most = 0;
  /* Sorted, so a tie does not depend on the order sessions came back in. */
  for (const kind of [...counts.keys()].sort()) {
    const count = counts.get(kind) ?? 0;
    if (count > most) {
      most = count;
      best = kind;
    }
  }
  return best;
}

export function rosterFrom(
  sessions: SessionRecord[],
  members: Member[],
  you?: { uid: string },
  /**
   * The class this browser's owner chose for themselves.
   *
   * It wins for their own hero and nobody else's, because it lives in their own
   * saved game and only this browser can read it. Everybody else is drawn as
   * the harness they run most, which is the only thing about a colleague that
   * is both visible and true.
   */
  yourClass?: string,
): Roster {
  const viewerUid = you?.uid ?? "";
  const live = sessions.filter(isOnTheField);

  const byOwner = new Map<string, SessionRecord[]>();
  for (const session of live) {
    const owner = ownerOf(session, viewerUid);
    const held = byOwner.get(owner) ?? [];
    held.push(session);
    byOwner.set(owner, held);
  }

  /*
   * Every member is a hero, whether or not they have anything running. A
   * colleague with nothing open is still on the team, so they are still
   * somewhere on the map; it is the soldiers around them that come and go.
   *
   * An owner who is not on the member list gets a hero too. That happens when
   * somebody has left the team and their session is still running, and a
   * session with no hero would be a soldier standing in open country with
   * nobody to follow.
   */
  const uids = new Set<string>([...members.map((member) => member.uid), ...byOwner.keys()]);
  const named = new Map(members.map((member) => [member.uid, member]));

  const heroes: HeroInput[] = [...uids].sort().map((uid) => {
    const member = named.get(uid);
    return {
      uid,
      name: member ? nameOf(member) : `${uid.slice(0, 8)} (left the team)`,
      characterClass:
        uid === you?.uid && yourClass ? yourClass : classFor(byOwner.get(uid) ?? []),
    };
  });

  const soldiers: SoldierInput[] = live.map((session) => ({
    id: session.id,
    name: session.name?.trim() || session.command,
    kind: kindForCommand(session.command).id,
    work: workFor(session.name || session.command || ""),
    heroUid: ownerOf(session, viewerUid),
    session: {
      id: session.id,
      startedAt: session.startedAt,
      host: session.host,
      command: session.command,
    },
  }));

  return { heroes, soldiers, youUid: you?.uid };
}
