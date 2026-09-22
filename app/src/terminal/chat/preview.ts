/**
 * The chat renderer, fed a scripted session.
 *
 * Every line below is the bytes a real process would have written, escape
 * codes and all, so what this page shows is what a session shows: nothing is
 * pre-parsed, and the renderer has no idea it is not connected to anything.
 *
 * Reached at /chat-preview.html while `npm run dev` is running.
 */

import { installViewportTheatre } from "./viewport-theatre";
import "@xterm/xterm/css/xterm.css";
import "../../styles/tokens.css";
import "../../styles/base.css";
import "../../styles/shell.css";
import "../../styles/terminal.css";
import "../../styles/chat.css";
import { createTerminal, type TerminalSurface } from "../renderer";
import { watchKeyboardInset } from "../keyboard-inset";
import { fittedTerminal } from "../terminal-fit";
import { cellMeasurer, terminalBox } from "../terminal-metrics";
import { DESKTOP_TERMINAL_GRID } from "../terminal-grid";

/*
 * Before anything reads the viewport, which is why it is the first statement
 * rather than an import: imports are hoisted and this is a side effect that
 * has to happen in a known order. Nothing captures `window.visualViewport` at
 * module scope, so installing it here is early enough for every reader.
 *
 * A phone's visible area moves -- a keyboard covers it, a browser toolbar
 * slides in and out of it -- and a desktop browser's never does, so the layout
 * bugs that only exist when it moves are invisible here without this. See
 * viewport-theatre.ts.
 */
installViewportTheatre();

const PROMPT = "\x1b[38;2;66;103;245m~/work/api\x1b[0m \x1b[1m❯\x1b[0m ";

/** One scripted step: what is typed, and what the process writes back. */
interface Step {
  typed?: string;
  writes: string[];
  /** Milliseconds before the next step, so output arrives the way it really does. */
  after?: number;
}

const SESSION: Step[] = [
  { writes: [PROMPT], after: 300 },
  {
    typed: "git status",
    writes: [
      "git status\r\n",
      "On branch \x1b[1mchat-renderer\x1b[0m\r\n",
      "Changes not staged for commit:\r\n",
      "  \x1b[31mmodified:   app/src/terminal/renderer.ts\x1b[0m\r\n",
      "  \x1b[31mmodified:   app/src/routes/Workspace.tsx\x1b[0m\r\n",
      "\r\n",
      "no changes added to commit\r\n",
      PROMPT,
    ],
    after: 700,
  },
  {
    typed: "npm run build",
    writes: [
      "npm run build\r\n",
      "\x1b[2mvite v8.3.0 building for production...\x1b[0m\r\n",
    ],
    after: 240,
  },
  /* A progress bar redrawing in place: one line, not two hundred. */
  {
    writes: ["transforming  \x1b[33m120\x1b[0m modules\r", "transforming  \x1b[33m480\x1b[0m modules\r"],
    after: 200,
  },
  {
    writes: [
      "transforming  \x1b[33m1204\x1b[0m modules\r\n",
      "\x1b[32m✓\x1b[0m built in 2.73s\r\n",
      PROMPT,
    ],
    after: 800,
  },
  {
    typed: "cat notes.md",
    writes: [
      "cat notes.md\r\n",
      "A line long enough that the terminal has to wrap it across two rows, which the conversation puts back together as the one line it was written as.\r\n",
      PROMPT,
    ],
    after: 800,
  },
  {
    typed: "vim notes.md",
    writes: [
      "vim notes.md\r\n",
      /* Into the alternate screen, where a chat has nothing to say. */
      "\x1b[?1049h\x1b[2J\x1b[H",
      "\x1b[1m  1\x1b[0m A line long enough that the terminal has to wrap it\r\n",
      "\x1b[1m  2\x1b[0m \r\n",
      "\x1b[1m  3\x1b[0m Second thought, written in the editor.\r\n",
      "\x1b[20;1H\x1b[7m NORMAL \x1b[0m notes.md                          3,1  All",
    ],
    after: 1600,
  },
  {
    writes: ["\x1b[?1049l", PROMPT],
    after: 600,
  },
  /*
   * A command nobody typed here: entered on the machine itself, or by another
   * person watching the same session. It arrives as an echo wrapped in the
   * shell's own markers, and has to appear in the conversation as a message
   * rather than being lost in the output.
   */
  {
    writes: [
      "\x1b]133;A\x07",
      PROMPT,
      "\x1b]133;B\x07",
      "npm test\r\n",
      "\x1b]133;C\x07",
      "> shell-online-app@0.0.0 test\r\n",
      "\r\n",
      "\x1b[32mPASS\x1b[0m  src/terminal/chat/transcript.test.ts\r\n",
      "\x1b[32mPASS\x1b[0m  src/terminal/chat/paragraphs.test.ts\r\n",
      "\r\n",
      "Test Files  2 passed (2)\r\n",
      "     Tests  67 passed (67)\r\n",
      "\r\n",
      "Everything is fine, which is a sentence long enough to need wrapping when it is shown as prose in a bubble on a narrow screen.\r\n",
      "\x1b]133;D;0\x07",
    ],
    after: 900,
  },
  {
    typed: "./deploy --production",
    writes: [
      "./deploy --production\r\n",
      "\x1b[31mfatal: refusing to deploy from a dirty tree\x1b[0m\r\n",
      PROMPT,
    ],
    after: 400,
  },
];

