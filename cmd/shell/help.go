package main

import (
	"fmt"
	"io"
)

func printShellHelp(writer io.Writer) {
	fmt.Fprint(writer, `shell.online — a browser link for a local terminal process

Start
  shell <command>                  Share it in the background
  shell --read-only <command>      Share it while browser input is blocked
  shell                            Share a fresh shell
  shell claude                     Share a fork of this conversation

shell prints one URL, an eight-character browser password, and a QR containing
both. Shares are interactive by default and end-to-end encrypted.

Then
  shell list                       See active shares and uptime
  shell password <ID>              Print an active share's password locally
  shell password rotate <ID>       Revoke it and make a fresh password
  shell attach <ID>                Rejoin locally; browser access stays live
  Press Ctrl-X, then D to detach   Leave the process running
  shell kill <ID>                  Safely stop the process and close its link

Your account (optional)
  shell login                      Put this machine and its sessions in the web app
  shell login --no-browser         Print the approval URL instead of opening it
  shell whoami                     Show the linked account
  shell logout                     Unlink this machine

Common options
  --read-only                      View only
  --foreground                     Stay attached locally
  --persistent <state-file>        Keep one encrypted URL across restarts
  --auto-close <time>              Add an earlier deadline, such as 5m

Use shell help <start|attach|list|password|kill|login|e2ee|docker|platforms> for a
guided topic, or shell help reference for every command, flag, and environment variable.
`)
}

