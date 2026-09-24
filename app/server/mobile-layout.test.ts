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
    expect(css).toMatch(
      /\.shell-content:has\(\.panes:not\(\[hidden\]\) \.pane\[data-active="true"\]\[data-renderer="chat"\]\)\s*\{\s*padding-inline:\s*0/,
    );
  });
});

const terminal = readFileSync(new URL("../src/styles/terminal.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../src/terminal/chat/chat-view.ts", import.meta.url), "utf8");

describe("the canvas", () => {
  /*
   * Fifty pixels of paper above a conversation on a desktop, twenty-six on a
   * phone: the workspace's top padding, the tab line's margin under it, and
   * 28px of pane padding whose only job was to stop the renderer tab -- which
   * hangs below the tab line over the corner of the canvas -- from covering
   * the first row. It read as the canvas being inset inside a container.
   */
  it("begins at the tab line, with the renderer tab in the line rather than over it", () => {
    const chatPane = String.raw`\.shell-content:has\(\.panes:not\(\[hidden\]\) \.pane\[data-active="true"\]\[data-renderer="chat"\]\)`;
    expect(terminal).toMatch(new RegExp(`${chatPane}\\s*\\{\\s*padding-top:\\s*0`));
    expect(terminal).toMatch(new RegExp(`${chatPane} \\.terminal-bar\\s*\\{\\s*margin-bottom:\\s*0`));
    expect(terminal).toMatch(new RegExp(`${chatPane} \\.tab-renderer\\s*\\{[\\s\\S]*?position:\\s*static`));
    expect(terminal).toMatch(/\.panes \.pane\[data-renderer="chat"\]\s*\{\s*padding:\s*0/);
  });

  /*
   * Keyed on the pane being there rather than on `data-pane`, which is
   * published by the pane's own hook -- a hook a desktop does not run, so the
   * first version of this reached a phone and left a laptop alone.
   */
  it("does not hang the rule off an attribute only a phone publishes", () => {
    expect(terminal).not.toMatch(/:root\[data-pane="open"\] \.pane\s*\{\s*padding/);
  });
});

describe("a keyboard that moves the window rather than the page", () => {
  /*
   * iOS scrolls the *visual* viewport to lift a focused field above the
   * keyboard. The page does not move, so a shell anchored at the top of the
   * document hangs off the top of the screen by exactly that much, with a
   * strip of bare page under its bottom edge. It is intermittent because
   * whether the browser needs to scroll depends on where the caret is.
   */
  it("sits where the window is, not where the document starts", () => {
    expect(css).toMatch(/\.shell\s*\{[^}]*top:\s*var\(--viewport-top, 0px\)/);
    const hook = readFileSync(new URL("../src/lib/app-height.ts", import.meta.url), "utf8");
    expect(hook).toContain('const TOP = "--viewport-top"');
    /* What the document has scrolled is already had for free. */
    expect(hook).toMatch(/viewport\.offsetTop - window\.scrollY/);
  });
});

describe("the conversation as it is being written", () => {
  /*
   * An agent's paragraph is re-read from its screen every frame. Answering
   * that by emptying the bubble and building it again is correct, and is also
   * the blink: for as long as the agent is writing, the text somebody is
   * reading is removed from the page and put back, several times a second.
   */
  it("replaces the rows that changed rather than the whole message", () => {
    expect(view).not.toMatch(/body\.innerHTML = ""/);
    expect(view).toContain("lineSignature");
    expect(view).toMatch(/dataset\?\.sig === signature/);
  });

  /*
   * `sticking` is maintained from scroll events, and iOS does not deliver
   * those while a flick is still gliding. A message arriving mid-flick was
   * answered with where the reader had been a moment earlier, which for
   * somebody who had just started scrolling up was "at the bottom".
   */
  it("asks the scroller where it is instead of remembering", () => {
    expect(view).toMatch(/const wasAtBottom = .*this\.atBottom\(\)/);
    expect(view).toContain("private anchor()");
    expect(view).toContain("private hold(");
  });

  /* A tap is a fragile sequence on a phone; the press is not. */
  it("sends from the press as well as the click", () => {
    expect(view).toMatch(/addEventListener\("pointerup", send\)/);
    expect(view).toMatch(/addEventListener\("click", send\)/);
  });
});

describe("the sessions list, with tabs open behind it", () => {
  /*
   * Open tabs stay mounted while the list is in front of them, because that
   * is what makes switching back to one instant. So `.panes` is in the
   * document on the list too, and every rule that took a margin off "a
   * session" took the list's margins with it: the page lost the gutter every
   * other page in the application has.
   */
  it("keeps its margins, because a hidden pane is not an open session", () => {
    for (const source of [css, terminal]) {
      const stripping =
        source.match(/\.shell-content:has\(\.panes[^)]*\)[^{]*\{[^}]*padding-(?:inline|top)[^}]*\}/g) ?? [];
      expect(stripping.length).toBeGreaterThan(0);
      for (const rule of stripping) expect(rule).toContain(":not([hidden])");
    }
  });
});

describe("the two renderers", () => {
  /*
   * A conversation is the page and wants the whole of it. A terminal is a grid
   * with a hard edge, and run flush to the tab line and the window it reads as
   * output that has overflowed rather than as something laid out. So the
   * padding a conversation does not want is taken from a conversation only,
   * and the tab line follows the pane that is in front: the renderer picker
   * hangs over the corner of a terminal, where there is padding for it to
   * cover, and sits in the line above a conversation, where there is not.
   */
  it("take the padding off a conversation and leave it on a terminal", () => {
    const stripped = [
      ...(css.match(/\.shell-content:has\(\.panes[^{]*\{[^}]*padding-(?:inline|top)[^}]*\}/g) ?? []),
      ...(terminal.match(/\.shell-content:has\(\.panes[^{]*\{[^}]*padding-(?:inline|top)[^}]*\}/g) ?? []),
    ];
    expect(stripped.length).toBeGreaterThan(0);
    for (const rule of stripped) expect(rule).toContain('[data-renderer="chat"]');
    /* And the pane's own padding, which is what clears the renderer picker. */
    expect(terminal).not.toMatch(/\.panes \.pane\s*\{\s*padding:\s*0/);
  });
});

describe("a program nothing can read as messages", () => {
  /*
   * There is no grid in a conversation. This renderer used to mirror an
   * unadapted full-screen program into the thread as the grid it is, and a
   * grid is the one thing it cannot show: eighty columns will not go on a
   * phone at a size anybody can read, so what arrived was a wall of broken
   * rows inside a second scroller. It says what is running instead.
   */
  it("is a line of text, not a picture of a screen", () => {
    expect(chat).not.toMatch(/chat-screen|chat-mirror-size/);
    expect(view).not.toContain("screenCard");
    expect(view).not.toContain("fitMirrors");
    const transcript = readFileSync(new URL("../src/terminal/chat/transcript.ts", import.meta.url), "utf8");
    expect(transcript).not.toContain("screenOpened");
    expect(transcript).not.toContain('"screen"');
  });
});

describe("a box you can see what you type in", () => {
  /*
   * The box used to forward each key straight to the program whenever a
   * program owned the screen, which is every agent session. The justification
   * was that you could watch the keys land in the program's own input box,
   * inside the grid this renderer mirrored. That mirror is gone -- a grid does
   * not go on a phone and is not drawn any more -- so a forwarded key went
   * somewhere nothing displays: on a laptop you typed a prompt to an agent and
   * the box stayed empty.
   */
  it("composes a line instead of forwarding keys", () => {
    expect(view).not.toContain("composes()");
    expect(view).not.toContain("bytesForKey");
  });
});
