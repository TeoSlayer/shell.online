import { useCallback, useEffect, useMemo, useState } from "react";
import { usePageTitle } from "../lib/page-title";
import { useInputDevice } from "./engine/use-input-device";
import { useGamepadActions } from "./engine/use-gamepad";
import { KEEP_TITLE, SHELL_KEEP_MARKER } from "./keep";
import { GameShellContext, type GameShell } from "./state/context";
import { motionReduced, optionsToStyle, readOptions, writeOptions, type GameOptions } from "./state/options";
import { PauseMenu } from "./ui/PauseMenu";
import { Prompt } from "./ui/Prompt";
import "../styles/game.css";

/**
 * The keep.
 *
 * This module is the only thing `App.tsx` knows about the game, and it is
 * reached through a dynamic import, so none of it -- not the engine, not the
 * sprites, not this stylesheet -- is in the bundle somebody gets when they
 * open the session list. `scripts/check-bundle.mjs` fails the build if that
 * ever stops being true.
 *
 * What it owns is the frame around the game: the options that decide whether
 * the thing is legible on this screen, which device is in the player's hands,
 * and whether the simulation is running. The field itself is drawn by scenes
 * mounted inside it.
 */
export default function GameRoute() {
  usePageTitle(KEEP_TITLE);

  const [options, setOptionsState] = useState<GameOptions>(readOptions);
  const [paused, setPaused] = useState(false);
  const device = useInputDevice();

  /*
   * The OS setting is watched rather than read once. Somebody who turns
   * "reduce motion" on because the game is making them ill should not have to
   * reload the game to get the benefit of it.
   */
  const [systemReduced, setSystemReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystemReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const setOptions = useCallback((next: GameOptions) => {
    setOptionsState(next);
    writeOptions(next);
  }, []);

  const reducedMotion = motionReduced(options, systemReduced);

  /*
   * The game takes the window. The corporate shell scrolls; a field that
   * scrolls underneath a fixed HUD is a field somebody loses their heroes off
   * the bottom of, so the body is held still for as long as this is mounted.
   */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /* Escape pauses, and pauses again out of whatever the pause menu opened. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || paused) return;
      event.preventDefault();
      setPaused(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [paused]);

  /*
   * Start on the pad opens the pause menu. Only while play is running: the
   * menu handles its own input once it is up, and two listeners fighting over
   * the same button is a menu that opens and closes on one press.
   */
  useGamepadActions(
    useCallback((action) => {
      if (action === "pause") setPaused(true);
    }, []),
    !paused,
  );

  const shell = useMemo<GameShell>(
    () => ({ options, setOptions, reducedMotion, device, paused, setPaused }),
    [options, setOptions, reducedMotion, device, paused],
  );

  const style = optionsToStyle(options, systemReduced) as React.CSSProperties;

  return (
    <GameShellContext.Provider value={shell}>
      <div
        className="keep"
        /*
         * The marker the bundle check looks for. On the DOM rather than in a
         * dead constant, because a marker a minifier can drop would make that
         * check pass by being absent for the wrong reason.
         */
        data-keep={SHELL_KEEP_MARKER}
        data-motion={reducedMotion ? "reduced" : "full"}
        data-colour={options.colour}
        style={style}
      >
        {/*
          * Everything that must survive a television sits inside this. The
          * field may bleed to the edges; the things you need to read may not.
          */}
        <div className="keep-safe">
          <header className="keep-hud">
            <h1 className="keep-wordmark">{KEEP_TITLE}</h1>
            <button
              type="button"
              className="keep-button keep-pause-button"
              onClick={() => setPaused(true)}
            >
              <span aria-hidden="true">❙❙</span>
              Pause
            </button>
          </header>

          <main className="keep-field">
            {/*
              * Stage 2 mounts the canvas layers here. Until then the frame is
              * real, which is what makes the lazy-loading and the pause screen
              * testable before there is anything to look at.
              */}
            <p className="keep-field-placeholder">The field is being surveyed.</p>
            <Prompt action="pause" verb="open the menu" />
          </main>
        </div>

        {paused && <PauseMenu onResume={() => setPaused(false)} />}
      </div>
    </GameShellContext.Provider>
  );
}
