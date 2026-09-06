import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/*
 * This is the real terminal emulator shell.online ships to viewers (xterm.js),
 * replaying the real output of `shell claude`. The escape codes below are the
 * ones cmd/shell/session_output.go actually writes: 38;5;111 for the wordmark,
 * 38;5;183 for the spark, dim for labels, 38;5;153 for values, 1;38;5;222 for
 * the password, 38;5;114 for the encryption line. Session id and password are
 * illustrative; everything else is verbatim.
 */

const SESSION_ID = "qN7wKb3xTm";
const PASSWORD = "k3wq9fmt";

const RESET = "\x1b[0m";
const label = (text: string) => `\x1b[2m${text.padEnd(10)}${RESET}`;
const value = (text: string) => `\x1b[38;5;153m${text}${RESET}`;

const CARD = [
  "",
  `  \x1b[38;5;111mshell.online${RESET}  \x1b[38;5;183m✦${RESET}`,
  "",
  `  ${label("Link")} ${value("https://shell.online/s/qN7wKb3xTm9Ld2Ravh4YsPcE8UjZ")}`,
  `  ${label("Password")} \x1b[1;38;5;222m${PASSWORD}${RESET}`,
  `  ${label("Access")} interactive · \x1b[38;5;114mend-to-end encrypted${RESET}`,
  `  ${label("Session")} ${SESSION_ID} · background`,
  `  ${label("Closes")} when the task exits`,
  "",
  `  ${label("Rejoin")} ${value(`shell attach ${SESSION_ID}`)}`,
  `  ${label("Stop")} ${value(`shell kill ${SESSION_ID}`)}`,
  "",
];

const PROMPT = `\x1b[38;5;114m~/pilot${RESET} \x1b[38;5;183m❯${RESET} `;
const COMMAND = "shell claude";

export function SessionPreview() {
  const mount = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"live" | "done">("live");

  useEffect(() => {
    const node = mount.current;
    if (!node) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace',
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

    /* Fit once laid out, then on every container resize. */
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

    const writeCard = () => {
      term.write(`\r\n${CARD.join("\r\n")}`);
      /* The process is backgrounded, so the shell hands the prompt straight back. */
      term.write(PROMPT);
      setState("done");
    };

    if (reduceMotion) {
      term.write(PROMPT + COMMAND);
      writeCard();
    } else {
      term.write(PROMPT);
      COMMAND.split("").forEach((character, index) => {
        after(420 + index * 74, () => term.write(character));
      });
      after(420 + COMMAND.length * 74 + 420, () => {
        term.write("\r\n\r\n  \x1b[38;5;111mshell.online\x1b[0m  \x1b[38;5;183m◦\x1b[0m connecting");
      });
      after(420 + COMMAND.length * 74 + 1180, () => {
        term.write("\r\x1b[2K");
        writeCard();
      });
    }

    return () => {
      timers.forEach(window.clearTimeout);
      cancelAnimationFrame(frame);
      observer.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <div className="stage-panel">
      <div className="stage-bar">
        <b>shell claude</b>
        <span className="stage-bar-live" data-state={state}>
          <i aria-hidden="true" />
          {state === "live" ? "starting" : "shared"}
        </span>
      </div>
      <div className="stage-term" ref={mount} aria-hidden="true" />
    </div>
  );
}
