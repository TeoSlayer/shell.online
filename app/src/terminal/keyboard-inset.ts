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
/* A form can scroll in less room than the terminal's minimum usable height. */
const GATE_PROPERTY = "--pane-gate-height";

/* Read by anything that has to sit clear of the keyboard; see chat.css. */
const INSET_PROPERTY = "--keyboard-inset";

/**
 * How tall the part of the page a person can actually see is.
 *
 * One number, from one source, and that is the whole point of it. A session's
 * column is sized from this and from nothing else.
 *
 * The column used to be `--app-height` less `--keyboard-inset`, which is
 * correct arithmetic and still went wrong, because the two terms come from
 * different places and are only equal to the visible height if every engine
 * agrees about what `window.innerHeight` means while a keyboard is up. They
 * do not: Safari holds it at the layout viewport, a page saved to the home
 * screen shrinks it, and the two properties are published by two modules
 * listening to the same event, so a frame can be laid out with a new value of
 * one and a stale value of the other. When the two disagree the column is the
 * wrong height by exactly their difference -- which is the bar lifted off the
 * foot of the screen with a strip of dead page under it.
 *
 * `visualViewport.height` is already the answer, on every engine, whatever is
 * covering the bottom of the screen and whatever `innerHeight` happens to
 * think. Nothing is subtracted from it and nothing else is consulted, so
 * there is nothing left to disagree with.
 *
 * It is published app-wide by lib/app-height.ts rather than from here, so it
 * is right before a pane exists and cannot be unpublished when one closes.
 * What is measured here is what only a pane can know: where its own top edge
 * is, and therefore how much room is left below it.
 */


/**
 * The smallest change worth writing, in the units the properties are in.
 *
 * A browser reports the viewport in fractional pixels and reports it often.
 * Writing a property the layout depends on for a third of a pixel costs a
 * layout and moves nothing anybody can see, and a run of them is the flicker
 * this is here to avoid.
 */
const SIGNIFICANT_PX = 1;

/* Set on the root element while the keyboard is up, so CSS can react to it. */
const STATE_ATTRIBUTE = "data-keyboard";

/*
 * Set on the root element while a session pane is the page, on a phone.
 *
 * It is what lets the stylesheet turn the shell from a page that scrolls into
 * a column that does not. Every other page on a phone -- the session list,
 * the account sheet, the audit log -- is a document and has to scroll; a
 * session is an application and must not, because a terminal that scrolls the
 * page under itself puts the thing being typed into wherever the page happens
 * to be rather than at the foot of the screen.
 */
const SURFACE_ATTRIBUTE = "data-pane";

/*
 * Room left under the pane, in viewport pixels.
 *
 * None, on purpose. What has to be cleared below a pane on a phone is the
 * bottom navigation bar, and the bar's height is a fact about the stylesheet:
 * it is the bar's own padding, its safe-area inset and the size of a touch
 * target, all written in shell.css. Guessing at it again here is how the
 * clearance came to be counted twice -- once as sixteen pixels of gap, once
 * as the composer's own dock -- and the composer ended up floating a finger
 * and a half above the foot of the screen with nothing under it.
 *
 * So this measures to the bottom of what is visible. On a phone with a
 * session open the stylesheet does not use the answer at all: the shell is a
 * column exactly one screen tall, the bar is a row of it, and the pane is the
 * row that takes what is left. This is the fallback for everything else.
 */
const GAP = 0;
const MINIMUM = 180;

/**
 * How much of the bottom the keyboard has to cover before it counts as open.
 *
 * The visual viewport shrinks for other reasons -- a browser's own toolbar
 * sliding back in as the page is scrolled up is the common one -- and treating
 * that as a keyboard would hide the navigation bar while somebody was
 * scrolling a list. A keyboard is a quarter of a phone; a toolbar is not.
 */
export const KEYBOARD_MINIMUM = 120;

