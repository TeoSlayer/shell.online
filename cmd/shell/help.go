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
  SHELL_ONLINE_E2EE_PASSWORD='…' shell <command>
                                   Replace the generated browser password
  shell                            Share a fresh instance of your default shell

Every normal share is end-to-end encrypted. shell prints an eight-character browser
password with the URL; recipients need both. Use a longer custom password for
sensitive or long-lived sessions.

From inside Claude Code
  shell claude                     Share a fork of this conversation and workspace

The guided flow
  1. Run a process with shell.
  2. Send the printed shell.online/s/<share-ID> URL and password to someone you trust.
     Shares are interactive by default. Use --read-only when recipients should only watch.
  3. Use shell list to see active shares and how long they have run.
  4. Use shell attach <ID> to take over locally without ending browser access.
  5. Press Ctrl-X, then D to detach and leave the process running.
  6. Use shell kill <ID> to stop the process and close its link.
     A share also closes automatically when its task exits.

Manage sessions
  shell list                       Show uptime, relay status, URL, and browser password
  shell list --json                Emit sessions and relay status as JSON
  shell attach <ID>                Open an active session in this terminal
  shell kill <ID>                  Stop its process and close its link
  shell kill --all                 Stop all processes and close their links

Options
  --read-only                      Block all browser input for this share
  --e2ee                           Compatibility flag; E2EE is already the default
  --no-e2ee                        Disable payload E2EE; Cloudflare can relay plaintext
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
  shell help e2ee
  shell help docker
  shell help reference             Print the complete CLI reference
`)
}

func runHelp(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		printShellHelp(stdout)
		return 0
	}
	if len(arguments) != 1 {
		fmt.Fprintln(stderr, "Usage: shell help [start|attach|list|kill|e2ee|docker|reference]")
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

E2EE notes
  Every normal share is encrypted automatically. shell generates and prints an
  eight-character browser password unless SHELL_ONLINE_E2EE_PASSWORD is set.
  The URL contains only a random salt; key derivation happens in the CLI and browser.
  Lost passwords cannot be recovered. Persistent sessions store their password,
  host credential, and decryption key in an owner-only state file so the same URL
  can reconnect after a restart.
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
URL, browser password, and whether the relay is online, reconnecting, expired, or
temporarily unknown. The owner-only local record retains the generated password so
an active share can be sent again without creating a replacement.
Use an ID or an unambiguous prefix with shell attach or shell kill.
`)
	case "kill", "stop":
		fmt.Fprint(stdout, `Stop sessions

  shell kill <ID>
  shell kill --all

Stopping a session terminates its wrapped process and makes the browser link offline.
You do not need to stop completed work: the share closes automatically when its task exits.
`)
	case "e2ee", "encryption", "privacy":
		fmt.Fprint(stdout, `End-to-end encryption

By default, every new share encrypts terminal payloads between the local CLI and each browser.
The relay sees authenticated ciphertext plus routing, size, timing, IP, and lifecycle
metadata. It never receives the browser password.

By default, shell prints a random eight-character password. To choose a stronger
password for sensitive or long-lived work:

  SHELL_ONLINE_E2EE_PASSWORD='use-a-long-unique-password' shell <command>

The share URL contains a random #salt= fragment, never the password. Recipients need
both the complete URL and password. Send them separately when the channel or session
is sensitive. The legacy --e2ee flag remains accepted but is no longer necessary.
Use --no-e2ee only for deliberate compatibility or debugging; HTTPS/WSS still protects
transport hops, but Cloudflare can then access terminal payloads while relaying them.
`)
	case "docker", "container":
		fmt.Fprint(stdout, `Persistent Docker shell

The official GHCR image runs a persistent E2EE shell against shell.online. Mount
/var/lib/shell-online to retain one URL, host identity, and browser password across
container restarts. First launch generates and prints an eight-character password;
SHELL_ONLINE_E2EE_PASSWORD can set a longer one before the state is created.

Changing the password for an existing state volume is refused because its URL salt
and encryption key are already bound to the original password. Create a new state
volume to rotate the password and receive a new link. The image is a hosted-service
client, not a self-hosted relay.
`)
	case "reference", "cli", "commands":
		printCLIReference(stdout)
	default:
		fmt.Fprintf(stderr, "shell: unknown help topic %q\n", arguments[0])
		fmt.Fprintln(stderr, "Available topics: start, attach, list, kill, e2ee, docker, reference")
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
  shell help [start|attach|list|kill|e2ee|docker|reference]

START AND SHARE
  shell [command] [arguments...]
      Wrap a command in a PTY, print its browser URL, and leave it running in
      the background. With no command, start the program named by $SHELL or
      /bin/sh. Use -- before a command when argument boundaries are ambiguous.

START OPTIONS
  --read-only
      Create an immutable view-only session. The relay rejects browser input.
  --e2ee
      Compatibility flag. New shares are already end-to-end encrypted by default.
  --no-e2ee
      Explicitly disable terminal-payload E2EE. HTTPS/WSS still encrypts transport,
      but Cloudflare can access terminal input and output while relaying it. Cannot
      be combined with --e2ee, SHELL_ONLINE_E2EE_PASSWORD, or --persistent.
  --persistent <state-file>
      Reuse a stable session identity, password, and URL. The owner-only state
      file contains host credentials, the browser password, and decryption material.
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
      share URL, browser password, and independently checked relay status. Relay values shown in
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
      Override the automatically generated eight-character browser password.
      The key is derived locally with a random URL salt; the password is never sent.

OUTPUT AND EXIT STATUS
  A background start returns 0 after the share is ready. --foreground returns
  the wrapped process status. Session commands return 0 on success, 1 on an
  operational failure, and 2 for invalid CLI usage. Start failures return 1;
  invalid flags or auto-close values return 2.

SESSION EVENT JSON
  New-session events include encrypted=true and e2ee_password. Agents should give
  operators both share_url and e2ee_password and must preserve the URL fragment.
`)
}
