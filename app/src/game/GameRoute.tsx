import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePageTitle } from "../lib/page-title";
import { PixiStage } from "./pixi/PixiStage";
import { buildKeepScene, createSim, type KeepHandle } from "./pixi/keepScene";
import { WrightPanel } from "./ui/WrightPanel";
import type { Actor } from "./world/sim";
import { useInputDevice } from "./engine/use-input-device";
import { useGamepadActions } from "./engine/use-gamepad";
import { KEEP_TITLE, SHELL_KEEP_MARKER } from "./keep";
import { GameShellContext, type GameShell } from "./state/context";
import { motionReduced, optionsToStyle, readOptions, writeOptions, type GameOptions } from "./state/options";
import { DEMO_EARNED, DEMO_ROSTER } from "./state/demo-garrison";
import { useGarrison } from "./state/use-garrison";
import { buy, skinById, tintFor } from "./state/shop";
import { experienceFrom, marksEarnedTo, standing } from "./state/progress";
import { useEarned } from "./state/use-earned";
import { hasChosen, marksLeft, readSave, writeSave, type Save } from "./state/save";
import { loadSave, reconcile, storeSave } from "./state/remote";
import { ChooseCharacter } from "./ui/ChooseCharacter";
import { BloodVeil } from "./ui/BloodVeil";
import { Hud } from "./ui/Hud";
import { ZoomControls } from "./ui/ZoomControls";
import { useLayout } from "./state/use-layout";
import { isCompact } from "./state/layout";
import { kingdomStrength } from "./world/kingdom";
import { ZOOM_STEP } from "./engine/zoom";
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
  const navigate = useNavigate();

  const [options, setOptionsState] = useState<GameOptions>(readOptions);
  /* Who you are, what you are wearing, and what you have bought. */
  const [save, setSaveState] = useState<Save>(readSave);
  const [paused, setPaused] = useState(false);
  const device = useInputDevice();
  /*
   * Which shape of screen this is, watched rather than read once. A handset
   * turned on its side is a different interface, and the one that arrived at
   * the old answer and never revisited it is the one that was full size on a
   * phone in landscape.
   */
  const layout = useLayout();
  const compact = isCompact(layout);

  /*
   * Whether the zoom controls have anywhere left to go.
   *
   * Kept in state because it is two booleans that change when somebody stops
   * pinching, not sixty times a second -- and a control that says it is at the
   * limit when it is not is worse than no control.
   */
  const [zoomAt, setZoomAt] = useState({ out: false, in: false });

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
   * Told to the scene as well as to the stylesheet. The canvas is not styled by
   * CSS, so without this the setting stopped at the edge of it.
   *
   * Also kept in a ref, because the scene is built asynchronously: this effect
   * runs against the placeholder handle long before `buildKeepScene` has
   * replaced it, so arriving with reduced motion already on would otherwise
   * open a map full of drifting particles and never be corrected.
   */
  const motionWanted = useRef(reducedMotion);
  motionWanted.current = reducedMotion;
  useEffect(() => {
    handle.current.still(reducedMotion);
  }, [reducedMotion]);

  /*
   * What the garrison has done, read off the world a few times a second rather
   * than every frame.
   *
   * The world changes thirty times a second and the HUD has four numbers on
   * it; re-rendering React at frame rate to move a progress bar by a pixel is
   * the sort of thing that makes a game feel heavy for no reason anybody can
   * see. Twice a second is faster than anyone reads.
   */
  const [tally, setTally] = useState({ felled: 0, raised: 0, wrights: [] as Actor[] });
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTally({
        felled: sim.current.felled,
        raised: sim.current.raised,
        /* Only the wrights that stand for real sessions are counted. */
        wrights: sim.current.actors.filter((actor) => actor.session !== undefined),
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  /*
   * Experience from work that actually happened, counted by the service.
   *
   * It used to be fed the field's own tally of faults put down, which meant a
   * tab left open overnight levelled you up -- the exact thing progress.ts
   * promises at the top of the file that nothing here does. The simulation is
   * spectacle now and earns nothing; what earns is a session that finished.
   */
  const { earned: counted, known } = useEarned();
  /*
   * The example team's example history, when the field is showing the example
   * team. Labelled as an example everywhere it appears -- and it is what makes
   * the shop, the Barrow and levelling reachable at all without a working
   * service and a week of sessions behind you.
   */
  const earned = known ? counted : DEMO_EARNED;
  const rank = standing(experienceFrom(earned));

  /* Earned by levelling, less what has been spent with the pedlar. */
  const purse = {
    marks: marksLeft(marksEarnedTo(rank.level), save),
    owned: save.owned,
  };

  /*
   * The simulation, in a ref rather than in state.
   *
   * It changes thirty times a second; putting it in state would re-render the
   * whole route at that rate to redraw a canvas React does not manage anyway.
   * The loop mutates it and the renderer reads it, and React is told only when
   * something it actually draws in the DOM changes.
   */
  const sim = useRef(createSim());
  /* The one clicked wright, which is the only game state React needs. */
  const [picked, setPicked] = useState<Actor | undefined>();
  /*
   * Which pane the pause menu should open on, set by whatever opened it. The
   * vial on the field leads straight to the account of what the gathering has
   * cost; everything else opens the menu where it was left.
   */
  const [pauseAt, setPauseAt] = useState<"gathering" | "marches" | undefined>();

  const handle = useRef<KeepHandle>({
    sim: sim.current,
    select: () => {},
    lookAt: () => {},
    wear: () => {},
    still: () => {},
    zoomBy: () => {},
    fit: () => {},
  });
  handle.current.onPick = setPicked;
  handle.current.onZoom = (at) =>
    setZoomAt((current) =>
      current.out === at.out && current.in === at.in ? current : { out: at.out, in: at.in },
    );
  /*
   * The scene still tells us whether the selected figure is visible, but the
   * card itself stays against the edge of the window. A moving information
   * panel was harder to read, covered a different piece of the map every
   * frame, and became a bottom-sheet-sized obstruction on a phone.
   */
  const cardRef = useRef<HTMLElement>(null);
  handle.current.onTrack = (at) => {
    const card = cardRef.current;
    if (!card) return;
    if (!at) {
      card.style.visibility = "hidden";
      return;
    }
    card.style.visibility = "visible";
  };

  /*
   * Who is on the field: the account's live sessions, polled, with the
   * stand-in garrison when there are none or the service cannot be reached.
   */
  const garrison = useGarrison(sim.current, DEMO_ROSTER, save.characterClass);

  /*
   * Whether the kingdom has the sessions to meet what is coming for it.
   *
   * From the team's own totals, not from the figures on the field. Two
   * reasons, and they pull in opposite directions from the same rule -- that
   * this is a read-out of real work:
   *
   * The field is capped and the read-out is not, so a team of sixty holding
   * its ground must not be told it is losing because the drawing budget ran
   * out before their soldiers did.
   *
   * And the field shows the *example* team when an account has nothing
   * running, which is the one case where somebody most needs to be told their
   * kingdom is short. Reading the strain off the example would tell a person
   * with nothing open that everything is fine.
   *
   * When the service could not be reached at all there is no answer, and the
   * kingdom is left alone rather than accused.
   */
  const strength = kingdomStrength(garrison.team ?? { heroes: 0, soldiers: 0 });

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

  const style = optionsToStyle(options, systemReduced, layout) as React.CSSProperties;

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
        /*
         * The shape of the screen, for the stylesheet.
         *
         * A media query cannot ask the question this answers: a handset in
         * landscape is 844 pixels across and sails past every `width <= 640px`
         * rule in the file. See state/layout.ts.
         */
        data-layout={layout}
        /*
         * Whether the card over a figure is up, so the zoom controls can step
         * out from under it. The card is a modal layer pinned to the same edge
         * they are, and inspecting anything used to cover the only visible way
         * to zoom out.
         */
        data-card={picked ? "open" : "closed"}
        style={style}
      >
        {/*
          * The field fills the window, edge to edge and under everything else.
          * There is no title over it: the game is the picture, and a wordmark
          * across the top of it is a browser tab's job.
          */}
        <main className="keep-field">
          <PixiStage
            label="The Marches: garrisons spread over open country, seen from above and tilted"
            paused={paused}
            build={async (app, viewport) => {
              const scene = await buildKeepScene(app, viewport, handle.current);
              handle.current.still(motionWanted.current);
              return scene;
            }}
          />
        </main>

        {/*
          * The kingdom struggling, laid over the field and under the HUD.
          *
          * Under, so that the words explaining it stay legible through it --
          * a signal that obscures its own explanation is a signal that only
          * worries people.
          */}
        <BloodVeil strength={strength} />

        {/*
          * Everything that must survive a television sits inside this, laid
          * over the field rather than beside it. The picture may bleed into
          * the crop; the things you need to read may not.
          */}
        <div className="keep-safe">
          <Hud
            standing={rank}
            marks={purse.marks}
            elixir={elixir}
            gathering={save.gathering}
            characterClass={save.characterClass || "terminal"}
            wrights={tally.wrights}
            demo={garrison.demo}
            counted={known}
            sessionTotal={garrison.soldiers}
            strength={strength}
            /* Whether the numbers behind it are this account's or an example. */
            real={garrison.team !== undefined}
            compact={compact}
            dataState={
              garrison.loading
                ? "Updating sessions"
                : garrison.demo
                  ? garrison.error
                    ? "Preview — sessions unavailable"
                    : "Preview — no active sessions"
                  : "Live team sessions"
            }
            onOpenGathering={() => {
              setPauseAt("gathering");
              setPaused(true);
            }}
            onOpenRoster={() => {
              setPauseAt("marches");
              setPaused(true);
            }}
          />

          {/*
            * The pause button holds the corner the HUD leaves for it, and the
            * key prompt the one below. Both belong to the same ring of things
            * around the edge of the eye; they are here rather than in `Hud`
            * only because they are the route's to open and to label.
            */}
          <div className="keep-corner is-top-right">
            <button
              type="button"
              className="keep-button keep-pause-button"
              /*
               * Named here as well as written on, because a handset drops the
               * word to keep the button inside a corner it has to share with
               * the map -- and a control whose name is only its visible text
               * is a control that loses its name when the text goes.
               */
              aria-label="Pause"
              onClick={() => setPaused(true)}
            >
              <span aria-hidden="true">❙❙</span>
              {/*
                * The word is a separate node so a handset can drop it and keep
                * the button, the hit area and the accessible name. Shrinking
                * the text to nothing would leave a label nobody can read
                * claiming to be readable.
                */}
              <span className="keep-button-word">Pause</span>
            </button>
          </div>

          {/*
            * The way out of the map, for a screen with no wheel on it.
            *
            * Shown to everybody rather than to touch alone: a visible control
            * costs a mouse nothing and it is the only thing on screen that
            * says the map can be pulled back at all.
            */}
          <div className="keep-corner is-right">
            <ZoomControls
              onZoomIn={() => handle.current.zoomBy(ZOOM_STEP)}
              onZoomOut={() => handle.current.zoomBy(1 / ZOOM_STEP)}
              onFit={() => handle.current.fit()}
              atOut={zoomAt.out}
              atIn={zoomAt.in}
            />
          </div>

          {/*
            * The key prompt goes on a handset. It names a key that phone does
            * not have, and it is one more thing across the foot of a screen
            * that has none to spare; the pause button beside it does the same
            * job and can be hit.
            */}
          {!compact && (
            <div className="keep-corner is-bottom-centre">
              <Prompt action="pause" verb="open the menu" />
            </div>
          )}
        </div>

        {picked && (
          <WrightPanel
            cardRef={cardRef}
            actor={picked}
            field={sim.current.actors}
            now={Date.now()}
            onClose={() => {
              setPicked(undefined);
              handle.current.select(undefined);
            }}
            onOpenSession={(sessionId) => navigate(`/sessions/${sessionId}`)}
          />
        )}

        {paused && (
          <PauseMenu
            onResume={() => {
              setPaused(false);
              /*
               * Forgotten on the way out, or every later press of Escape would
               * reopen the pane the vial last asked for rather than the menu.
               */
              setPauseAt(undefined);
            }}
            purse={purse}
            characterClass={save.characterClass || "terminal"}
            wearing={save.skinId}
            livery={save.liveryId}
            shopOpen={rank.level >= 2}
            elixir={elixir}
            garrison={tally.wrights.length}
            onTravel={(id) => handle.current.lookAt(id)}
            gathering={save.gathering}
            earned={earned}
            counted={known}
            onGathering={(on) => setSave({ ...save, gathering: on })}
            openAt={pauseAt}
            onBuy={(skinId) => {
              const result = buy(purse, skinId);
              if (!result.ok) return;
              const bought = skinById(skinId);
              /*
               * What is stored is the spend, not the purse. The purse is
               * derived from the level that earned it, so storing both would
               * be two facts that can disagree.
               *
               * A first purchase in a slot is worn at once, because nobody buys
               * a colour in order to not wear it.
               */
              const next = {
                ...save,
                spent: save.spent + (purse.marks - result.purse.marks),
                owned: result.purse.owned,
                skinId:
                  bought?.wears === "hero" ? save.skinId || skinId : save.skinId,
                liveryId:
                  bought?.wears === "retinue" ? save.liveryId || skinId : save.liveryId,
              };
              setSave(next);
              handle.current.wear(tintFor(next.skinId), tintFor(next.liveryId));
            }}
            onWear={(skinId) => {
              const chosen = skinById(skinId);
              const next =
                chosen?.wears === "retinue"
                  ? { ...save, liveryId: skinId }
                  : { ...save, skinId };
              setSave(next);
              /* The field shows it at once, rather than on the next reload. */
              handle.current.wear(tintFor(next.skinId), tintFor(next.liveryId));
            }}
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
