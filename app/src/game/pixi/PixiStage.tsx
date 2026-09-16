import { useEffect, useRef, useState } from "react";
import { Application, Container } from "pixi.js";
/*
 * Pixi builds its shader and uniform plumbing with `new Function` by default,
 * which this application's Content-Security-Policy forbids -- `script-src
 * 'self'` with no `unsafe-eval`, which is the correct policy and one worth
 * keeping. Importing this replaces every one of those generated functions with
 * a hand-written equivalent; it is slightly slower to set up and identical
 * afterwards.
 *
 * Without it the renderer refuses to start and the game is a black rectangle
 * with a console warning. The strict policy on the dev server is what caught
 * it here rather than after a deploy.
 */
import "pixi.js/unsafe-eval";
import { Viewport } from "pixi-viewport";
import { MAP } from "../world/marches";
import { TILE_H, TILE_W } from "../world/iso";
import { widestZoom } from "./scene";

export interface Scene {
  /** Everything in world space. The viewport moves this, not the camera. */
  world: Container;
  /** Advance the scene. `delta` is in milliseconds. */
  tick?: (delta: number) => void;
  /** Called when the scene is torn down. */
  destroy?: () => void;
}

/**
 * A Pixi application in a React element, with a map you can move and zoom.
 *
 * Pixi rather than the hand-rolled canvas that was here before, for three
 * reasons that all turned out to matter: it batches thousands of sprites into
 * a handful of draw calls, which is what makes a map of this size possible at
 * all; it has a scene graph with depth sorting, which an isometric view needs
 * and which I was doing by hand and badly; and pixi-viewport gives drag, wheel
 * zoom and pinch for free, which is most of what "make it interactive" means.
 *
 * React owns the element and nothing else. Everything inside the canvas is
 * Pixi's, updated by the ticker, and never re-rendered by React — a scene
 * graph re-created on every render is the classic way to make a Pixi app
 * stutter.
 */
export function PixiStage({
  build,
  paused = false,
  label,
}: {
  /** Builds the scene once the renderer exists. */
  build: (app: Application, viewport: Viewport) => Promise<Scene> | Scene;
  paused?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState("");
  /* Read by the ticker without restarting it. */
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    let app: Application | undefined;
    let scene: Scene | undefined;
    let stopped = false;

    const start = async () => {
      const created = new Application();
      await created.init({
        resizeTo: element,
        antialias: true,
        /*
         * The art is drawn at twice size, so on an ordinary display it is
         * downsampled and on a dense one it is native. Capped at 2 because
         * beyond that the cost is real and the gain is not visible.
         */
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
        /* The canopy colour, so any sliver the wood does not reach matches it. */
        background: 0x1f3318,
        preference: "webgl",
      });
      if (stopped) {
        created.destroy(true);
        return;
      }
      app = created;
      element.appendChild(created.canvas);
      created.canvas.setAttribute("role", "img");
      created.canvas.setAttribute("aria-label", label);

      const viewport = new Viewport({
        events: created.renderer.events,
        worldWidth: MAP.width * TILE_W,
        worldHeight: MAP.height * TILE_H,
      });
      created.stage.addChild(viewport);

      /*
       * Drag to move, wheel or pinch to zoom, with the map kept on screen.
       *
       * The zoom range is chosen from what is legible: below about half,
       * buildings are specks and the names have already gone; above two, the
       * art is visibly enlarged past the resolution it was drawn at.
       *
       * `clamp` is what stops the country sliding off into an empty corner.
       * It only works because the projection is shifted so that no tile has a
       * negative coordinate -- see ORIGIN_X in iso.ts -- which makes the map
       * exactly the box pixi-viewport thinks the world is.
       */
      viewport
        .drag({ mouseButtons: "left" })
        .pinch()
        .wheel({ smooth: 4 })
        .decelerate({ friction: 0.92 })
        /*
         * The floor is whatever shows the whole country, worked out from the
         * map rather than picked, so that making the Marches bigger again
         * cannot leave a corner of them unreachable. The ceiling is where the
         * art is visibly enlarged past the resolution it was drawn at.
         */
        .clampZoom({ minScale: widestZoom(created.screen.width, created.screen.height), maxScale: 2 })
        .clamp({ direction: "all", underflow: "center" });

      scene = await build(created, viewport);
      if (stopped) return;
      viewport.addChild(scene.world);

      created.ticker.add((ticker) => {
        if (pausedRef.current) return;
        scene?.tick?.(ticker.deltaMS);
      });
    };

    void start().catch((error: unknown) => {
      /*
       * A machine with no WebGL, or a texture that would not load, should say
       * so rather than showing an empty rectangle and leaving somebody to
       * guess whether the game is broken or simply dark.
       */
      setFailed(error instanceof Error ? error.message : "The keep could not be drawn.");
    });

    return () => {
      stopped = true;
      scene?.destroy?.();
      app?.destroy(true, { children: true });
    };
    /* Once. The scene is Pixi's from here; React does not re-render into it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="keep-stage" ref={host}>
      {failed && (
        <p className="keep-stage-failed" role="status">
          {failed}
        </p>
      )}
    </div>
  );
}
