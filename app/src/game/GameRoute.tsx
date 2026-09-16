import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageTitle } from "../lib/page-title";
import { Stage } from "./engine/Stage";
import { useInputDevice } from "./engine/use-input-device";
import { useGamepadActions } from "./engine/use-gamepad";
import { KEEP_TITLE, SHELL_KEEP_MARKER } from "./keep";
import { GameShellContext, type GameShell } from "./state/context";
import { motionReduced, optionsToStyle, readOptions, writeOptions, type GameOptions } from "./state/options";
import { drawField, HOLDING, layout, STARTING_BASE } from "./scenes/field";
import { drawLife } from "./scenes/life";
import { drawWrights } from "./scenes/wrights";
import { drawFoes, drawSites } from "./scenes/foes";
import { drawFx } from "./scenes/fx";
import { createWorld, DEMO_GARRISON, tickWorld, type Wright } from "./state/world";
import { useGarrison } from "./state/use-garrison";
import { buy } from "./state/shop";
import { experienceFrom, fortification, marksEarnedTo, standing } from "./state/progress";
import { hasChosen, marksLeft, readSave, writeSave, type Save } from "./state/save";
import { loadSave, reconcile, storeSave } from "./state/remote";
import { ChooseCharacter } from "./ui/ChooseCharacter";
import { Hud } from "./ui/Hud";
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
  /* Who you are, what you are wearing, and what you have bought. */
  const [save, setSaveState] = useState<Save>(readSave);
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

  /*
   * Saved on every change rather than on a timer or on the way out. The game
   * is a browser tab: it is closed, not exited, and a save that waits for a
   * clean shutdown is a save that is sometimes lost.
   */
  const setSave = useCallback((next: Save) => {
    setSaveState(next);
    writeSave(next);
    /*
     * Sent up as well, and not waited for. A purchase should land the instant
     * it is made; whether the service also heard about it is not something the
     * player should be made to watch a spinner for.
     */
    void storeSave(next);
  }, []);

  /* Tokens the gathering has cost, which only the service knows. */
  const [elixir, setElixir] = useState(0);

  /*
   * On arrival, the service's copy is merged with this browser's.
   *
   * Merged rather than replaced, and merged by what cannot go backwards: a
   * class once chosen, skins once bought, marks once spent. Taking whichever
   * was written most recently would let a tab somebody opened on a borrowed
   * laptop and abandoned overwrite months of progress.
   */
  useEffect(() => {
    let live = true;
    void loadSave().then((remote) => {
      if (!live || !remote) return;
      setElixir(remote.tokens);
      setSaveState((current) => {
        const merged = reconcile(current, remote.save);
        writeSave(merged);
        return merged;
      });
    });
    return () => {
      live = false;
    };
  }, []);

  const reducedMotion = motionReduced(options, systemReduced);

  /*
   * What the garrison has done, read off the world a few times a second rather
   * than every frame.
   *
   * The world changes thirty times a second and the HUD has four numbers on
   * it; re-rendering React at frame rate to move a progress bar by a pixel is
   * the sort of thing that makes a game feel heavy for no reason anybody can
   * see. Twice a second is faster than anyone reads.
   */
  const [tally, setTally] = useState({ felled: 0, raised: 0, wrights: [] as Wright[] });
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTally({
        felled: world.current.felled,
        raised: world.current.raised,
        /* Copied, so React sees a new array and the roster stays in step. */
        wrights: [...world.current.wrights],
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  /*
   * Experience from work that actually happened. Sessions and days come from
   * the service once the state layer lands; until then the field's own tally
   * is the honest part of it.
   */
  const rank = standing(experienceFrom({
    felled: tally.felled,
    raised: tally.raised,
    sessions: 0,
    days: 0,
  }));

  /* The holding is however fortified this level has earned. */
  const base = { ...STARTING_BASE, ...fortification(rank.level) };

  /* Earned by levelling, less what has been spent with the pedlar. */
  const purse = {
    marks: marksLeft(marksEarnedTo(rank.level), save),
    owned: save.owned,
  };

  /*
   * The world, in a ref rather than in state.
   *
   * It changes thirty times a second; putting it in state would re-render the
   * whole route at that rate to redraw a canvas React does not manage anyway.
   * The loop mutates it and the renderer reads it, and React is told about it
   * only when something it actually draws in the DOM changes.
   *
   * The courtyard bounds are set on the first frame, once the stage knows how
   * much ground is visible; until then there is nowhere to stand.
   */
  const world = useRef(createWorld({ left: 0, top: 0, right: 0, bottom: 0 }));

  /*
   * Who is on the field: the account's live sessions, polled, with the
   * stand-in garrison when there are none or the service cannot be reached.
   */
  const garrison = useGarrison(world.current, DEMO_GARRISON);

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
          * The field fills the window, edge to edge and under everything else.
          * There is no title over it: the game is the picture, and a wordmark
          * across the top of it is a browser tab's job.
          */}
        <main className="keep-field">
          <Stage
            label="The holding, seen from above: a walled courtyard with towers at its corners and the keep at its middle"
            staticKey={`${base.ground}:${base.wallTier}:${base.keepTier}:${base.towerTier}`}
            motionless={reducedMotion}
            drawStatic={(draw) => drawField(draw, base)}
            onTick={() => {
              if (!paused) tickWorld(world.current);
            }}
            drawFrame={(draw) => {
              /*
               * The courtyard is only known once the stage has measured the
               * window. One tile in from the wall on every side, which is the
               * part of the yard anybody can actually walk on.
               */
              const { left, top } = layout(draw);
              world.current.bounds = {
                left: left + 1.5,
                top: top + 2,
                right: left + HOLDING.w - 2.5,
                bottom: top + HOLDING.h - 2,
              };

              drawLife(draw);
              drawSites(draw, world.current);
              drawWrights(draw, world.current);
              drawFoes(draw, world.current);
              drawFx(draw, world.current);
            }}
          />
        </main>

        {/*
          * Everything that must survive a television sits inside this, laid
          * over the field rather than beside it. The picture may bleed into
          * the crop; the things you need to read may not.
          */}
        <div className="keep-safe">
          <header className="keep-hud">
            <Hud
              standing={rank}
              marks={purse.marks}
              elixir={elixir}
              gathering={save.gathering}
              characterClass={save.characterClass || "terminal"}
              wrights={tally.wrights}
              demo={garrison.demo}
              onOpenRoster={() => setPaused(true)}
            />
            <button
              type="button"
              className="keep-button keep-pause-button"
              onClick={() => setPaused(true)}
            >
              <span aria-hidden="true">❙❙</span>
              Pause
            </button>
          </header>

          <footer className="keep-foot">
            <Prompt action="pause" verb="open the menu" />
          </footer>
        </div>

        {paused && (
          <PauseMenu
            onResume={() => setPaused(false)}
            purse={purse}
            characterClass={save.characterClass || "terminal"}
            wearing={save.skinId}
            shopOpen={rank.level >= 2}
            elixir={elixir}
            garrison={tally.wrights.length}
            onBuy={(skinId) => {
              const result = buy(purse, skinId);
              if (!result.ok) return;
              /*
               * What is stored is the spend, not the purse. The purse is
               * derived from the level that earned it, so storing both would
               * be two facts that can disagree.
               */
              setSave({
                ...save,
                spent: save.spent + (purse.marks - result.purse.marks),
                owned: result.purse.owned,
                skinId: save.skinId || skinId,
              });
            }}
            onWear={(skinId) => setSave({ ...save, skinId })}
          />
        )}

        {/*
          * The one decision the game asks for, over the top of everything.
          * Shown until it has been made; the field carries on behind it.
          */}
        {!hasChosen(save) && (
          <ChooseCharacter
            onChoose={(characterClass) => setSave({ ...save, characterClass })}
          />
        )}
      </div>
    </GameShellContext.Provider>
  );
}