export function paneHeight(input: {
  /** Height of the part of the page still visible. */
  viewportHeight: number;
  /** How far the visual viewport has been scrolled inside the layout one. */
  offsetTop: number;
  /**
   * The pane's top edge, measured from the top of the layout viewport, which
   * is what `getBoundingClientRect` reports and the space the two viewport
   * figures above are in. Not a document offset: adding the page's scroll
   * position to it mixes two coordinate systems, and the pane was then sized
   * as though the whole page above it were still on screen.
   */
  paneTop: number;
  /** Space to leave below the pane. */
  gap?: number;
  /** Unlock overlays use zero; the terminal retains its usable minimum. */
  minimum?: number;
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
  return Math.max(input.minimum ?? MINIMUM, Math.round(available / zoom));
}

/**
 * How much of the bottom of the page the on-screen keyboard is covering.
 *
 * A phone does not make the page shorter when its keyboard opens. The layout
 * viewport stays the height it was and the visual viewport -- the part still
 * on screen -- shrinks, so the difference between them is the keyboard.
 *
 * Reported in the same zoomed space the pane height is, for the same reason:
 * the answer is read inside a subtree the phone breakpoint zooms, where a
 * length is multiplied before it reaches the screen.
 */
export function keyboardInset(input: {
  /** The layout viewport's height, which the keyboard does not change. */
  layoutHeight: number;
  /** Height of the part of the page still visible. */
  viewportHeight: number;
  /** How far the visual viewport has been scrolled inside the layout one. */
  offsetTop: number;
  zoom?: number;
}): number {
  const zoom = input.zoom && input.zoom > 0 ? input.zoom : 1;
  const covered = input.layoutHeight - input.viewportHeight - input.offsetTop;
  return covered <= 0 ? 0 : Math.round(covered / zoom);
}

/** Whether that much cover is a keyboard rather than a browser toolbar. */
export function keyboardIsOpen(inset: number): boolean {
  return inset >= KEYBOARD_MINIMUM;
}

/**
 * How tall the visible part of the page is, in the units the stylesheet reads
 * the answer in.
 *
 * The whole of it. Whatever is covering the bottom of the screen -- a
 * keyboard, a browser toolbar, both -- is already not in this number, which
 * is why nothing is taken off it. Every time this layout has been wrong, it
 * has been wrong by taking something off it twice.
 */
export function visibleHeight(input: { viewportHeight: number; zoom?: number }): number {
  const zoom = input.zoom && input.zoom > 0 ? input.zoom : 1;
  return Math.round(input.viewportHeight / zoom);
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
/** Whether a new measurement is far enough from the last to be worth a layout. */
function moved(next: number, last: number): boolean {
  return last < 0 || Math.abs(next - last) >= SIGNIFICANT_PX;
}

function rootZoom(root: HTMLElement): number {
  const value = Number.parseFloat(window.getComputedStyle(root).zoom);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Publishes the measurements, and keeps them true, until the returned
 * function is called.
 *
 * Separate from the hook below so that something which is not a React
 * component can ask for the same behaviour -- the development harness for the
 * chat renderer does, and a harness that does not reproduce the keyboard is
 * a harness that cannot be used to fix it.
 */
export function watchKeyboardInset(node: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const phone = window.matchMedia(PHONE);
  const root = document.documentElement;

  /*
   * The answer is published as a custom property rather than written onto
   * the element. The stylesheet decides what to do with it, which keeps the
   * layout in CSS and means this hook reads the DOM without reshaping it.
   */
  /** What was last written, so an unchanged measurement costs no layout. */
  let published = { pane: -1, gate: -1, inset: -1 };
  let frame = 0;

  const clear = () => {
    root.style.removeProperty(PROPERTY);
    root.style.removeProperty(GATE_PROPERTY);
    root.style.removeProperty(INSET_PROPERTY);
    root.removeAttribute(STATE_ATTRIBUTE);
    root.removeAttribute(SURFACE_ATTRIBUTE);
    published = { pane: -1, gate: -1, inset: -1 };
  };

  const measure = () => {
    if (!phone.matches) {
      clear();
      return;
    }
    root.setAttribute(SURFACE_ATTRIBUTE, "open");
    const zoom = rootZoom(root);
    /*
     * Viewport-relative, and left that way. `visualViewport.height` and
     * `.offsetTop` describe the visible part of the layout viewport, so the
     * pane's top has to be in the same space for the subtraction to mean
     * anything. Adding `window.scrollY` put it in document coordinates
     * instead: on a session page that scrolled at all, the pane was handed
     * the room it would have had at the top of the document, which on a phone
     * is a couple of hundred pixels short -- and a couple of hundred pixels
     * short is a conversation in a box in the middle of the screen.
     */
    const paneTop = node.getBoundingClientRect().top;

    const inset = keyboardInset({
      layoutHeight: window.innerHeight,
      viewportHeight: viewport.height,
      offsetTop: viewport.offsetTop,
      zoom,
    });
    const typing = keyboardIsOpen(inset);

    const pane = paneHeight({
      viewportHeight: viewport.height,
      offsetTop: viewport.offsetTop,
      paneTop,
      zoom,
    });
    if (moved(pane, published.pane)) {
      published.pane = pane;
      root.style.setProperty(PROPERTY, `${pane}px`);
    }
    const gate = paneHeight({
      viewportHeight: viewport.height, offsetTop: viewport.offsetTop,
      paneTop, zoom, minimum: 0,
    });
    if (moved(gate, published.gate)) {
      published.gate = gate;
      root.style.setProperty(GATE_PROPERTY, `${gate}px`);
    }
    /*
     * Published as well as used, because the pane is not the only thing that
     * has to know: the composer rises by exactly this much to clear the
     * keyboard, and the thread makes the same amount of room under itself.
     */
    if (moved(inset, published.inset)) {
      published.inset = inset;
      root.style.setProperty(INSET_PROPERTY, `${inset}px`);
    }
    if (typing) root.setAttribute(STATE_ATTRIBUTE, "open");
    else root.removeAttribute(STATE_ATTRIBUTE);
  };

  /*
   * One write per frame, however many events landed in it.
   *
   * A keyboard opening is not one event. Both `resize` and `scroll` fire, and
   * they fire again for every frame of the animation, so a single gesture
   * arrives as a burst. Measuring and writing on each of them lays the page
   * out several times per frame to reach a position it was going to reach
   * anyway, which is work that can only be seen as stutter.
   */
  const apply = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  };

  measure();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  phone.addEventListener("change", apply);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    phone.removeEventListener("change", apply);
    clear();
  };
}

export function useKeyboardInset(target: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const node = target.current;
    if (!enabled || !node) return;
    return watchKeyboardInset(node);
  }, [target, enabled]);
}
