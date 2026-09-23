import {
  TerminalLineScroller,
  TerminalTouchScrollBridge,
  TouchFling,
  type TouchSample,
} from "../../../web/touch-scroll";
import type { TerminalSurface } from "./renderer";

/*
 * What a finger needs from an emulator to scroll it. xterm and refstream both
 * draw their own viewport and have these; the chat renderer is an ordinary
 * scrolling list, has none of them, and keeps the browser's own touch scroll.
 */
interface ScrollableSurface {
  readonly buffer: { readonly active: { readonly type: string } };
  readonly modes: { readonly mouseTrackingMode: string };
  scrollLines(lines: number): void;
}

function scrollable(term: TerminalSurface): term is TerminalSurface & ScrollableSurface {
  const candidate = term as Partial<ScrollableSurface>;
  return typeof candidate.scrollLines === "function" && !!candidate.buffer && !!candidate.modes;
}

/* More lines than this in one frame is a fling past anything worth reporting. */
const MAX_WHEEL_LINES_PER_FRAME = 12;

/**
 * Lets a finger scroll a terminal the way a mouse wheel does on a desktop.
 *
 * Phones never send wheel events, and neither emulator scrolls from touch on
 * its own, so without this a session could be watched but never read back.
 * A vertical drag is counted in whole rows. Where a wheel would move
 * scrollback, the rows are scrolled directly. Where a wheel would go to the
 * program -- a full-screen app with mouse reporting, or the alternate screen,
 * where a wheel becomes arrow keys -- one line-sized wheel event is sent per
 * row, because both emulators turn each wheel event into exactly one report
 * whatever its size. A flick coasts after the finger lifts.
 *
 * A tap, a long press, and a sideways drag are left alone, so focusing the
 * terminal, selecting, and the keyboard behave as before.
 */
export function attachTouchScroll(node: HTMLElement, term: TerminalSurface): { dispose(): void } {
  if (!scrollable(term)) return { dispose() {} };

  /* The emulator draws the rows itself, so the browser must not pan them too. */
  node.dataset.touchScroll = "";

  let target: Element = node;
  let lastX = 0;
  let lastY = 0;
  let frame = 0;

  const rowHeight = () => (node.firstElementChild?.getBoundingClientRect().height ?? 0) / Math.max(term.rows, 1);
  const programOwnsWheel = () =>
    term.buffer.active.type !== "normal" || term.modes.mouseTrackingMode !== "none";

  const lines = new TerminalLineScroller(rowHeight, (count) => {
    if (!programOwnsWheel()) {
      term.scrollLines(count);
      return;
    }
    const step = Math.sign(count);
    for (let i = 0; i < Math.min(Math.abs(count), MAX_WHEEL_LINES_PER_FRAME); i++) {
      target.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: lastX,
        clientY: lastY,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: step,
        view: window,
      }));
    }
  });
  const fling = new TouchFling();
  const bridge = new TerminalTouchScrollBridge((wheel) => {
    lastX = wheel.x;
    lastY = wheel.y;
    fling.track(wheel.deltaY, performance.now());
    lines.scrollPixels(wheel.deltaY);
  });

  const coast = (at: number) => {
    const deltaY = fling.step(at);
    if (deltaY) lines.scrollPixels(deltaY);
    frame = fling.active ? requestAnimationFrame(coast) : 0;
  };
  const stopCoasting = () => {
    fling.stop();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const read = (touches: TouchList): TouchSample[] =>
    Array.from(touches, (touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));

  const start = (event: TouchEvent) => {
    /* A touch stops a coasting scroll, as it does in any native list. */
    stopCoasting();
    lines.reset();
    target = event.target instanceof Element && node.contains(event.target) ? event.target : node;
    fling.begin(performance.now());
    bridge.start(read(event.touches));
  };
  const move = (event: TouchEvent) => {
    if (!bridge.move(read(event.touches))) return;
    if (event.cancelable) event.preventDefault();
  };
  const end = () => {
    bridge.end();
    if (fling.release(performance.now())) frame = requestAnimationFrame(coast);
  };
  const cancel = () => {
    bridge.end();
    stopCoasting();
  };

  node.addEventListener("touchstart", start, { passive: true });
  node.addEventListener("touchmove", move, { passive: false });
  node.addEventListener("touchend", end, { passive: true });
  node.addEventListener("touchcancel", cancel, { passive: true });

  return {
    dispose() {
      stopCoasting();
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", cancel);
      delete node.dataset.touchScroll;
    },
  };
}
