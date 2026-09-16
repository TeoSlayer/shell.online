import type { Application } from "pixi.js";
import type { Viewport } from "pixi-viewport";
import { Container } from "pixi.js";
import { buildWorld, homePosition, loadArt } from "./scene";
import type { Scene } from "./PixiStage";

/**
 * The Marches, assembled.
 *
 * Kept apart from PixiStage so the stage knows only "build me a scene" and
 * this knows only what the world contains. The actors — wrights, the Unmade,
 * birds — are added to `things` by the layers that own them, each of which can
 * be worked on without touching this.
 */
export async function buildKeepScene(_app: Application, viewport: Viewport): Promise<Scene> {
  const art = await loadArt();
  const { root, things, signs } = buildWorld(art);

  const world = new Container();
  world.addChild(root);

  /* Open on the Keep, at a zoom where a building is a building. */
  const home = homePosition();
  viewport.setZoom(0.9, true);
  viewport.moveCenter(home.x, home.y);

  /*
   * The signs shrink as you zoom in and grow as you zoom out, so a name stays
   * about the same size on screen at any zoom. Without this, a map zoomed out
   * is a map covered in enormous words, and zoomed in they vanish.
   */
  const rescaleSigns = () => {
    const scale = 1 / viewport.scale.x;
    for (const sign of signs.children) {
      sign.scale.set(Math.min(1.6, Math.max(0.55, scale)));
      /* The sentence under the name is only worth reading up close. */
      const purpose = (sign as Container).getChildByLabel?.("purpose");
      if (purpose) purpose.visible = viewport.scale.x > 0.75;
    }
  };
  rescaleSigns();
  viewport.on("zoomed", rescaleSigns);
  viewport.on("moved", rescaleSigns);

  return {
    world,
    tick() {
      /* Actors are added in the next layer; the ground does not move. */
      void things;
    },
    destroy() {
      viewport.off("zoomed", rescaleSigns);
      viewport.off("moved", rescaleSigns);
    },
  };
}