const root = document.getElementById("root");
if (!root) throw new Error("preview needs a #root");

/*
 * The same boxes the real workspace puts around a pane, in the same order.
 *
 * It matters on a phone, where every one of them is load-bearing: the root is
 * zoomed at the phone breakpoint, `.panes` is what gets sized to the space the
 * keyboard leaves, and the navigation bar is fixed over the bottom of the
 * window whether or not the composer would like to be there. A harness
 * missing any of the three cannot be used to fix how this behaves on a phone,
 * which is the only reason the mobile bugs survived the first round of it.
 */
const shell = document.createElement("div");
shell.className = "shell";

/* The rail is the first column of the shell grid; the pane goes in the second. */
const rail = document.createElement("aside");
rail.className = "rail";
const railNav = document.createElement("nav");
railNav.className = "rail-nav";
for (const label of ["Sessions", "People", "Audit", "Account"]) {
  const link = document.createElement("span");
  link.className = "rail-link";
  link.textContent = label;
  railNav.append(link);
}
rail.append(railNav);
shell.append(rail);

const main = document.createElement("div");
main.className = "shell-main";

/*
 * Everything the workspace puts between the top of the window and the pane.
 *
 * It is not decoration here. On a phone the pane is sized to the room left
 * below its own top edge, so the height of this chrome is an input to the
 * layout being worked on: a harness that starts the pane at the top of the
 * window measures a session that does not exist, and the composer ending up
 * halfway down a real screen is invisible in it. The topbar, the tab line and
 * the renderer notice are all present in a real session with a chat tab open.
 */
const topbar = document.createElement("header");
topbar.className = "topbar";
const topbarInner = document.createElement("div");
topbarInner.className = "topbar-inner";
const topbarHeading = document.createElement("div");
topbarHeading.className = "topbar-heading";
const topbarTitle = document.createElement("h1");
topbarTitle.className = "topbar-title";
topbarTitle.textContent = "Sessions";
topbarHeading.append(topbarTitle);
topbarInner.append(topbarHeading);
topbar.append(topbarInner);
main.append(topbar);

const content = document.createElement("div");
content.className = "shell-content";

const terminalBar = document.createElement("div");
terminalBar.className = "terminal-bar";
const tabs = document.createElement("div");
tabs.className = "tabs";
for (const [index, label] of ["All sessions", "api ~ zsh"].entries()) {
  const tab = document.createElement("span");
  tab.className = index === 1 ? "tab is-active" : "tab";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab-label";
  button.textContent = label;
  tab.append(button);
  tabs.append(tab);
}
terminalBar.append(tabs);
content.append(terminalBar);

const panes = document.createElement("div");
panes.className = "panes";

const page = document.createElement("div");
page.className = "pane";
page.dataset.active = "true";
page.dataset.renderer = "chat";

const screen = document.createElement("div");
screen.className = "pane-screen";
page.append(screen);
panes.append(page);
content.append(panes);
main.append(content);
shell.append(main);
root.append(shell);

/* Sizes the pane to what the keyboard has left, exactly as Workspace does. */
watchKeyboardInset(panes);

/*
 * Which renderer to mount. The chat one by default; "?renderer=xterm" mounts
 * the emulator instead, in the identical shell, so that a change meant for
 * one can be checked against the other rather than assumed not to reach it.
 */
const params = new URLSearchParams(window.location.search);
const which = params.get("renderer") === "xterm" ? "xterm" : "chat";

const terminal: TerminalSurface = createTerminal(which, {
  fontFamily: 'ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace',
  cols: DESKTOP_TERMINAL_GRID.cols,
  rows: DESKTOP_TERMINAL_GRID.rows,
  convertEol: false,
  scrollback: 5000,
  theme: {
    background: "#f3f1e9",
    foreground: "#191b18",
    red: "#b3261e",
    green: "#2f6d29",
    yellow: "#855d00",
    blue: "#294ec8",
    magenta: "#8a3aa3",
    cyan: "#17707a",
  },
});
terminal.open(screen);

/*
 * The same fit the pane performs, not an approximation of it.
 *
 * The pane draws the session's whole grid as large as it will go and pins the
 * emulator to that grid; the font and the leading are the only things a
 * viewer gets to choose. A harness that sets a font size instead cannot show
 * whether a layout change reached the terminal, which is the entire question
 * a harness is for.
 */
const FONT = 'ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace';
const measureCell = cellMeasurer(FONT);

function refit(): void {
  const box = terminalBox(screen);
  if (box.width === 0 || box.height === 0) return;
  const fitted = fittedTerminal(box, DESKTOP_TERMINAL_GRID, measureCell, {
    pixelRatio: window.devicePixelRatio,
    maxLineHeight: 1.35,
  });
  terminal.options.fontSize = fitted.fontSize;
  terminal.options.lineHeight = fitted.lineHeight;
  terminal.refresh(0, terminal.rows - 1);
}

