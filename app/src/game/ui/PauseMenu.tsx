import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { dialogControls, trapDialogTab } from "../engine/dialog-focus";
import { useGamepadActions } from "../engine/use-gamepad";
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
  openAt?: "gathering" | "marches";
}) {
  const navigate = useNavigate();
  const [pane, setPane] = useState<Pane>(openAt ?? "root");
  const { options } = useGameShell();
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  /* Where the root menu was, so a side trip does not reset it. */
  const rootIndex = useRef(0);
  /*
   * The native modal keeps the field inert and remembers the opener before
   * the child Menu's focus effect runs. Closing restores that same opener.
   */
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useLayoutEffect(() => {
    if (pane !== "root") dialogControls(panel.current)[0]?.focus();
  }, [pane]);

  const goBack = () => {
    if (pane === "root") onResume();
    else setPane("root");
  };

  /* Root Menu handles its own list. Other panes use their native controls. */
  useGamepadActions((action) => {
    if (action === "cancel" || action === "pause") {
      goBack();
      return;
    }
    const controls = dialogControls(panel.current);
    if (controls.length === 0) return;
    const current = controls.indexOf(document.activeElement as HTMLElement);
    if (action === "up" || action === "down") {
      const direction = action === "up" ? -1 : 1;
      const next = current < 0 ? 0 : (current + direction + controls.length) % controls.length;
      controls[next]?.focus();
    } else if (action === "confirm") {
      controls[Math.max(0, current)]?.click();
    } else if (action === "left" || action === "right") {
      const control = controls[current];
      if (control instanceof HTMLInputElement && control.type === "range") {
        if (action === "left") control.stepDown();
        else control.stepUp();
        control.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (control instanceof HTMLInputElement && control.type === "radio") {
        const choices = controls.filter((item): item is HTMLInputElement =>
          item instanceof HTMLInputElement && item.type === "radio" && item.name === control.name,
        );
        const next = (choices.indexOf(control) + (action === "left" ? -1 : 1) + choices.length) % choices.length;
        choices[next]?.focus();
        choices[next]?.click();
      }
    }
  }, pane !== "root");

  const lore = CLASS_LORE[characterClass] ?? CLASS_LORE.terminal;

  const rootItems: MenuItem[] = [
    {
      id: "resume",
      label: "Resume",
      detail: "Back to the field",
      onSelect: onResume,
    },
    {
      id: "marches",
      label: "Map & holdings",
      detail: "The Marches — find active work",
      onSelect: () => setPane("marches"),
    },
    {
      id: "barrow",
      label: "Completed work",
      detail: counted
        ? `The Barrow — ${earned.sessions.toLocaleString()} completed sessions`
        : "The Barrow — not counted yet",
      onSelect: () => setPane("barrow"),
    },
    {
      id: "shop",
      label: "Cosmetics",
      detail: shopOpen
        ? `The Pedlar — ${purse.marks.toLocaleString()} marks to spend`
        : "The Pedlar — unlocks at level 2",
      disabled: !shopOpen,
      onSelect: () => setPane("shop"),
    },
    {
      id: "gathering",
      label: "Data gathering",
      detail: gathering
        ? `${elixir.toLocaleString()} tokens spent`
        : "Off. Nothing is being read",
      onSelect: () => setPane("gathering"),
    },
    {
      id: "codex",
      label: "Guide",
      detail: "How this world maps to shell.online",
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
      label: "Back to sessions",
      detail: "Leave the keep and open the session list",
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
    <dialog
      className="keep-pause"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        goBack();
      }}
      onKeyDownCapture={(event) => {
        trapDialogTab(event);
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        if (event.target instanceof Element && event.target.closest("dialog") !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        goBack();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div
        className={`keep-pause-panel keep-panel keep-panel-heavy${pane === "root" ? " is-root" : " is-wide"}`}
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
            <span>{garrison} active {garrison === 1 ? "session" : "sessions"}</span>
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
    </dialog>
  );
}
