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
});
