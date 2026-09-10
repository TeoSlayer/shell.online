import { useEffect, type RefObject } from "react";

/**
 * Keeps the terminal above the on-screen keyboard.
 *
 * A phone does not shrink the layout viewport when its keyboard opens; it
 * covers the bottom of it. The prompt is at the bottom of a terminal, so the
 * line being typed was the first thing to go under the keyboard, and the only
 * way back to it was to dismiss the keyboard.
 *
 * The visual viewport is the part still on screen, so the pane is sized to
 * what is left below its own top edge. That covers the keyboard opening,
 * closing, and the page being scrolled while it is open.
 */

const PHONE = "(max-width: 900px)";

/* Read by .panes; see terminal.css. */
const PROPERTY = "--pane-height";

/* Room under the pane for the bottom bar and the page's own padding. */
const GAP = 16;
const MINIMUM = 180;

export function paneHeight(input: {
  /** Height of the part of the page still visible. */
  viewportHeight: number;
  /** How far the visual viewport has been scrolled inside the layout one. */
  offsetTop: number;
  /** The pane's top edge, in layout coordinates. */
  paneTop: number;
  /** Space to leave below the pane. */
  gap?: number;
  /**
   * The zoom the answer will be read under. Everything measured here is in
   * viewport pixels, but the property is read inside a zoomed subtree, where
   * a length is multiplied by the zoom before it reaches the screen. Without
   * dividing it back out the pane is sized to the room it has and then drawn
   * larger than that, which puts the prompt back under the keyboard.
   */
  zoom?: number;
}): number {
  const gap = input.gap ?? GAP;
  const zoom = input.zoom && input.zoom > 0 ? input.zoom : 1;
  const available = input.viewportHeight + input.offsetTop - input.paneTop - gap;
  return Math.max(MINIMUM, Math.round(available / zoom));
}

/**
 * Sizes the element to the space the keyboard has left it, on phones only.
 *
 * On anything larger the element keeps whatever the stylesheet gave it: a
 * desktop browser has no on-screen keyboard to make room for, and a window
 * that is merely narrow is not a phone.
 */
/**
 * The zoom applied to the page, as a number.
 *
 * The phone breakpoint zooms the root so the layout is not a desktop page
 * shrunk to fit. Browsers without `zoom`, and every width above that
 * breakpoint, report something that is not a number, which is 1.
 */
function rootZoom(root: HTMLElement): number {
  const value = Number.parseFloat(window.getComputedStyle(root).zoom);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function useKeyboardInset(target: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const node = target.current;
    if (!enabled || !viewport || !node) return;

    const phone = window.matchMedia(PHONE);
    const root = document.documentElement;

    /*
     * The answer is published as a custom property rather than written onto
     * the element. The stylesheet decides what to do with it, which keeps the
     * layout in CSS and means this hook reads the DOM without reshaping it.
     */
    const apply = () => {
      if (!phone.matches) {
        root.style.removeProperty(PROPERTY);
        return;
      }
      const paneTop = node.getBoundingClientRect().top + window.scrollY;
      root.style.setProperty(
        PROPERTY,
        `${paneHeight({
          viewportHeight: viewport.height,
          offsetTop: viewport.offsetTop,
          paneTop,
          zoom: rootZoom(root),
        })}px`,
      );
    };

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    phone.addEventListener("change", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      phone.removeEventListener("change", apply);
      root.style.removeProperty(PROPERTY);
    };
  }, [target, enabled]);
}