func runHelp(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		printShellHelp(stdout)
		return 0
	}
	if len(arguments) != 1 {
		fmt.Fprintln(stderr, "Usage: shell help [start|attach|list|kill|login|e2ee|docker|platforms|reference]")
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
  shell password <ID> prints an active session's password from its owner-only
  local record. An unlocked account vault can recover passwords that were sealed
  to it. If neither copy exists, E2EE deliberately has no recovery backdoor.
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
	case "login", "logout", "whoami", "account":
		fmt.Fprint(stdout, `shell login

Linking a machine to an account is optional. The CLI works exactly the same
without it; linking only adds a list of your shares at shell.online.

  1. Run shell login. A browser opens on the approval screen.
     shell login --no-browser prints the URL instead, but you must open it in
     a browser on this same machine: the callback is deliberately loopback-only.
  2. Approve the request. The browser hands a one-time code back to a listener
     bound to 127.0.0.1, so the code never leaves this computer.
  3. Run shell as usual. Each share is published to your account as it starts,
     and marked closed when the process exits.

What is published
  The share URL, the command name, the host name, and the timing. Never the
  terminal contents, and never the E2EE key: it lives in the URL fragment,
  which is stripped before the URL is sent.

  shell whoami                     Show the linked account
  shell logout                     Unlink this machine and revoke its token
  shell daemon status              Say whether your browser can start sessions here
  shell daemon stop                Stop accepting browser-started sessions now

Driving this machine from the browser
  shell login asks, once, whether your signed-in browser may start sessions on
  this machine. Say yes and a small daemon runs in the background for as long
  as you stay signed in, so the machine is there in the web app whether or not
  a terminal is open. Say no and nothing runs: shell <command> still publishes
  sessions to your account exactly as before.

  It is asked rather than assumed because it is a real capability. While it is
  allowed, anyone signed in to your account can launch processes here, as you,
  without touching this terminal.

    shell login --allow-remote-start   Agree without being asked
    shell login --no-remote-start      Withdraw it on this machine
    shell daemon stop                  Stop until the next shell command
    shell logout                       Stop it and unlink the machine

  The daemon starts again whenever you run a shell command, which covers a
  reboot the moment you use the tool. For a machine that sits idle and still
  has to be reachable, install it as a background service:

    shell service install              Keep it running across restarts
    shell service uninstall            Remove it
    shell service status               Say whether it is installed

  shell agent does the same thing in the foreground, printing each session as
  it starts, for anyone who would rather watch it than have it run unattended.

Running against a local stack
  Every address defaults to production, so setting only some of them aims the
  rest at the real service. SHELL_ONLINE_LOCAL=1 points the whole set at a
  local stack at once:

    accounts  http://127.0.0.1:8787
    web       http://localhost:5173
    relay     http://127.0.0.1:8788

  SHELL_ONLINE_ACCOUNTS, SHELL_ONLINE_WEB and SHELL_ONLINE_SERVER still
  override individually. shell login prints which services it is using
  whenever they are not the production ones.

Credentials live in your user config directory, readable only by you. Set
SHELL_ONLINE_CONFIG to keep them somewhere else.
`)
		return 0

	case "list", "ps":
		fmt.Fprint(stdout, `List active sessions

  shell list
  shell list --json

The table shows each session ID, access mode, uptime, closing rule, command, share
URL, whether a password is stored, and whether the relay is online, reconnecting,
expired, or temporarily unknown. Run shell password <ID> to reveal one deliberately.
Use an ID or an unambiguous prefix with shell attach or shell kill.
`)
	case "kill", "stop":
		fmt.Fprint(stdout, `Stop sessions

  shell kill <ID>
  shell kill --all

Stopping a session terminates its wrapped process and makes the browser link offline.
You do not need to stop completed work: the share closes automatically when its task exits.
`)
	case "password", "credentials":
		fmt.Fprint(stdout, `Session passwords

  shell password <ID>
      Print the password of an active locally managed session.

  shell password rotate <ID>
      Generate a fresh password and URL salt without restarting the process.
      The host activates the fresh cipher before the relay disconnects existing
      browser viewers, so old-key input is rejected immediately. The owner's
      account vault is updated, and teammate copies are removed until shared again.

Set SHELL_ONLINE_E2EE_PASSWORD for the rotate command to choose the replacement.
Persistent sessions update their owner-only state file, so restarts retain the
new credentials. Rotation cannot erase terminal output somebody already saw.
`)
	case "e2ee", "encryption", "privacy":
		fmt.Fprint(stdout, `End-to-end encryption

By default, every new share encrypts terminal payloads between the local CLI and each browser.
The relay sees authenticated ciphertext plus routing, size, timing, IP, and lifecycle
metadata. It never receives the browser password.

By default, shell prints a random eight-character password. To choose a stronger
password for sensitive or long-lived work:

  SHELL_ONLINE_E2EE_PASSWORD='use-a-long-unique-password' shell <command>

The printed share URL contains a random #salt= fragment, never the password. In an
interactive terminal, the QR contains both in its fragment so a phone can unlock in
one scan; fragments never reach the relay. Treat that QR as a bearer credential.
Send the printed URL and password separately when the channel or session is sensitive.
The legacy --e2ee flag remains accepted but is no longer necessary.
Use --no-e2ee only for deliberate compatibility or debugging; HTTPS/WSS still protects
transport hops, but Cloudflare can then access terminal payloads while relaying them.
`)
	case "docker", "container":
		fmt.Fprint(stdout, `Persistent Docker shell

The official GHCR image runs a persistent E2EE shell against shell.online. Mount
/var/lib/shell-online to retain one URL, host identity, and browser password across
container restarts. First launch generates and prints an eight-character password;
SHELL_ONLINE_E2EE_PASSWORD can set a longer one before the state is created.

Run `+"`shell password rotate <ID>`"+` inside the container to rotate a live
session without changing its stable path. The saved salt, key, and password are
updated together. The image is a hosted-service client, not a self-hosted relay.
`)
	case "platforms", "platform", "ros", "windows":
		fmt.Fprint(stdout, `Platforms

  macOS:       amd64, arm64
  Windows:     386, amd64, arm64 (Windows 10 1809+; native ConPTY)
  Linux:       386, amd64, armv5, armv6, armv7, arm64, loong64,
               mips, mipsle, mips64, mips64le, ppc64, ppc64le,
               riscv64, s390x
  FreeBSD:     386, amd64, armv7, arm64
  OpenBSD:     386, amd64, armv7, arm64, ppc64, riscv64
  NetBSD:      386, amd64, armv7, arm64
  DragonFly:   amd64
  Solaris:     amd64

The POSIX installer detects uname -s and uname -m, verifies SHA-256, and selects
the matching static binary. Windows has a PowerShell installer and supports the
same background, list, attach, kill, E2EE, and persistent-state workflow.

ROS 1 and ROS 2 need no bridge. Source the ROS environment, then wrap the normal
process, for example:

  shell roscore
  shell roslaunch <package> <launch-file>
  shell ros2 run <package> <executable>
  shell ros2 launch <package> <launch-file>

Use --persistent <state-file> to restore one URL and password when rerunning a
process. The Docker image combines it with a restart policy for automatic recovery.
`)
	case "reference", "cli", "commands":
		printCLIReference(stdout)
	default:
		fmt.Fprintf(stderr, "shell: unknown help topic %q\n", arguments[0])
		fmt.Fprintln(stderr, "Available topics: start, attach, list, password, kill, e2ee, docker, platforms, reference")
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
  shell password <session-id-or-prefix>
  shell password rotate <session-id-or-prefix>
  shell help [start|attach|list|password|kill|e2ee|docker|platforms|reference]

START AND SHARE
  shell [command] [arguments...]
      Wrap a command in a PTY, print its browser URL, and leave it running in
      the background. With no command, start the platform's default shell.
      Use -- before a command when argument boundaries are ambiguous.

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
      Re-run with the same file after a process or machine restart to restore the link.
  --foreground
      Mirror and control the process in the launching terminal instead of
      returning immediately.
  --auto-close <duration-or-date>
      Always close when the task exits; optionally add an earlier deadline.
      Units: ms, s, m, h, d, w, mo, y. Units may be combined, such as 1h30m.
      Dates: RFC3339, YYYY-MM-DD[ HH:MM[:SS]], HH:MM, or today/tomorrow [HH:MM].
      Bare today means the end of today; bare tomorrow means 00:00 tomorrow.
      Multi-token dates may be written directly, for example: --auto-close tomorrow 09:00.
      A missing or invalid value returns status 2 and never becomes the command.
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
      share URL, whether a password is stored, and independently checked relay status. Relay values shown in
      the table are online, starting, reconnecting, expired, and unknown.
  shell list --json
      Emit the same sessions as a JSON array on stdout. relay_status contains
      the raw connected, waiting, disconnected, expired, or unknown value.
  shell attach <session-id-or-prefix>
      Attach this terminal to one local session. Prefixes require at least six
      characters and must be unambiguous. Press Ctrl-X, then D to detach;
      Ctrl-] is the legacy alternative. Detaching does not stop the process.
      In a browser, Ctrl-D must be pressed twice within three seconds to send EOF;
      the first press warns because EOF can end a shell. Read-only links block it.
  shell kill <session-id-or-prefix>
      Stop one wrapped process and close its browser session.
  shell kill --all
      Stop every locally managed shell.online process.
  shell password <session-id-or-prefix>
      Recover an active session password from its owner-only local record.
  shell password rotate <session-id-or-prefix>
      Change the host cipher, disconnect current viewers, update persistent and
      local state, then atomically replace the account URL and owner's sealed
      vault copy. Old credentials cannot decrypt later frames; teammate copies
      must be shared again.
  shell help [topic]
      Print guided help. Topic aliases include run/share, ps, stop, and cli.

ENVIRONMENT
  SHELL
      Program used when no command is supplied on Unix. Windows prefers PowerShell,
      then COMSPEC.
  SHELL_ONLINE_SERVER
      Default relay URL; overridden by --server.
  SHELL_ONLINE_E2EE_PASSWORD
      Override the automatically generated eight-character browser password.
      The key is derived locally with a random URL salt; the password is never sent.

OUTPUT AND EXIT STATUS
  A background start returns 0 after the share is ready. A task that exits during
  the startup handshake prints its exit status and no dead URL or follow-up commands.
  --foreground returns the wrapped process status. Session commands return 0 on success, 1 on an
  operational failure, and 2 for invalid CLI usage. Start failures return 1;
  invalid flags or auto-close values return 2.

SESSION EVENT JSON
  New-session events include encrypted=true and e2ee_password. Agents should give
  operators both share_url and e2ee_password and must preserve the URL fragment.
`)
}
