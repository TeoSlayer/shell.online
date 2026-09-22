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

  const apply = () => {
    const height = window.innerHeight;
    if (!height) return;
    root.style.setProperty(PROPERTY, `${Math.round(height / rootZoom(root))}px`);
  };

  apply();
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  /*
   * iOS changes the layout viewport when its toolbar collapses without always
   * firing a window resize for it; the visual viewport notices either way.
   */
  window.visualViewport?.addEventListener("resize", apply);

  return () => {
    window.removeEventListener("resize", apply);
    window.removeEventListener("orientationchange", apply);
    window.visualViewport?.removeEventListener("resize", apply);
    root.style.removeProperty(PROPERTY);
  };
}
