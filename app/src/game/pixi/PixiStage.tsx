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
import { zoomBounds } from "../engine/zoom";

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
    let onResize: (width: number, height: number) => void = () => {};

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

      const worldWidth = MAP.width * TILE_W;
      const worldHeight = MAP.height * TILE_H;
      const viewport = new Viewport({
        events: created.renderer.events,
        /*
         * The canvas, not the window.
         *
         * Left out, pixi-viewport measures `window.innerWidth` once and never
         * again -- so on a phone every limit it enforces was computed against
         * a screen that included the browser's own furniture, and none of them
         * was recomputed when the device was turned on its side.
         */
        screenWidth: created.screen.width,
        screenHeight: created.screen.height,
        worldWidth,
        worldHeight,
      });
      created.stage.addChild(viewport);

      /*
       * Drag to move, wheel or pinch to zoom, with the map kept on screen.
       *
       * The zoom range is chosen from what is legible: the floor shows the
       * whole country, and the ceiling -- `CLOSEST` -- is where the art is
       * visibly enlarged past the resolution it was drawn at.
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
        .clamp({ direction: "all", underflow: "center" });

      /*
       * The limits, re-read whenever the canvas changes size.
       *
       * They used to be worked out once, from `app.screen` -- which, at the
       * moment this runs, is still Pixi's default 800 by 600, because
       * `resizeTo` measures the element on the next frame. So the floor on how
       * far out a phone could pull was a floor computed for a screen that
       * phone does not have, and rotating the device never corrected it. A
       * renderer resize is the one event that knows the truth, and it fires
       * on the first measurement as well as on every rotation.
       */
      const relimit = (width: number, height: number) => {
        const bounds = zoomBounds(width, height, worldWidth, worldHeight);
        viewport.resize(width, height, worldWidth, worldHeight);
        viewport.clampZoom({ minScale: bounds.min, maxScale: bounds.max });
        /*
         * Re-applied by hand: `clampZoom` corrects the zoom on the next input,
         * and a rotation is not an input. Without this, turning a phone from
         * landscape to portrait leaves the map zoomed further out than the new
         * floor allows and nothing ever pulls it back.
         */
        if (viewport.scale.x < bounds.min) viewport.setZoom(bounds.min, true);
        if (viewport.scale.x > bounds.max) viewport.setZoom(bounds.max, true);
      };
      relimit(created.screen.width, created.screen.height);
      onResize = (width: number, height: number) => relimit(width, height);
      created.renderer.on("resize", onResize);

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
      /*
       * The resize listener goes before the renderer does. A handler left on a
       * destroyed renderer is a handler that runs against a torn-down viewport
       * the next time the window moves.
       */
      if (app) app.renderer.off("resize", onResize);
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
