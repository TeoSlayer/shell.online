/**
 * A phone's viewport, driveable from a desktop browser.
 *
 * Development only, imported by the chat preview before anything reads the
 * viewport. It exists because the two worst bugs this renderer has had were
 * both in how the layout answers a viewport that moves, and neither of them
 * can happen in a desktop browser: the window is one size, `visualViewport`
 * never disagrees with `innerHeight`, and there is no keyboard and no browser
 * toolbar sliding in and out under your thumb.
 *
 * Measuring a static page told me the layout was right. It was right for the
 * one frame I measured. So this replaces `window.visualViewport` with one that
 * can be driven, and drives it through the shapes a real phone produces:
 *
 *   keyboard   the visible height shrinks by a lot, at once
 *   toolbar    the visible height changes by a little, over many frames, as
 *              Safari's chrome slides away and back while the page is scrolled
 *
 * The toolbar case is the one that matters. It is not a keyboard, it happens
 * constantly, and any layout that reacts to it as though it were a keyboard
 * moves the furniture under somebody who was only scrolling.
 */

export interface ViewportTheatre {
  /** Move the visible viewport, as the browser would, and notify listeners. */
  set(next: { height?: number; offsetTop?: number }): void;
  /** Slide `to` over `frames`, one frame at a time, the way chrome animates. */
  slide(to: number, frames?: number): Promise<void>;
  /** The whole screen, nothing covering it. */
  readonly screen: number;
  height(): number;
  offsetTop(): number;
}

/**
 * Installs the stand-in. Must run before anything reads `window.visualViewport`
 * or `window.innerHeight`, which is why the preview imports this first.
 *
 * `innerHeight` is faked too, and deliberately: the layout viewport and the
 * visible one are different things on a phone and the same thing here, and a
 * harness where they cannot disagree is a harness that cannot reproduce the
 * bug where something read one and compared it against the other.
 */
export function installViewportTheatre(): ViewportTheatre {
  const screen = window.innerHeight;
  /*
   * What the layout viewport is, and what it stays. A phone does not make the
   * page shorter when its keyboard opens; it covers the bottom of it. Held
   * fixed here for the same reason.
   */
  const layout = screen;
  let height = screen;
  let offsetTop = 0;

  const listeners = { resize: new Set<() => void>(), scroll: new Set<() => void>() };

  const fake = {
    get width() {
      return window.innerWidth;
    },
    get height() {
      return height;
    },
    get offsetTop() {
      return offsetTop;
    },
    get offsetLeft() {
      return 0;
    },
    get pageTop() {
      return offsetTop;
    },
    get pageLeft() {
      return 0;
    },
    get scale() {
      return 1;
    },
    addEventListener(type: string, listener: () => void) {
      if (type === "resize" || type === "scroll") listeners[type].add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "resize" || type === "scroll") listeners[type].delete(listener);
    },
  };

  Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
  Object.defineProperty(window, "innerHeight", { get: () => layout, configurable: true });

  const announce = (type: "resize" | "scroll") => {
    for (const listener of [...listeners[type]]) listener();
  };

  const theatre: ViewportTheatre = {
    screen,
    height: () => height,
    offsetTop: () => offsetTop,
    set(next) {
      const before = { height, offsetTop };
      if (next.height !== undefined) height = Math.round(next.height);
      if (next.offsetTop !== undefined) offsetTop = Math.round(next.offsetTop);
      if (height !== before.height) announce("resize");
      if (offsetTop !== before.offsetTop) announce("scroll");
    },
    async slide(to, frames = 14) {
      const from = height;
      for (let frame = 1; frame <= frames; frame += 1) {
        theatre.set({ height: from + ((to - from) * frame) / frames });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    },
  };

  (window as unknown as { theatre: ViewportTheatre }).theatre = theatre;
  return theatre;
}
