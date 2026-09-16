import { Container, Text } from "pixi.js";
import type { Application } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import { buildWorld, homePosition, loadArt } from "./scene";
import { ActorLayer } from "./actors";
import { Birds, Blows, loadEffects, Smoke } from "./ambience";
import type { Scene } from "./PixiStage";
import { createSim, garrisonSoldiers, muster, tickSim, type Actor, type Mark, type Sim } from "../world/sim";

/**
 * The Marches, assembled and running.
 *
 * The simulation and the scene are kept apart on purpose: `world/sim.ts` knows
 * nothing about Pixi and can be run a thousand ticks deep in a test, and this
 * file only ever reads it and draws what it finds. That split is what made the
 * shaking findable — it was a question about numbers, not about pixels.
 */

export interface KeepHandle {
  sim: Sim;
  /** Called when a wright standing for a real session is clicked. */
  onPick?: (actor: Actor | undefined) => void;
  select(id: string | undefined): void;
  /** Centres the view on a garrison, for the map menu. */
  lookAt(x: number, y: number): void;
}

/** The style of a floating number. Built here so Blows stays about pooling. */
function numberFor(text: string, kind: Mark["kind"]): Container {
  const node = new Text({
    text,
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 20,
      fontWeight: "700",
      fill: kind === "damage" ? 0xff8fb0 : 0xe8c65a,
      stroke: { color: 0x1a1008, width: 5 },
    },
  });
  node.anchor.set(0.5);
  return node;
}

export async function buildKeepScene(
  _app: Application,
  viewport: Viewport,
  handle: KeepHandle,
  roster: { id: string; name: string; kind: string; work: "bug" | "feature" | "idle"; session?: Actor["session"] }[],
): Promise<Scene> {
  const [art, fx] = await Promise.all([loadArt(), loadEffects()]);
  const { root, things, signs } = buildWorld(art);

  const world = new Container();
  world.addChild(root);

  const sim = handle.sim;
  garrisonSoldiers(sim);
  for (const entry of roster) muster(sim, entry);

  let selected: string | undefined;
  const actors = new ActorLayer(art, things, (id) => {
    selected = id;
    handle.onPick?.(sim.actors.find((actor) => actor.id === id));
  });

  const birds = new Birds(things);
  const smoke = new Smoke(things, fx["fx-smoke_01"]);
  const blows = new Blows(things, fx, numberFor);

  handle.select = (id) => {
    selected = id;
  };
  handle.lookAt = (x, y) => {
    viewport.animate({ position: { x, y }, scale: 1.1, time: 450, ease: "easeInOutSine" });
  };

  /* Clicking bare ground clears the selection, which is what closes the panel. */
  viewport.eventMode = "static";
  const clearPick = (event: { target: unknown }) => {
    if (event.target !== viewport) return;
    selected = undefined;
    handle.onPick?.(undefined);
  };
  viewport.on("pointertap", clearPick);

  const home = homePosition();
  viewport.setZoom(0.9, true);
  viewport.moveCenter(home.x, home.y);

  /*
   * Signs keep roughly the same size on screen at any zoom, and the sentence
   * under the name only appears close up. A map zoomed out is otherwise a map
   * covered in enormous words, and zoomed in they disappear.
   */
  const rescaleSigns = () => {
    const scale = 1 / viewport.scale.x;
    for (const sign of signs.children) {
      sign.scale.set(Math.min(1.6, Math.max(0.55, scale)));
      const purpose = (sign as Container).getChildByLabel?.("purpose");
      if (purpose) purpose.visible = viewport.scale.x > 0.75;
    }
  };
  rescaleSigns();
  viewport.on("zoomed", rescaleSigns);
  viewport.on("moved", rescaleSigns);

  /*
   * The simulation runs at a fixed thirty ticks a second whatever the display
   * does, with a ceiling on catching up: a tab left in the background for ten
   * minutes should resume, not replay ten minutes of battle in one frame.
   */
  let owed = 0;
  const TICK_MS = 1000 / 30;

  return {
    world,
    tick(deltaMs) {
      owed = Math.min(owed + deltaMs, TICK_MS * 5);
      while (owed >= TICK_MS) {
        owed -= TICK_MS;
        tickSim(sim);
      }
      actors.sync(sim, selected);
      blows.sync(sim);
      birds.tick(deltaMs);
      smoke.tick(deltaMs);
    },
    destroy() {
      viewport.off("zoomed", rescaleSigns);
      viewport.off("moved", rescaleSigns);
      viewport.off("pointertap", clearPick);
      actors.destroy();
      birds.destroy();
      smoke.destroy();
      blows.destroy();
    },
  };
}

export { createSim };
export type { Actor, Sim };
