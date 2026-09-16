import { useEffect, useRef } from "react";
import { startLoop } from "./loop";

export interface DrawContext {
  context: CanvasRenderingContext2D;
  /** Whole-number magnification from design pixels to screen pixels. */
  scale: number;
  /** The visible field in design pixels — as much as this window can show. */
  width: number;
  height: number;
  /** Milliseconds since the stage was mounted; the clock animations read. */
  elapsedMs: number;
  /** True when the player has asked for stillness. Animations must obey it. */
  motionless: boolean;
}

/**
 * How big a design pixel is drawn, chosen from the window.
 *
 * The camera looks down at the holding, so there is no fixed frame to fit
 * inside: a wider window sees more ground rather than the same ground larger.
 * What has to be decided is only how chunky a pixel should be, and that is a
 * question about viewing distance — a phone held close wants a smaller factor
 * than a monitor across a desk.
 *
 * Whole numbers only. At 2.37x some pixels are two screen pixels wide and some
 * are three, and the eye reads that unevenness as blur however careful the art
 * was.
 */
export function pixelScale(viewportWidth: number, viewportHeight: number): number {
  const shortest = Math.min(viewportWidth, viewportHeight);
  if (shortest <= 0) return 3;
  /* Aim for roughly 22 tiles across the short side, then round to a whole number. */
  const wanted = shortest / (16 * 22);
  return Math.max(2, Math.min(6, Math.round(wanted)));
}

/**
 * Two stacked canvases, filling the window, and a loop that draws them.
 *
 * The split is the whole optimisation. The ground and the buildings change
 * when somebody puts up a watchtower and at no other time, so they are drawn
 * once and left alone; only the heroes, the bugs and the sparks are redrawn
 * thirty times a second. On a field of forty actors that is most of the
 * per-frame cost removed for the price of one extra element.
 */
export function Stage({
  drawStatic,
  drawFrame,
  onTick,
  /** Change this to have the static layer redrawn. */
  staticKey,
  motionless = false,
  label,
}: {
  drawStatic: (draw: DrawContext) => void;
  drawFrame: (draw: DrawContext) => void;
  /**
   * Advance the world by one fixed step. Separate from drawing on purpose:
   * see loop.ts for why the simulation must not run at the display's rate.
   */
  onTick?: (tick: number) => void;
  staticKey: string;
  motionless?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const staticCanvas = useRef<HTMLCanvasElement>(null);
  const frameCanvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ scale: 3, width: 0, height: 0 });
  /*
   * Through refs so a re-render with a new closure does not tear down the
   * loop. The loop is started once; what it calls is looked up each frame.
   */
  const drawStaticRef = useRef(drawStatic);
  const drawFrameRef = useRef(drawFrame);
  const onTickRef = useRef(onTick);
  const motionlessRef = useRef(motionless);
  drawStaticRef.current = drawStatic;
  drawFrameRef.current = drawFrame;
  onTickRef.current = onTick;
  motionlessRef.current = motionless;

  /* Redraws the static layer. Called on resize and when staticKey changes. */
  const paintStatic = useRef(() => {});

  useEffect(() => {
    const element = host.current;
    const behind = staticCanvas.current;
    const front = frameCanvas.current;
    if (!element || !behind || !front) return;

    const size = () => {
      const bounds = element.getBoundingClientRect();
      const scale = pixelScale(bounds.width, bounds.height);
      /*
       * The backing store is a whole number of design pixels, so nothing is
       * ever drawn on a half. The element is then stretched by at most one
       * scale factor of a pixel to cover the last sliver of the window, which
       * is invisible and keeps the field edge-to-edge.
       */
      const width = Math.ceil(bounds.width / scale);
      const height = Math.ceil(bounds.height / scale);
      view.current = { scale, width, height };

      for (const canvas of [behind, front]) {
        canvas.width = width * scale;
        canvas.height = height * scale;
        const context = canvas.getContext("2d");
        if (context) context.imageSmoothingEnabled = false;
      }
      paintStatic.current();
    };

    paintStatic.current = () => {
      const context = behind.getContext("2d");
      if (!context) return;
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, behind.width, behind.height);
      drawStaticRef.current({
        context,
        ...view.current,
        elapsedMs: 0,
        motionless: motionlessRef.current,
      });
    };

    size();
    const observer = new ResizeObserver(size);
    observer.observe(element);

    const started = performance.now();
    const stop = startLoop({
      tick: (tick) => onTickRef.current?.(tick),
      draw: () => {
        const context = front.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, front.width, front.height);
        drawFrameRef.current({
          context,
          ...view.current,
          elapsedMs: performance.now() - started,
          motionless: motionlessRef.current,
        });
      },
    });

    return () => {
      stop();
      observer.disconnect();
    };
  }, []);

  /* A change to the world behind the actors: redraw it, once. */
  useEffect(() => {
    paintStatic.current();
  }, [staticKey, motionless]);

  return (
    <div className="keep-stage" ref={host}>
      {/*
        * One accessible name for the pair. Two canvases is an implementation
        * detail; announcing them separately would describe the same scene
        * twice.
        */}
      <canvas ref={staticCanvas} className="keep-canvas" role="img" aria-label={label} />
      <canvas ref={frameCanvas} className="keep-canvas is-front" aria-hidden="true" />
    </div>
  );
}
