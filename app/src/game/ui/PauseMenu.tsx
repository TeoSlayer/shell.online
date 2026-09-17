import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BORING_UI, KEEP_BUILD } from "../keep";
import { CLASS_LORE } from "../lore/world";
import type { Purse } from "../state/shop";
import type { Earned } from "../state/progress";
import { useGameShell } from "../state/context";
import { Codex } from "./Codex";
import { Barrow } from "./Barrow";
import { Gathering } from "./Gathering";
import { Marches } from "./Marches";
import { Menu, type MenuItem } from "./Menu";
import { OptionsPanel } from "./OptionsPanel";
import { Prompt } from "./Prompt";
import { Shop } from "./Shop";

type Pane = "root" | "marches" | "barrow" | "gathering" | "options" | "shop" | "codex";

/**
 * The pause screen, and everything reached from it.
 *
 * The field carries four numbers and nothing else; everything a player might
 * want but does not need at a glance lives behind this. That is the whole
 * division: a heads-up display is screen space borrowed from the game, and a
 * pause menu is space that costs nothing because the game has stopped.
 *
 * The way out is the last item and it says what it does in plain words rather
 * than in character, because a person looking for the exit has stopped playing
 * along.
 */
export function PauseMenu({
  onResume,
  purse,
  characterClass,
  wearing,
  livery,
  shopOpen,
  elixir,
  garrison,
  onBuy,
  onWear,
  onTravel,
  gathering,
  onGathering,
  earned,
  counted,
  openAt,
}: {
  onResume: () => void;
  purse: Purse;
  characterClass: string;
  wearing: string;
  /** What this player's soldiers are wearing. */
  livery: string;
  /** The pedlar starts calling at level two; before that the row says so. */
  shopOpen: boolean;
  /** Tokens the gathering has spent, and who is on the field. */
  elixir: number;
  garrison: number;
  onBuy: (skinId: string) => void;
  onWear: (skinId: string) => void;
  /** Rides to a holding and closes the menu. The map is too big to walk. */
  onTravel: (garrisonId: string) => void;
  /** Whether the account has agreed to its machines being read. */
  gathering: boolean;
  onGathering: (on: boolean) => void;
  /** What the finished sessions came to, for the Barrow. */
  earned: Earned;
  counted: boolean;
  /** Which pane to open on, so the vial can lead straight to the bill. */
  openAt?: "gathering";
}) {
  const navigate = useNavigate();
  const [pane, setPane] = useState<Pane>(openAt ?? "root");
  const { options } = useGameShell();
  const panel = useRef<HTMLDivElement>(null);
  /* Where the root menu was, so a side trip does not reset it. */
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

  const lore = CLASS_LORE[characterClass] ?? CLASS_LORE.terminal;

  const rootItems: MenuItem[] = [
    {
      id: "resume",
      label: "Resume",
      detail: "Back to the field",
      onSelect: onResume,
    },
    {
      id: "shop",
      label: "The pedlar",
      detail: shopOpen
        ? `${purse.marks.toLocaleString()} marks to spend`
        : "Starts calling at level 2",
      disabled: !shopOpen,
      onSelect: () => setPane("shop"),
    },
    {
      id: "marches",
      label: "The Marches",
      detail: "Ten holdings, and the road to each",
      onSelect: () => setPane("marches"),
    },
    {
      id: "barrow",
      label: "The Barrow",
      detail: counted
        ? `${earned.sessions.toLocaleString()} sessions run to the end`
        : "Not counted yet",
      onSelect: () => setPane("barrow"),
    },
    {
      id: "gathering",
      label: "The gathering",
      detail: gathering
        ? `${elixir.toLocaleString()} tokens spent`
        : "Off. Nothing is being read",
      onSelect: () => setPane("gathering"),
    },
    {
      id: "codex",
      label: "The Chronicle",
      detail: "What everything here is a name for",
      onSelect: () => setPane("codex"),
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

  const TITLES: Record<Pane, string> = {
    root: "Paused",
    marches: "The Marches",
    barrow: "The Barrow",
    gathering: "The gathering",
    options: "Options",
    shop: "The pedlar",
    codex: "The Chronicle",
  };
  const title = TITLES[pane];

  return (
    <div className="keep-pause" role="presentation">
      <div
        className={`keep-pause-panel keep-panel keep-panel-heavy${pane === "root" ? "" : " is-wide"}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
      >
        <header className="keep-pause-head">
          {/* Icon and word together: never the icon alone, never the colour alone. */}
          <span className="keep-pause-glyph" aria-hidden="true">❙❙</span>
          <h2>{title}</h2>
          {pane === "root" && <span className="keep-pause-who">{lore.title}</span>}
        </header>

        {/*
          * The figures the HUD carries on a wide screen and drops on a narrow
          * one. Here rather than only there, so a phone loses nothing.
          */}
        {pane === "root" && (
          <p className="keep-pause-stats">
            <span>◈ {purse.marks.toLocaleString()} marks</span>
            <span>{garrison} on the field</span>
            <span>{elixir > 0 ? `${elixir.toLocaleString()} tokens` : "not gathering"}</span>
          </p>
        )}

        {pane === "root" && (
          <Menu
            items={rootItems}
            label="Paused"
            onCancel={onResume}
            initialIndex={rootIndex.current}
            onIndexChange={(index) => {
              rootIndex.current = index;
            }}
          />
        )}
        {pane === "marches" && (
          <Marches
            onTravel={(id) => {
              onTravel(id);
              onResume();
            }}
            onBack={() => setPane("root")}
          />
        )}
        {pane === "barrow" && (
          <Barrow earned={earned} counted={counted} onBack={() => setPane("root")} />
        )}
        {pane === "gathering" && (
          <Gathering
            on={gathering}
            tokens={elixir}
            onAgree={() => onGathering(true)}
            onStop={() => onGathering(false)}
            onBack={() => setPane("root")}
          />
        )}
        {pane === "options" && <OptionsPanel onBack={() => setPane("root")} />}
        {pane === "shop" && (
          <Shop
            purse={purse}
            characterClass={characterClass}
            wearing={wearing}
            livery={livery}
            onBuy={onBuy}
            onWear={onWear}
            onBack={() => setPane("root")}
          />
        )}
        {pane === "codex" && <Codex onBack={() => setPane("root")} />}

        <footer className="keep-pause-foot">
          <Prompt action="cancel" verb={pane === "root" ? "resume" : "go back"} />
          <span className="keep-build">Build {KEEP_BUILD}</span>
        </footer>
      </div>
    </div>
  );
}
