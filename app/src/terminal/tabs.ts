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

export type TabAction =
  | { type: "open"; session: SessionRecord; canType?: boolean }
  | { type: "close"; id: string }
  | { type: "select"; id: string | null };

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

      const tab: Tab = {
        id: session.id,
        label: session.name?.trim() || session.command,
        command: session.command,
        shareUrl: session.shareUrl,
        readOnly: session.readOnly,
        keyShare: session.keyShare,
        canType: action.canType ?? true,
      };
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

    case "select":
      if (action.id !== null && !state.tabs.some((tab) => tab.id === action.id)) {
        return state;
      }
      return { ...state, activeId: action.id };

    default:
      return state;
  }
}
