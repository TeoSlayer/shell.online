import { useEffect, useRef } from "react";
import { pixelScale, startLoop } from "./loop";

export interface DrawContext {
  context: CanvasRenderingContext2D;
  /** Whole-number magnification from design pixels to screen pixels. */
  scale: number;
  /** Milliseconds since the stage was mounted; the clock animations read. */
  elapsedMs: number;
  /** True when the player has asked for stillness. Animations must obey it. */
  motionless: boolean;
}

/**
 * The design resolution everything is drawn against.
 *
 * Sprites are authored for this, and the whole picture is then magnified by a
 * whole number to fill whatever window it finds itself in. Drawing at the
 * window's real size instead would mean a 4K display showing sprites four
 * times smaller rather than four times crisper, which is the opposite of what
 * anyone wants from pixel art.
 */
export const DESIGN_WIDTH = 320;
export const DESIGN_HEIGHT = 180;

/**
 * Two stacked canvases and a loop that draws them.
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
  /** Change this to have the static layer redrawn. */
  staticKey,
  motionless = false,
  label,
}: {
  drawStatic: (draw: DrawContext) => void;
  drawFrame: (draw: DrawContext) => void;
  staticKey: string;
  motionless?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const staticCanvas = useRef<HTMLCanvasElement>(null);
  const frameCanvas = useRef<HTMLCanvasElement>(null);
  const scale = useRef(1);
  /*
   * Through refs so a re-render with a new closure does not tear down the
   * loop. The loop is started once; what it calls is looked up each frame.
   */
  const drawStaticRef = useRef(drawStatic);
  const drawFrameRef = useRef(drawFrame);
  const motionlessRef = useRef(motionless);
  drawStaticRef.current = drawStatic;
  drawFrameRef.current = drawFrame;
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
      const next = pixelScale(bounds.width, bounds.height, DESIGN_WIDTH, DESIGN_HEIGHT);
      scale.current = next;
      const width = DESIGN_WIDTH * next;
      const height = DESIGN_HEIGHT * next;
      for (const canvas of [behind, front]) {
        /*
         * Sized in device pixels with no devicePixelRatio multiplier on top.
         * The magnification above is already a whole number of real pixels;
         * multiplying it again by a fractional ratio is what produces the
         * uneven pixel widths that read as blur.
         */
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
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
        scale: scale.current,
        elapsedMs: 0,
        motionless: motionlessRef.current,
      });
    };

    size();
    const observer = new ResizeObserver(size);
    observer.observe(element);

    const started = performance.now();
    const stop = startLoop({
      /*
       * Nothing to advance yet: the scenes that own moving things keep their
       * own state and are ticked from here once they exist.
       */
      tick: () => {},
      draw: () => {
        const context = front.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, front.width, front.height);
        drawFrameRef.current({
          context,
          scale: scale.current,
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
        * detail; announcing them separately would say the same scene twice.
        */}
      <canvas ref={staticCanvas} className="keep-canvas" role="img" aria-label={label} />
      <canvas ref={frameCanvas} className="keep-canvas is-front" aria-hidden="true" />
    </div>
  );
}
