package main

import (
	"fmt"
	"io"
)

func printShellHelp(writer io.Writer) {
	fmt.Fprint(writer, `shell.online — a browser link for a local terminal process

Quick start
  shell <command> [arguments...]   Run in the background and print an interactive link
  shell --read-only <command>      Print a view-only link; browser input is blocked
  shell                            Share a fresh instance of your default shell

From inside Claude Code
  shell claude                     Share a fork of this conversation and workspace

The guided flow
  1. Run a process with shell.
  2. Send the printed shell.online/s/<share-ID> link to someone you trust.
     Links are interactive by default. Use --read-only when recipients should only watch.
  3. Use shell list to see active shares and how long they have run.
  4. Use shell attach <ID> to take over locally without ending browser access.
  5. Press Ctrl-X, then D to detach and leave the process running.
  6. Use shell kill <ID> to stop the process and close its link.
     A share also closes automatically when its task exits.

Manage sessions
  shell list                       Show active sessions, uptime, command, and URL
  shell list --json                Emit active sessions as JSON
  shell attach <ID>                Open an active session in this terminal
  shell kill <ID>                  Stop its process and close its link
  shell kill --all                 Stop all processes and close their links

Options
  --read-only                      Block all browser input for this share
  --foreground                     Mirror the process in this terminal too
  --auto-close <duration-or-date>  Add an earlier deadline, such as 5m or tomorrow 09:00
  --json                           Emit the new-session event as JSON
  --server <URL>                   Use another shell.online service URL
  --version                        Print the CLI version

More guidance
  shell help start
  shell help attach
  shell help list
  shell help kill
`)
}

func runHelp(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		printShellHelp(stdout)
		return 0
	}
	if len(arguments) != 1 {
		fmt.Fprintln(stderr, "Usage: shell help [start|attach|list|kill]")
		return 2
	}

	switch arguments[0] {
	case "start", "run", "share":
		fmt.Fprint(stdout, `Start and share

  shell <command> [arguments...]
  shell --read-only <command> [arguments...]
  shell

The command stays on this machine and runs in the background by default. shell prints
one unguessable browser link. Links are interactive by default; --read-only creates
a view-only link whose browser input is blocked by the server. Omit the command for
a fresh shell.

Examples
  shell python train.py
  shell claude
  shell codex
  shell --read-only python train.py
  shell npm run dev
  shell --foreground htop
  shell --auto-close 5m pytest -x

When Claude Code runs "shell claude" through its Bash tool, shell detects the current
conversation and starts a shareable fork with its history. The original Claude process
stays open and the two conversations then diverge; shell does not claim to move the
already-running PID into another terminal.
`)
	case "attach":
		fmt.Fprint(stdout, `Attach locally

  1. Run shell list and copy an active session ID or its first 6+ characters.
  2. Run shell attach <ID>.
  3. Work in the process normally. Local input and output are mirrored online.
  4. Press Ctrl-X, release it, then press D. The wrapper intercepts the sequence
     before Claude, Codex, or another child TUI can receive it.

Detaching does not stop the process or disable the browser link. While attached,
the terminal title keeps the Ctrl-X D reminder visible. Ctrl-] is also supported as
a legacy alternative. Ctrl-Z only suspends the local shell client; it does not detach.
`)
	case "list", "ps":
		fmt.Fprint(stdout, `List active sessions

  shell list
  shell list --json

The table shows each session ID, access mode, uptime, closing rule, command, and
existing share URL. Use an ID or an unambiguous prefix with shell attach or shell kill.
`)
	case "kill", "stop":
		fmt.Fprint(stdout, `Stop sessions

  shell kill <ID>
  shell kill --all

Stopping a session terminates its wrapped process and makes the browser link offline.
You do not need to stop completed work: the share closes automatically when its task exits.
`)
	default:
		fmt.Fprintf(stderr, "shell: unknown help topic %q\n", arguments[0])
		fmt.Fprintln(stderr, "Available topics: start, attach, list, kill")
		return 2
	}
	return 0
}
