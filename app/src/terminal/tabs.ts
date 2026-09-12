import type { SessionRecord } from "../lib/api";

export interface Tab {
  id: string;
  /** What to show on the tab: the operator's name, else the command. */
  label: string;
  command: string;
  shareUrl: string;
  readOnly: boolean;
  keyShare?: { senderPublicKey: string; sealed: string };
  canType: boolean;
}

export interface TabState {
  tabs: Tab[];
  /** null means the session list is showing. */
  activeId: string | null;
}

export const EMPTY: TabState = { tabs: [], activeId: null };

export const MAX_TABS = 8;

/**
 * Resolves an `?open=` request against the current live session list.
 *
 * The detail page uses this route to hand one exact session back to the
 * workspace. Keeping the lookup here makes two important rules explicit and
 * testable: ids are exact (never prefixes), and a process that finished while
 * the person was reading its details is not reopened as a dead terminal tab.
 */
export function sessionToOpen(
  sessions: readonly SessionRecord[],
  requestedId: string | null,
): SessionRecord | null {
  if (!requestedId) return null;
  return sessions.find((session) => session.id === requestedId && !session.closedAt) ?? null;
}

export type TabAction =
  | { type: "open"; session: SessionRecord; canType?: boolean }
  | { type: "close"; id: string }
  | { type: "select"; id: string | null }
  | { type: "restore"; tabs: Tab[]; activeId: string | null };

/** What a tab holds about the session it was opened from. */
export function tabFor(session: SessionRecord, canType: boolean): Tab {
  return {
    id: session.id,
    label: session.name?.trim() || session.command,
    command: session.command,
    shareUrl: session.shareUrl,
    readOnly: session.readOnly,
    keyShare: session.keyShare,
    canType,
  };
}

/**
 * Tab bookkeeping, kept apart from React so the rules are testable.
 *
 * Opening a session that is already open selects it rather than opening a
 * second copy: two panes on one session would fight over the shared PTY size.
 */
export function reduce(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "open": {
      const { session } = action;
      /*
       * Reopening refreshes the tab rather than only selecting it. What it
       * holds is a copy of the session taken when it was opened, and the
       * parts that matter change underneath it: a session handed to someone
       * while they had it open kept the old answer to whether they may type,
       * and the sealed password they were later given never arrived.
       */
      const existing = state.tabs.find((tab) => tab.id === session.id);
      if (existing) {
        const refreshed: Tab = {
          ...existing,
          label: session.name?.trim() || session.command,
          command: session.command,
          shareUrl: session.shareUrl,
          readOnly: session.readOnly,
          keyShare: session.keyShare ?? existing.keyShare,
          canType: action.canType ?? existing.canType,
        };
        return {
          tabs: state.tabs.map((tab) => (tab.id === existing.id ? refreshed : tab)),
          activeId: existing.id,
        };
      }

      const tab = tabFor(session, action.canType ?? true);
      /* Oldest goes when the cap is reached, and never the one being opened. */
      const tabs = [...state.tabs, tab].slice(-MAX_TABS);
      return { tabs, activeId: tab.id };
    }

    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);

      /* Spreading state here would put the unfiltered tabs back. */
      if (state.activeId !== action.id) return { tabs, activeId: state.activeId };
      /* Closing the active tab lands on its neighbour, not back at the list. */
      const neighbour = tabs[index] ?? tabs[index - 1] ?? null;
      return { tabs, activeId: neighbour?.id ?? null };
    }

    /*
     * The tabs a reload found, rebuilt from the session list. It loses to
     * anything already open: the list arrives a moment after the page does, and
     * a session opened in that moment is a deliberate act, not a leftover.
     */
    case "restore": {
      if (state.tabs.length > 0) return state;
      const tabs = action.tabs.slice(-MAX_TABS);
      const active = tabs.some((tab) => tab.id === action.activeId) ? action.activeId : null;
      return { tabs, activeId: active };
    }

    case "select":
      if (action.id !== null && !state.tabs.some((tab) => tab.id === action.id)) {
        return state;
      }
      return { ...state, activeId: action.id };

    default:
      return state;
  }
}
