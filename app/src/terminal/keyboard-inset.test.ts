import { describe, expect, it } from "vitest";
import { paneHeight } from "./keyboard-inset";

/*
 * A phone covers the bottom of the page with its keyboard rather than making
 * the page shorter, so the prompt goes under it. These hold the arithmetic
 * that decides how much of the screen the terminal still has.
 */
describe("sizing the terminal to what the keyboard has left", () => {
  it("uses the space below the pane when no keyboard is up", () => {
    expect(paneHeight({ viewportHeight: 800, offsetTop: 0, paneTop: 140, gap: 16 })).toBe(644);
  });

  it("gives back the height the keyboard took", () => {
    const closed = paneHeight({ viewportHeight: 800, offsetTop: 0, paneTop: 140, gap: 16 });
    const open = paneHeight({ viewportHeight: 500, offsetTop: 0, paneTop: 140, gap: 16 });
    expect(closed - open).toBe(300);
  });

  it("follows the page being scrolled while the keyboard is open", () => {
    /* Scrolling moves the pane up the screen; the space below it grows. */
    const still = paneHeight({ viewportHeight: 500, offsetTop: 0, paneTop: 140, gap: 16 });
    const scrolled = paneHeight({ viewportHeight: 500, offsetTop: 60, paneTop: 140, gap: 16 });
    expect(scrolled).toBe(still + 60);
  });

  it("keeps a usable terminal rather than collapsing to nothing", () => {
    /* A small landscape phone with the keyboard up leaves almost no room. */
    expect(paneHeight({ viewportHeight: 180, offsetTop: 0, paneTop: 140 })).toBe(180);
  });

  /*
   * The phone breakpoint zooms the root, so a length written into a custom
   * property is multiplied before it is drawn. Measuring the room in viewport
   * pixels and handing back a number read at 1.15x sized the pane to the space
   * the keyboard left and then drew it larger than that, which is the bug this
   * arithmetic exists to prevent.
   */
  it("answers in the space the stylesheet reads it in", () => {
    const room = paneHeight({ viewportHeight: 500, offsetTop: 0, paneTop: 140, gap: 16 });
    const zoomed = paneHeight({
      viewportHeight: 500, offsetTop: 0, paneTop: 140, gap: 16, zoom: 1.15,
    });
    expect(zoomed).toBe(Math.round(room / 1.15));
    /* Drawn at the zoom it was measured against, it is the room again. */
    expect(Math.round(zoomed * 1.15)).toBe(room);
  });

  it("treats an unzoomed page, and a browser that does not report one, as 1", () => {
    const plain = paneHeight({ viewportHeight: 800, offsetTop: 0, paneTop: 140, gap: 16 });
    expect(paneHeight({ viewportHeight: 800, offsetTop: 0, paneTop: 140, gap: 16, zoom: 1 }))
      .toBe(plain);
    expect(paneHeight({ viewportHeight: 800, offsetTop: 0, paneTop: 140, gap: 16, zoom: 0 }))
      .toBe(plain);
    expect(paneHeight({ viewportHeight: 800, offsetTop: 0, paneTop: 140, gap: 16, zoom: Number.NaN }))
      .toBe(plain);
  });
});
