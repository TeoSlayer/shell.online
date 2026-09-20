/**
 * The chat renderer, fed a scripted session.
 *
 * Every line below is the bytes a real process would have written, escape
 * codes and all, so what this page shows is what a session shows: nothing is
 * pre-parsed, and the renderer has no idea it is not connected to anything.
 *
 * Reached at /chat-preview.html while `npm run dev` is running.
 */

import "@xterm/xterm/css/xterm.css";
import "../../styles/tokens.css";
import "../../styles/base.css";
import "../../styles/shell.css";
import "../../styles/terminal.css";
import "../../styles/chat.css";
import { createTerminal, type TerminalSurface } from "../renderer";
import { DESKTOP_TERMINAL_GRID } from "../terminal-grid";

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

const page = document.createElement("div");
page.className = "pane";
page.dataset.active = "true";
page.dataset.renderer = "chat";
page.style.position = "relative";
page.style.height = "100vh";
const screen = document.createElement("div");
screen.className = "pane-screen";
page.append(screen);
root.append(page);

const terminal: TerminalSurface = createTerminal("chat", {
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

/* Whatever the preview sends is swallowed here; the script writes the replies. */
terminal.onData(() => {});

async function play(): Promise<void> {
  for (const step of SESSION) {
    if (step.typed) {
      typeAndSend(step.typed);
      await wait(120);
    }
    for (const chunk of step.writes) {
      terminal.write(chunk);
      await wait(40);
    }
    await wait(step.after ?? 300);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void play();
