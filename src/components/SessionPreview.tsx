import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/*
 * This is the real terminal emulator shell.online ships to viewers (xterm.js),
 * replaying the two commands that link a machine to an account and then share a
 * process. The escape codes are the ones cmd/shell/session_output.go actually
 * writes: 38;5;111 for the wordmark, 38;5;183 for the spark, dim for labels,
 * 38;5;153 for values, 1;38;5;222 for the password, 38;5;114 for the
 * encryption line. The session id, password and email are illustrative.
 */

const SESSION_ID = "qN7wKb3xTm";
const PASSWORD = "k3wq9fmt";

const RESET = "\x1b[0m";
const label = (text: string) => `\x1b[2m${text.padEnd(10)}${RESET}`;
const value = (text: string) => `\x1b[38;5;153m${text}${RESET}`;
const brand = `  \x1b[38;5;111mshell.online${RESET}  \x1b[38;5;183m✦${RESET}`;

const LOGIN_CARD = [
  "",
  brand,
  "",
  `  \x1b[2mOpening your browser to sign in.${RESET}`,
  "",
  `  ${label("Signed in")} ${value("ana@example.com")}`,
  `  ${label("Device")} ana-mbp`,
  "",
  "",
];

const SESSION_CARD = [
  "",
  brand,
  "",
  `  ${label("Link")} ${value(`https://shell.online/s/${SESSION_ID}9Ld2Ravh4YsPcE8UjZ`)}`,
  `  ${label("Password")} \x1b[1;38;5;222m${PASSWORD}${RESET}`,
  `  ${label("Access")} interactive · \x1b[38;5;114mend-to-end encrypted${RESET}`,
  `  ${label("Session")} ${SESSION_ID} · background`,
  `  ${label("Closes")} when the task exits`,
  "",
  `  ${label("Rejoin")} ${value(`shell attach ${SESSION_ID}`)}`,
  `  ${label("Stop")} ${value(`shell kill ${SESSION_ID}`)}`,
  "",
  "",
];

const PROMPT = `\x1b[38;5;114m~/pilot${RESET} \x1b[38;5;183m❯${RESET} `;

/* Each step types its command, pauses, then prints the real output. */
const STEPS = [
  { command: "shell login", card: LOGIN_CARD, think: 900 },
  { command: "shell claude", card: SESSION_CARD, think: 1000 },
] as const;

const TYPE_MS = 62;
const START_MS = 400;

export function SessionPreview() {
  const mount = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"linking" | "sharing" | "done">("linking");

  useEffect(() => {
    const node = mount.current;
    if (!node) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace',
      fontSize: 12,
      lineHeight: 1.5,
      cursorBlink: !reduceMotion,
      cursorStyle: "block",
      convertEol: true,
      disableStdin: true,
      scrollback: 0,
      theme: {
        background: "#00000000",
        foreground: "#dfe2d6",
        cursor: "#c8ff4d",
        selectionBackground: "#3a3f33",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);

    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* the node can be detached mid-teardown */
      }
    };
    const frame = requestAnimationFrame(refit);
    const observer = new ResizeObserver(refit);
    observer.observe(node);

    const timers: number[] = [];
    const after = (ms: number, run: () => void) => {
      timers.push(window.setTimeout(run, ms));
    };

    if (reduceMotion) {
      /* No typing, no waiting: the whole transcript at once. */
      STEPS.forEach((step) => {
        term.write(PROMPT + step.command);
        term.write(`\r\n${step.card.join("\r\n")}`);
      });
      term.write(PROMPT);
      setState("done");
    } else {
      let clock = START_MS;
      STEPS.forEach((step, index) => {
        term.write(index === 0 ? PROMPT : "");
        const startedAt = clock;
        step.command.split("").forEach((character, position) => {
          after(startedAt + position * TYPE_MS, () => term.write(character));
        });
        clock = startedAt + step.command.length * TYPE_MS + step.think;

        const cardAt = clock;
        after(cardAt, () => {
          term.write(`\r\n${step.card.join("\r\n")}`);
          /* The next prompt is written with the card so the shell reads live. */
          term.write(PROMPT);
          setState(index === 0 ? "sharing" : "done");
        });
        clock = cardAt + 520;
      });
    }

    return () => {
      timers.forEach(window.clearTimeout);
      cancelAnimationFrame(frame);
      observer.disconnect();
      term.dispose();
    };
  }, []);

  const barLabel =
    state === "linking" ? "shell login" : state === "sharing" ? "shell claude" : "shell claude";
  const status = state === "linking" ? "linking" : state === "sharing" ? "starting" : "shared";

  return (
    <div className="stage-panel">
      <div className="stage-bar">
        <b>{barLabel}</b>
        <span className="stage-bar-live" data-state={state === "done" ? "done" : "live"}>
          <i aria-hidden="true" />
          {status}
        </span>
      </div>
      <div className="stage-term" ref={mount} aria-hidden="true" />
    </div>
  );
}
