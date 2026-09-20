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

void play().then(() => {
  scripted = false;
});