new ResizeObserver(() => refit()).observe(screen);
requestAnimationFrame(refit);

/*
 * Two states that are hard to reach by typing but easy to get wrong.
 *
 * "?readonly" is the pane a colleague gets when they may watch but not type.
 * "reconnect", typed at the stand-in shell, is what the relay does when a
 * session comes back: the screen is replayed from the top, and the
 * conversation has to be rebuilt rather than played again in front of
 * whoever is watching.
 */
if (new URLSearchParams(window.location.search).has("readonly")) {
  terminal.options.disableStdin = true;
}

/*
 * The scripted commands are typed into the real composer and submitted the way
 * a person would, rather than being announced to the transcript directly. That
 * is the whole point of the harness: the echo suppression, the history and the
 * key handling are only proved by going through the box.
 */
function typeAndSend(text: string): void {
  const input = document.querySelector<HTMLTextAreaElement>(".chat-input");
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

/*
 * A stand-in for the process, so the composer can be used and not just
 * watched. It echoes what it is sent the way a PTY does -- the line back,
 * then the output, then a new prompt -- which is exactly the shape the
 * renderer has to get right.
 */
let scripted = true;
let pending = "";
/* Set by takeOver, so a case being set up is not typed over by the tour. */
let abandoned = false;

terminal.onData((data) => {
  if (scripted) return;
  for (const character of data) {
    if (character === "\x03") {
      terminal.write(`^C\r\n\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`);
      pending = "";
      continue;
    }
    if (character === "\r" && pending.trim() === "reconnect") {
      pending = "";
      const replay = `${PROMPT}git log --oneline -1\r\n0cd5684 Set Homebrew checksum\r\n\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`;
      terminal.reset();
      terminal.write(replay);
      continue;
    }
    if (character !== "\r") {
      pending += character;
      continue;
    }
    const line = pending;
    pending = "";
    terminal.write(`${line}\r\n`);
    /*
     * The interactive half publishes shell integration markers and the
     * scripted half above does not, so both ways of deciding where an answer
     * ends get exercised: the markers here, the pause up there.
     */
    terminal.write("\x1b]133;C\x07");
    const answer = reply(line);
    terminal.write(answer);
    /* "slow" answers on its own schedule and closes itself off below. */
    if (line.trim() !== "slow") {
      terminal.write(`\x1b]133;D;${exitFor(line)}\x07`);
      terminal.write(`\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`);
    }
  }
});

/** What the stand-in shell exits with, so a failure carries a status. */
function exitFor(line: string): number {
  const command = line.trim();
  if (command === "fail") return 1;
  if (command === "" || ["ls", "seq", "slow"].includes(command)) return 0;
  return 127;
}

function reply(line: string): string {
  const command = line.trim();
  if (command === "") return "";
  if (command === "ls") return "notes.md  package.json  src\r\n";
  if (command === "seq") {
    /* Long enough that the answer is folded, which is its own thing to look at. */
    return Array.from({ length: 120 }, (_, index) => `line ${index + 1}\r\n`).join("");
  }
  if (command === "fail") return "\x1b[31mfatal: nope\x1b[0m\r\n";
  if (command === "slow") {
    /*
     * Output that arrives after the call returns, the way a build or a server
     * does. The prompt follows it rather than preceding it, which is what a
     * shell does and what makes the markers around it mean anything.
     */
    for (let step = 1; step <= 4; step += 1) {
      setTimeout(() => terminal.write(`working ${step}\r\n`), step * 250);
    }
    setTimeout(() => terminal.write(`\x1b]133;D;0\x07\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`), 1150);
    return "";
  }
  return `${command}: command not found\r\n`;
}

async function play(): Promise<void> {
  for (const step of SESSION) {
    if (abandoned) return;
    if (step.typed) {
      typeAndSend(step.typed);
      await wait(120);
    }
    for (const chunk of step.writes) {
      if (abandoned) return;
      terminal.write(chunk);
      await wait(40);
    }
    await wait(step.after ?? 300);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * A handle on the session, so a case can be driven from the console or by
 * whatever is checking the page, rather than only by the script above.
 *
 * The scripted session is a tour of the cases the renderer has to get right;
 * it is not every case, and the ones that matter most are the ones nobody
 * thought to script. A full-screen agent interface is the example that cost
 * the most: it is what almost every real session is, and it could not be
 * reached here without typing a command into a stand-in shell that has never
 * heard of it.
 */
(window as unknown as { session: unknown }).session = {
  write: (data: string) => terminal.write(data),
  /* The renderer itself, so its state can be inspected while a case is open. */
  inside: terminal,
  reset: () => terminal.reset(),
  /* Stops the scripted tour, so a case can be set up without it typing over. */
  takeOver: () => {
    abandoned = true;
    scripted = false;
  },
};

void play().then(() => {
  scripted = false;
});
