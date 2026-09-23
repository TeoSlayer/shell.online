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

});

const chat = readFileSync(new URL("../src/styles/chat.css", import.meta.url), "utf8");

describe("the conversation under an open keyboard", () => {
  /*
   * The keyboard is subtracted exactly once, by the shell.
   *
   * Every breakpoint sizes the shell to the visible viewport -- `--visible-height`
   * on a phone, `--app-height` less `--keyboard-inset` on a tablet -- so the foot
   * of the surface is already the top of the keyboard. The composer used to add
   * `--keyboard-inset` to its own dock as well, from when the shell stayed
   * screen-height and the box had to climb out from under the keyboard alone.
   * The two together lifted it by the height of the keyboard twice: the field
   * landed a third of the way up a 508px screen with the conversation pushed
   * off the top of it.
   */
  it("subtracts the keyboard once, in the shell, and not again in the composer", () => {
    expect(css).toMatch(/--visible-height|--keyboard-inset/);
    /* Comments off: this file explains the bug it is guarding against. */
    expect(chat.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/--keyboard-inset/);
  });

  /*
   * A phone held sideways with the keyboard up leaves under 200px of viewport.
   * The thread is a flex item whose padding clears the composer, and a flex
   * item's default `min-height: auto` refuses to shrink below that padding --
   * so the bottom of the thread, where every new message lands, hung below the
   * pane where nothing draws.
   */
  it("lets the thread shrink below the padding that clears the composer", () => {
    const scroll = chat.match(/\n\.chat-scroll\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(scroll).toMatch(/min-height:\s*0/);
  });

  /*
   * Landscape is the tablet layout, where the bar is the `auto` row at the top
   * of the shell's grid rather than the last row. Hiding it alone left the
   * template's two rows to one child: the workspace inherited `auto`, sized
   * itself to its content, and the pane collapsed to nothing.
   */
  it("gives the row the bar held back to the workspace, not to nothing", () => {
    const tablet = css.match(/@media\s*\(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(tablet).toMatch(/:root\[data-keyboard="open"\] \.rail\s*\{\s*display:\s*none/);
    const rows = tablet.match(/:root\[data-keyboard="open"\] \.shell\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(rows).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
  });
});

describe("the width of the conversation", () => {
  /*
   * The pane starts where the rail ends, so one gutter is the whole of the
   * inset: an edge, not a container. It had a 940px measure centred inside a
   * pane already inset from the window, which read on a laptop as a strip of
   * paper down both sides of everything -- and taking the measure off without
   * putting a gutter back clipped the rounded corners against the window.
   */
  it("insets the thread and the box it talks to by the same one distance", () => {
    expect(chat).toMatch(/--chat-gutter-x:\s*12px/);
    const scroll = chat.match(/\n\.chat-scroll\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(scroll).toMatch(/padding:\s*4px var\(--chat-gutter-x\)/);
    const composer = chat.match(/\n\.chat-composer\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(composer).toMatch(/right:\s*var\(--chat-gutter-x\)/);
    expect(composer).toMatch(/left:\s*var\(--chat-gutter-x\)/);
  });

  /* And the pane itself keeps no padding of its own beside the rail. */
  it("starts the pane where the rail ends", () => {
    expect(css).toMatch(/\.shell-content:has\(\.panes\)\s*\{[\s\S]*?padding-inline:\s*0/);
  });
});
