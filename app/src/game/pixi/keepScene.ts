import { Container, Text } from "pixi.js";
import type { Application } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import { buildWorld, homeView, loadArt } from "./scene";
import { toTile } from "./iso";
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
  /** The skin worn by this player's own wrights. */
  wear(tint: number): void;
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
  app: Application,
  viewport: Viewport,
  handle: KeepHandle,
  roster: { id: string; name: string; kind: string; work: "bug" | "feature" | "idle"; session?: Actor["session"] }[],
): Promise<Scene> {
  const [art, fx] = await Promise.all([loadArt(), loadEffects()]);
  const { root, things, labels, signs } = buildWorld(art);

  const world = new Container();
  world.addChild(root);

  const sim = handle.sim;
  garrisonSoldiers(sim);
  for (const entry of roster) muster(sim, entry);

  let selected: string | undefined;
  const actors = new ActorLayer(art, things, labels);

  const birds = new Birds(things);
  const smoke = new Smoke(things, fx["fx-smoke_01"]);
  const blows = new Blows(things, fx, numberFor);

  handle.select = (id) => {
    selected = id;
  };
  handle.wear = (tint) => actors.wear(tint);
  handle.lookAt = (x, y) => {
    viewport.animate({ position: { x, y }, scale: 1.1, time: 450, ease: "easeInOutSine" });
  };

  /*
   * Picking is done by finding the nearest wright to where the map was
   * clicked, rather than by giving every figure its own hit area.
   *
   * Two reasons. A wright is about twenty pixels tall and zooms down to seven,
   * and asking somebody to hit that exactly is asking them to miss; a generous
   * radius around the click is what makes small figures selectable at all.
   * And it means one hit test against the world instead of one display object
   * per actor in the interaction tree, which is cheaper and, unlike per-sprite
   * hit areas, actually worked.
   */
  /*
   * The listener goes on the stage, with a hit area the size of the screen.
   *
   * A Pixi container only hit-tests its children unless it is given one of its
   * own, so taps on open grass -- which is most of the map -- reached nothing
   * and the handler on the viewport never fired. A stage-wide hit area means
   * every click inside the canvas arrives, and where it landed is then a
   * question about coordinates rather than about the display list.
   */
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  const PICK_RADIUS = 1.4;
  const onTap = (event: { global: { x: number; y: number } }) => {
    const world = viewport.toWorld(event.global.x, event.global.y);
    const tile = toTile(world.x, world.y);

    let nearest: Actor | undefined;
    let nearestDistance = PICK_RADIUS;
    for (const actor of sim.actors) {
      if (!actor.session) continue;
      const distance = Math.hypot(actor.x - tile.x, actor.y - tile.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = actor;
      }
    }

    selected = nearest?.id;
    handle.onPick?.(nearest);
  };
  app.stage.on("pointertap", onTap);

  const home = homeView(app.screen.width, app.screen.height);
  viewport.setZoom(home.zoom, true);
  viewport.moveCenter(home.x, home.y);

  /*
   * Signs keep roughly the same size on screen at any zoom, and the sentence
   * under the name only appears close up. A map zoomed out is otherwise a map
   * covered in enormous words, and zoomed in they disappear.
   */
  let detailed: boolean | undefined;
  const rescaleSigns = () => {
    const scale = 1 / viewport.scale.x;
    const wanted = viewport.scale.x > 0.75;
    for (const sign of signs.children) {
      sign.scale.set(Math.min(1.6, Math.max(0.55, scale)));
    }
    actors.zoomed(viewport.scale.x);
    /*
     * Only when it changes. Showing the sentence redraws every board, and
     * `moved` fires on every frame of a drag -- redrawing six boards a frame to
     * arrive at the picture already on screen is the kind of cost that only
     * shows up as a number in somebody else's profile.
     */
    if (wanted === detailed) return;
    detailed = wanted;
    for (const sign of signs.children) {
      (sign as Container & { setDetailed?: (on: boolean) => void }).setDetailed?.(wanted);
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
      app.stage.off("pointertap", onTap);
      actors.destroy();
      birds.destroy();
      smoke.destroy();
      blows.destroy();
    },
  };
}

export { createSim };
export type { Actor, Sim };
