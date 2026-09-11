/**
 * Which sessions were open, so that reloading the page does not close them.
 *
 * A reload is not a decision to stop watching a build; it is a reload. What is
 * remembered is only the ids and which one was in front. Everything else a tab
 * holds — its label, the command, the share link, the password sealed to this
 * browser — is read back from the session list on the next load, so a restored
 * tab is never a stale copy of a session, and nothing is written to this
 * computer that the list would not hand over anyway.
 *
 * Scoped to the account, like the passwords beside it: signing in as somebody
 * else on the same computer must not reopen the previous person's terminals.
 */

const KEY = "shell.online:sessions:tabs:v1";

export interface OpenTabs {
  ids: string[];
  activeId: string | null;
}

const NONE: OpenTabs = { ids: [], activeId: null };

export function readOpenTabs(uid: string): OpenTabs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return NONE;
    const held = JSON.parse(raw) as Partial<OpenTabs> & { uid?: string };
    if (held.uid !== uid) return NONE;
    const ids = Array.isArray(held.ids) ? held.ids.filter((id) => typeof id === "string") : [];
    const activeId = typeof held.activeId === "string" && ids.includes(held.activeId)
      ? held.activeId
      : null;
    return { ids, activeId };
  } catch {
    /* private windows, blocked storage, and anything hand-edited land here */
    return NONE;
  }
}

/** Forgets the open tabs, if they are this account's. Used when it is deleted. */
export function forgetOpenTabs(uid: string): void {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const held = JSON.parse(raw) as { uid?: string };
    if (held.uid === uid) window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export function writeOpenTabs(uid: string, open: OpenTabs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ uid, ...open }));
  } catch {
    /* nothing to do; the tabs simply will not come back */
  }
}
