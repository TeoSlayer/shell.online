/**
 * WorkshopStage: isolated React wrapper for the workshop Pixi scene.
 *
 * NOT a public route. This is a test/preview harness only. Root owns
 * integration into GameRoute.tsx.
 *
 * The Pixi app is created once on mount. A `ready` state gates the scene
 * effect: the scene is only built after `created.init()` resolves, so the
 * first paint is never empty. StrictMode unmount-before-init disposes the
 * pending app without installing a stale scene.
 */
import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import "pixi.js/unsafe-eval";
import {
  buildWorkshopScene,
  type WorkshopSceneOptions,
  type WorkshopSceneHandle,
} from "./WorkshopScene";
import { SCENE_H, SCENE_W } from "./layout";

export interface WorkshopStageProps {
  workers: WorkshopSceneOptions["workers"];
  ownerUid: string;
  page?: number;
  reducedMotion?: boolean;
  label?: string;
}

export function WorkshopStage({
  workers,
  ownerUid,
  page = 0,
  reducedMotion = false,
  label = "Workshop dashboard",
}: WorkshopStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState("");
  const [ready, setReady] = useState(false);
  const sceneRef = useRef<WorkshopSceneHandle | null>(null);
  const appRef = useRef<Application | null>(null);

  // Mount: create the Pixi app once. Sets `ready` after init resolves.
  useEffect(() => {
    const element = host.current;
    if (!element) return;

    let app: Application | undefined;
    let stopped = false;
    let onResize: () => void = () => {};

    const start = async () => {
      const created = new Application();
      await created.init({
        resizeTo: element,
        antialias: false,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
        background: 0x1a2a1a,
        preference: "webgl",
      });
      // StrictMode: unmount happened before init resolved. Dispose, don't install.
      if (stopped) {
        created.destroy(true);
        return;
      }
      app = created;
      appRef.current = created;
      element.appendChild(created.canvas);
      created.canvas.setAttribute("role", "img");
      created.canvas.setAttribute("aria-label", label);

      onResize = () => {
        const { width, height } = created.screen;
        const scale = Math.min(width / SCENE_W, height / SCENE_H);
        const offsetX = (width - SCENE_W * scale) / 2;
        const offsetY = (height - SCENE_H * scale) / 2;
        created.stage.scale.set(scale);
        created.stage.position.set(offsetX, offsetY);
      };
      onResize();
      created.renderer.on("resize", onResize);

      created.ticker.add((ticker) => {
        sceneRef.current?.tick(ticker.deltaMS);
      });

      // Signal the scene effect to run. This is the ONLY trigger for first paint.
      setReady(true);
    };

    void start().catch((error: unknown) => {
      if (!stopped) {
        setFailed(error instanceof Error ? error.message : "Workshop could not be drawn.");
      }
    });

    return () => {
      stopped = true;
      if (app) {
        app.renderer.off("resize", onResize);
        app.destroy(true, { children: true });
      }
      sceneRef.current?.destroy();
      sceneRef.current = null;
      appRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scene: build/rebuild when ready AND props change.
  // `ready` in the dep array ensures the effect re-runs after init resolves,
  // so the first paint is never empty.
  useEffect(() => {
    const app = appRef.current;
    if (!app || !ready) return;

    const opts: WorkshopSceneOptions = { workers, ownerUid, page, reducedMotion };

    if (sceneRef.current) {
      sceneRef.current.destroy();
      sceneRef.current = null;
    }

    const handle = buildWorkshopScene(app, opts);
    sceneRef.current = handle;
    app.stage.addChild(handle.world);

    return () => {
      if (sceneRef.current === handle) {
        handle.destroy();
        sceneRef.current = null;
      }
    };
  }, [ready, workers, ownerUid, page, reducedMotion]);

  return (
    <div
      ref={host}
      style={{
        width: "100%",
        height: "100%",
        minHeight: "270px",
        background: "#1a2a1a",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {failed && (
        <p role="status" style={{ color: "#f88", padding: 16, fontFamily: "monospace" }}>
          {failed}
        </p>
      )}
    </div>
  );
}
