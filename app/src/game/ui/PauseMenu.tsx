import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BORING_UI, KEEP_BUILD } from "../keep";
import { useGameShell } from "../state/context";
import { Menu, type MenuItem } from "./Menu";
import { OptionsPanel } from "./OptionsPanel";
import { Prompt } from "./Prompt";

type Pane = "root" | "options";

/**
 * The pause screen.
 *
 * Pausing is the one place a game is allowed to take the whole screen, so it
 * does: the field dims, the simulation stops, and what is left is a short list
 * of the things somebody who has just stopped playing actually wants. The way
 * out is the last item and it says what it does in plain words rather than in
 * character, because a person looking for the exit is no longer playing along.
 */
export function PauseMenu({ onResume }: { onResume: () => void }) {
  const navigate = useNavigate();
  const [pane, setPane] = useState<Pane>("root");
  const { options } = useGameShell();
  const panel = useRef<HTMLDivElement>(null);
  /* Where the root menu was, so Options and back does not reset it. */
  const rootIndex = useRef(0);
  /* Focus goes back where it came from when the menu closes. */
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    return () => returnFocus.current?.focus?.();
  }, []);

  /*
   * A modal that does not hold focus is a modal a keyboard can walk out of
   * while it is still covering the screen, which leaves somebody typing into
   * a page they cannot see.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = panel.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input, select, [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const rootItems: MenuItem[] = [
    {
      id: "resume",
      label: "Resume",
      detail: "Back to the field",
      onSelect: onResume,
    },
    {
      id: "sheet",
      label: "Character sheet",
      detail: "Your class, level and holdings",
      /*
       * Honest rather than hidden: the sheet is not built yet, and a menu item
       * that silently does nothing is worse than one that says why.
       */
      disabled: true,
      onSelect: () => {},
    },
    {
      id: "options",
      label: "Options",
      detail: `Safe area ${options.safeZone}% · Interface ${options.uiScale}%`,
      onSelect: () => setPane("options"),
    },
    {
      id: "quit",
      label: "Quit to boring UI",
      detail: "Back to the session list",
      danger: true,
      onSelect: () => navigate(BORING_UI),
    },
  ];

  return (
    <div className="keep-pause" role="presentation">
      <div
        className="keep-pause-panel keep-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Paused"
        ref={panel}
      >
        <header className="keep-pause-head">
          {/* Icon and word together: never the icon alone, never the colour alone. */}
          <span className="keep-pause-glyph" aria-hidden="true">❙❙</span>
          <h2>{pane === "root" ? "Paused" : "Options"}</h2>
        </header>

        {pane === "root" ? (
          <Menu
            items={rootItems}
            label="Paused"
            onCancel={onResume}
            initialIndex={rootIndex.current}
            onIndexChange={(index) => {
              rootIndex.current = index;
            }}
          />
        ) : (
          <OptionsPanel onBack={() => setPane("root")} />
        )}

        <footer className="keep-pause-foot">
          <Prompt action="cancel" verb={pane === "root" ? "resume" : "go back"} />
          <span className="keep-build">Build {KEEP_BUILD}</span>
        </footer>
      </div>
    </div>
  );
}
