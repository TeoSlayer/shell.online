import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8");

describe("mobile account menu", () => {
  it("opens below the header account chip instead of beyond the top edge", () => {
    const mobileRule = css.match(/@media\s*\(max-width:\s*900px\)[\s\S]*?\.account-pop\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(mobileRule).toMatch(/top:\s*calc\(100% \+ 8px\)/);
    expect(mobileRule).toMatch(/right:\s*0/);
    expect(mobileRule).toMatch(/bottom:\s*auto/);
  });
});

const auth = readFileSync(new URL("../src/styles/auth.css", import.meta.url), "utf8");

describe("dark overlays", () => {
  it("never derives drop shadows or scrims from theme-switching text ink", () => {
    for (const file of ["auth", "people", "audit"]) {
      const source = readFileSync(new URL(`../src/styles/${file}.css`, import.meta.url), "utf8");
      expect(source).not.toMatch(/box-shadow:[^;]*var\(--ink\)/);
      expect(source).not.toMatch(/background:\s*color-mix\(in srgb, var\(--ink\) 32%/);
      expect(source).toContain("var(--shadow-ink)");
    }
  });
});

describe("the sessions toolbar", () => {
  /*
   * Search field, status picker, clean-up button and view toggle used to be
   * four different heights, and further apart on a touch screen than on a
   * desktop because three of them took the 44px minimum in base.css and the
   * search field, being a label rather than a button, did not.
   */
  it("gives every control in the row the search field's height", () => {
    const shared = auth.match(
      /\.sessions-toolbar \.sessions-search,[\s\S]*?\.sessions-toolbar \.view-toggle\s*\{([\s\S]*?)\}/,
    )?.[1];
    expect(shared).toBeTruthy();
    expect(shared).toMatch(/height:\s*var\(--filter-height\)/);
    /* Restated, because base.css sets a taller one under `pointer: coarse`. */
    expect(shared).toMatch(/min-height:\s*var\(--filter-height\)/);
    expect(auth).toMatch(/\.sessions-toolbar\s*\{\s*--filter-height:/);
  });

  it("lets the view toggle's options fill it rather than set its height", () => {
    const option = auth.match(/\.sessions-toolbar \.view-option\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(option).toMatch(/height:\s*100%/);
    expect(option).toMatch(/min-height:\s*0/);
  });
});

describe("the phone bottom bar", () => {
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px) {"));

  /*
   * A row of the shell, not something fixed over the foot of it. A session was
   * already laid out this way; the rest of the app was documents scrolling
   * under a fixed bar, which is what let the page decide where the bar sat.
   */
  it("makes the bar the shell's last row on every phone page", () => {
    const rail = phone.match(/\n {2}\.rail\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(rail).toMatch(/position:\s*static/);
    expect(rail).toMatch(/grid-row:\s*2/);
    expect(rail).not.toMatch(/position:\s*fixed/);
    const shell = phone.match(/\n {2}\.shell\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(shell).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\) auto/);
    const main = phone.match(/\n {2}\.shell-main\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(main).toMatch(/grid-row:\s*1/);
  });

  /*
   * One screen, clipped, with the content column scrolling inside it. A page
   * that scrolls as a whole leaves where the bar sits up to the browser, and a
   * page whose content arrives late or fails to arrive then moves it.
   */
  it("keeps the shell one screen tall so the page cannot move the bar", () => {
    const shell = phone.match(/\n {2}\.shell\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    /*
     * From one measurement of the visible page, on every page. It was
     * `--app-height` less `--keyboard-inset`, and a session worked its height
     * out a third way -- so the bar sat higher in a session than everywhere
     * else, and moved once while a page was still loading. The bar is the
     * bottom edge of this box, so there can only be one expression for it.
     */
    expect(shell).toMatch(/height:\s*var\(--visible-height, calc\(100dvh \/ var\(--zoom\)\)\)/);
    expect(shell).toMatch(/overflow:\s*hidden/);
    const content = phone.match(/\n {2}\.shell-content\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(content).toMatch(/overflow-y:\s*auto/);
    expect(content).toMatch(/min-height:\s*0/);
  });

  /*
   * The bar reserves its own space now, so no page has to guess at its height.
   * The guess was 88px against a bar that measured 69.
   */
  it("leaves no page guessing at the bar's height", () => {
    expect(phone).not.toMatch(/padding-bottom:\s*calc\(88px/);
    expect(css).not.toMatch(/--bar-height/);
  });

  /* Nothing passes behind it any more, so it is not translucent any more. */
  it("draws the bar opaque", () => {
    const rail = phone.match(/\n {2}\.rail\s*\{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(rail).toMatch(/background:\s*var\(--paper\)/);
    expect(rail).not.toMatch(/backdrop-filter/);
  });

  /*
   * A row that translates itself off the screen leaves its own height behind
   * as a blank strip, which is what sliding a fixed bar away did not.
   */
  it("takes the bar out of the flow while the keyboard is up", () => {
    const hidden = phone.match(/:root\[data-keyboard="open"\] \.rail\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(hidden).toMatch(/display:\s*none/);
    expect(hidden).not.toMatch(/translateY/);
  });

  /*
   * Except in a session, where the row stays and only the bar stops being
   * drawn. Collapsing the row resizes the pane, and a pane that changes size
   * refits the terminal's grid to a different font; leaving the bar drawn is
   * worse still, because a session is taller than the visible page while a
   * keyboard is up and a phone scrolls the visible page to follow a focused
   * field -- which walked the bar up into the middle of the canvas.
   */
  it("keeps the bar's row in a session but stops drawing it", () => {
    const session =
      phone.match(/:root\[data-pane="open"\]\[data-keyboard="open"\] \.rail\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    /* The row stays (display) and the bar stops being drawn (visibility). */
    expect(session).toMatch(/display:\s*flex/);
    expect(session).toMatch(/visibility:\s*hidden/);
    expect(session).not.toMatch(/display:\s*none/);
  });

  /* And the session is the one page that does not shrink for the keyboard. */
  it("holds a session's height while somebody is typing in it", () => {
    const typing =
      phone.match(/:root\[data-pane="open"\]\[data-keyboard="open"\] \.shell\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(typing).toMatch(/height:\s*var\(--typing-height/);
  });
});
