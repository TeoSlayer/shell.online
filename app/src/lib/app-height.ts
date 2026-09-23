/**
 * The height the application shell is drawn at, measured rather than assumed.
 *
 * The phone layout is a fixed shell with one scrolling column inside it, and
 * the bottom bar is the bottom edge of that shell. Sizing it with `100dvh`
 * alone puts the bar wherever the browser's idea of the dynamic viewport is at
 * the moment the rule is evaluated, and that is not the same number on every
 * engine or at every point in a page's life: iOS resolves it against the large
 * viewport while its toolbar is still expanded, so the first paint puts the bar
 * below the fold, and a toolbar that then collapses or expands moves it again.
 *
 * So the height is read from the window and published as a custom property the
 * stylesheet uses, with the `dvh` expression left as the fallback for the first
 * paint and for anything without a script. `window.innerHeight` is the layout
 * viewport -- the box a fixed element is anchored to -- and not the visual one,
 * which shrinks when the keyboard opens. The keyboard is handled separately and
 * deliberately: see keyboard-inset.ts, which moves the bar out of the way
 * rather than shortening the app underneath it.
 */

const PROPERTY = "--app-height";

/**
 * How tall the visible part of the page is, everywhere, on every page.
 *
 * The one number the shell is sized from, which is the point of it. The bar
 * at the foot of a phone is the bottom edge of the shell, so anything that
 * computes that height a second way puts the bar somewhere else -- and a
 * session did, which is why its bar sat higher than every other page's, and
 * why the bar moved once while a page was still loading and then settled.
 *
 * `visualViewport.height` already accounts for whatever is covering the
 * bottom of the screen, so nothing is subtracted from it and nothing else is
 * consulted. `--app-height` stays for the things that want the layout
 * viewport rather than the visible one.
 */
const VISIBLE = "--visible-height";

/**
 * How tall the visible page was before a keyboard covered it.
 *
 * A session is the one page that must not shrink for a keyboard: the terminal
 * in it is a grid of a fixed number of columns, so a pane that changes size
 * refits that grid to a smaller font. This is what it uses instead of
 * `--visible-height` while somebody is typing.
 *
 * Published here rather than from the pane, because it has to be right the
 * first time. The pane's own watcher mounts and unmounts with the pane, and a
 * session opened with the keyboard already up -- a locked session with a
 * password form in it, say -- never saw the page uncovered, so it had nothing
 * to hold and shrank after all.
 */
const TYPING = "--typing-height";

/**
 * How much of the bottom has to be covered before it counts as a keyboard
 * rather than a browser toolbar sliding back in. The same threshold the pane
 * uses; see keyboard-inset.ts.
 */
const KEYBOARD_MINIMUM = 120;

/**
 * The zoom the answer will be read under.
 *
 * The phone breakpoint zooms the root, and a length written into a custom
 * property there is multiplied by that zoom before it reaches the screen, while
 * `window.innerHeight` is already in screen pixels. Without dividing it back
 * out the shell is told to be a screen tall and then drawn 15% taller, which is
 * the bar below the fold this exists to prevent.
 */
function rootZoom(root: HTMLElement): number {
  const value = Number.parseFloat(window.getComputedStyle(root).zoom);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Publishes the measurement, and keeps it true, until the return value is called. */
export function watchAppHeight(): () => void {
  const root = document.documentElement;

  /** What was last written, so an unchanged measurement costs no layout. */
  let published = { app: -1, visible: -1, typing: -1 };
  let frame = 0;

  const measure = () => {
    const zoom = rootZoom(root);
    const layout = window.innerHeight;
    if (layout) {
      const app = Math.round(layout / zoom);
      if (app !== published.app) {
        published.app = app;
        root.style.setProperty(PROPERTY, `${app}px`);
      }
    }
    const viewport = window.visualViewport;
    const seen = viewport?.height;
    if (viewport && seen) {
      const visible = Math.round(seen / zoom);
      if (visible !== published.visible) {
        published.visible = visible;
        root.style.setProperty(VISIBLE, `${visible}px`);
      }
      /*
       * Held at whatever it last was with nothing covering the page. Seeded
       * on the first measurement either way, so there is always a value to
       * hold even for a page that opened with a keyboard already up.
       */
      const covered = layout ? layout - seen - viewport.offsetTop : 0;
      const typing = covered >= KEYBOARD_MINIMUM;
      if ((!typing || published.typing < 0) && visible !== published.typing) {
        published.typing = visible;
        root.style.setProperty(TYPING, `${visible}px`);
      }
    }
  };

  /*
   * One write per frame, however many events landed in it. A keyboard or a
   * toolbar arriving is a burst of resize and scroll events, and laying the
   * page out for each of them is work that can only be seen as stutter.
   */
  const apply = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  };

  measure();
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  /*
   * iOS changes the layout viewport when its toolbar collapses without always
   * firing a window resize for it; the visual viewport notices either way.
   */
  window.visualViewport?.addEventListener("resize", apply);

  window.visualViewport?.addEventListener("scroll", apply);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("resize", apply);
    window.removeEventListener("orientationchange", apply);
    window.visualViewport?.removeEventListener("resize", apply);
    window.visualViewport?.removeEventListener("scroll", apply);
    root.style.removeProperty(PROPERTY);
    root.style.removeProperty(VISIBLE);
    root.style.removeProperty(TYPING);
  };
}
