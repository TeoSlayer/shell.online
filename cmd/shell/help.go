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
  shell --e2ee <command>           Encrypt terminal contents; key stays in URL fragment
  SHELL_ONLINE_E2EE_PASSWORD='…' shell --e2ee <command>
                                   Ask browsers for a separately shared password
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
  shell list                       Show local uptime, relay status, command, and URL
  shell list --json                Emit sessions and relay status as JSON
  shell attach <ID>                Open an active session in this terminal
  shell kill <ID>                  Stop its process and close its link
  shell kill --all                 Stop all processes and close their links

Options
  --read-only                      Block all browser input for this share
  --e2ee                           Encrypt terminal payloads between CLI and browsers
  --persistent <state-file>        Reuse one E2EE URL across process/container restarts
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
  shell help reference             Print the complete CLI reference
`)
}

func runHelp(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		printShellHelp(stdout)
		return 0
	}
	if len(arguments) != 1 {
		fmt.Fprintln(stderr, "Usage: shell help [start|attach|list|kill|reference]")
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
  shell --e2ee claude
  shell npm run dev
  shell --foreground htop
  shell --auto-close 5m pytest -x

When Claude Code runs "shell claude" through its Bash tool, shell detects the current
conversation and starts a shareable fork with its history. The original Claude process
stays open and the two conversations then diverge; shell does not claim to move the
already-running PID into another terminal.

E2EE notes
  --e2ee generates a random key in the URL fragment by default. URL fragments do
  not reach the relay. Set SHELL_ONLINE_E2EE_PASSWORD to put only a random salt
  in the URL and ask each browser for that password. Lost keys and passwords cannot
  be recovered. --persistent requires --e2ee and stores host and decryption secrets
  in an owner-only state file so the same URL can reconnect after a restart.
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

The table shows each session ID, access mode, uptime, closing rule, command, share
URL, and whether the relay is online, reconnecting, expired, or temporarily unknown.
Use an ID or an unambiguous prefix with shell attach or shell kill.
`)
	case "kill", "stop":
		fmt.Fprint(stdout, `Stop sessions

  shell kill <ID>
  shell kill --all

Stopping a session terminates its wrapped process and makes the browser link offline.
You do not need to stop completed work: the share closes automatically when its task exits.
`)
	case "reference", "cli", "commands":
		printCLIReference(stdout)
	default:
		fmt.Fprintf(stderr, "shell: unknown help topic %q\n", arguments[0])
		fmt.Fprintln(stderr, "Available topics: start, attach, list, kill, reference")
		return 2
	}
	return 0
}

func printCLIReference(writer io.Writer) {
	fmt.Fprint(writer, `Complete CLI reference

SYNOPSIS
  shell [options] [--] [command] [arguments...]
  shell list [--json]
  shell attach <session-id-or-prefix>
  shell kill <session-id-or-prefix>
  shell kill --all
  shell help [start|attach|list|kill|reference]

START AND SHARE
  shell [command] [arguments...]
      Wrap a command in a PTY, print its browser URL, and leave it running in
      the background. With no command, start the program named by $SHELL or
      /bin/sh. Use -- before a command when argument boundaries are ambiguous.

START OPTIONS
  --read-only
      Create an immutable view-only session. The relay rejects browser input.
  --e2ee
      Encrypt terminal frames between the CLI and browser. Without a password,
      the generated key is carried in the URL fragment.
  --persistent <state-file>
      Reuse a stable session identity and URL. Requires --e2ee. The owner-only
      state file contains host credentials and decryption material.
  --foreground
      Mirror and control the process in the launching terminal instead of
      returning immediately.
  --auto-close[=<duration-or-date>]
      Always close when the task exits; optionally add an earlier deadline.
      Units: ms, s, m, h, d, w, mo, y. Units may be combined, such as 1h30m.
      Dates: RFC3339, YYYY-MM-DD[ HH:MM[:SS]], HH:MM, today, or tomorrow HH:MM.
  --json
      Emit the new-session event as one JSON object on stderr.
  --server <URL>
      Override the relay URL. Defaults to $SHELL_ONLINE_SERVER, then
      https://shell.online.
  --version
      Print the CLI version and exit.
  -h, --help
      Print the guided top-level help and exit.

SESSION COMMANDS
  shell list
      List local processes with uptime, closing rule, access mode, command,
      share URL, and independently checked relay status. Relay values shown in
      the table are online, starting, reconnecting, expired, and unknown.
  shell list --json
      Emit the same sessions as a JSON array on stdout. relay_status contains
      the raw connected, waiting, disconnected, expired, or unknown value.
  shell attach <session-id-or-prefix>
      Attach this terminal to one local session. Prefixes require at least six
      characters and must be unambiguous. Press Ctrl-X, then D to detach;
      Ctrl-] is the legacy alternative. Detaching does not stop the process.
  shell kill <session-id-or-prefix>
      Stop one wrapped process and close its browser session.
  shell kill --all
      Stop every locally managed shell.online process.
  shell help [topic]
      Print guided help. Topic aliases include run/share, ps, stop, and cli.

ENVIRONMENT
  SHELL
      Program used when no command is supplied.
  SHELL_ONLINE_SERVER
      Default relay URL; overridden by --server.
  SHELL_ONLINE_E2EE_PASSWORD
      Derive the E2EE key from this password and a random URL salt instead of
      placing a random key in the URL fragment. The password is never sent.

OUTPUT AND EXIT STATUS
  A background start returns 0 after the share is ready. --foreground returns
  the wrapped process status. Session commands return 0 on success, 1 on an
  operational failure, and 2 for invalid CLI usage. Start failures return 1;
  invalid flags or auto-close values return 2.
`)
}
