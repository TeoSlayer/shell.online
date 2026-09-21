package main

import (
	"fmt"
	"io"
	"strings"
)

var helpTopics = [...]string{
	"start", "files", "attach", "list", "ls", "password", "kill", "auth",
	"briefings", "permissions",
	"stats", "agent", "daemon", "service", "e2ee", "docker", "platforms", "mcp", "reference",
}

func helpTopicUsage() string {
	return strings.Join(helpTopics[:], "|")
}

func helpTopicList() string {
	return strings.Join(helpTopics[:], ", ")
}

func printShellHelp(writer io.Writer) {
	fmt.Fprintf(writer, `shell.online — a browser link for a local terminal process

Start
  shell <command>                  Share it in the background
  shell --read-only <command>      Share it while browser input is blocked
  shell --files <command>          Add on-demand files from this directory
  shell --name <name> <command>    Label it in shell ls and the web app
  shell                            Share a fresh shell

Conversation handoff
  shell claude                     Share a fork of this Claude conversation
  shell opencode                   Share a fork of this opencode conversation
  shell claude                     Share a fork of this conversation

shell prints one URL, a ten-character browser password, and a QR containing
both. Shares are interactive by default and end-to-end encrypted.

Then
  shell list                       See active shares and uptime
  shell list --json                Give agents the complete machine-readable records
  shell ls                         See every open session in your account, on any machine
  shell password <ID>              Print an active share's password locally
  shell password rotate <ID>       Revoke it and make a fresh password
  shell attach <ID>                Rejoin locally; browser access stays live
  Press Ctrl-X, then D to detach   Leave the process running
  shell kill <ID>                  Safely stop the process and close its link

Your account (optional)
  shell auth                      Put this machine and its sessions in the web app
  shell auth --no-browser         Print the approval URL instead of opening it
  shell whoami                     Show the linked account
  shell logout                     Unlink this machine
  shell briefings status|on|off   Daily-briefing consent for your sessions [--all]
  shell permissions <ID>          Read or set a session's automation switches

Machine services
  shell agent                      Watch for browser-started sessions in this terminal
  shell daemon status|start|stop   Manage browser-started sessions in the background
  shell service install|status     Keep the machine agent running across restarts
  shell stats                      Show what this machine would report to the game

MCP access
  shell mcp grant <ID> <label> <observe|control> [ttl-seconds]
                                   Print a scoped MCP bearer once (keep it secret)
  shell mcp revoke-all <ID>        Revoke every MCP grant for this run

Common options
  --read-only                      View only
  --name <name>                    Label the session
  --foreground                     Stay attached locally
  --persistent <state-file>        Keep one encrypted URL across restarts
  --files                          Opt in the working directory for file access
  --files-root <directory>         Opt in a different directory
  --auto-close <time>              Add an earlier deadline, such as 5m

Use shell help <%s> for a guided topic, or shell help reference for every command,
flag, and environment variable.
`, helpTopicUsage())
}

func runHelp(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		printShellHelp(stdout)
		return 0
	}
	if len(arguments) != 1 {
		fmt.Fprintf(stderr, "Usage: shell help [%s]\n", helpTopicUsage())
		return 2
	}

	switch arguments[0] {
	case "mcp":
		fmt.Fprint(stdout, `MCP observation and control

  shell mcp grant <ID> <label> observe [ttl-seconds]
  shell mcp grant <ID> <label> control [ttl-seconds]
  shell mcp list <ID>
  shell mcp revoke <ID> <grant-id>
  shell mcp revoke-all <ID>

Endpoint: https://shell.online/mcp (or your configured service URL plus /mcp).
Issuance prints a secret bearer once. Use the MCP client's secret/environment support;
never put credentials in URLs, command arguments, repositories, or logs.
Quote labels with spaces (e.g. "My Agent"). Labels are limited to 256 UTF-8 bytes;
control characters are rejected. TTL is a non-negative whole number; 0 uses the default.
Safe grant requests require an updated running host. If unsupported, update and restart
that session's shell host when safe; there is no unsafe legacy-format fallback.
Observe tools: shell_status, shell_screen, shell_output, shell_wait.
Control adds shell_send on compatible hosts when enabled; read-only always blocks writes.
shell_key and shell_interrupt are not available in this release.

MCP authorizes server-side in-memory decryption using a host-supplied frame key.
The controller receives plaintext results. Browser-only sharing remains E2EE.
shell_send requires a UUID-v4 operation_id. Reuse it with identical arguments on retry.
delivered means the full PTY write, not task completion. Never blindly retry uncertainty
with a new ID. Revocation cannot undo completed actions or erase received output.
`)
	case "start", "run", "share":
		fmt.Fprint(stdout, `Start and share

  shell <command> [arguments...]
  shell --read-only <command> [arguments...]
  shell

The command stays on this machine and runs in the background by default. shell prints
one unguessable browser link. Links are interactive by default; --read-only creates
a view-only link whose browser input is blocked by the server. Omit the command for
a fresh shell. --name gives the session a label, shown in shell list, shell ls, and
the web app, where it can be renamed later.

Examples
  shell python train.py
  shell claude
  shell opencode
  shell codex
  shell --read-only python train.py
  shell --name "web app" npm run dev
  shell --foreground htop
  shell --auto-close 5m pytest -x
  shell --files claude
  shell --files-root ./artifacts python train.py

When Claude Code runs "shell claude" through its Bash tool, or opencode runs
"shell opencode", shell detects the current conversation and starts a shareable
fork with its history. The original process stays open and the two conversations
then diverge; shell does not claim to move the already-running PID into another
terminal.

E2EE notes
  Every normal share is encrypted automatically. shell generates and prints a
  ten-character browser password unless SHELL_ONLINE_E2EE_PASSWORD is set.
  The URL contains only a random salt; key derivation happens in the CLI and browser.
  shell password <ID> prints an active session's password from its owner-only
  local record. An unlocked account vault can recover passwords that were sealed
  to it. If neither copy exists, E2EE deliberately has no recovery backdoor.
`)
	case "files":
		fmt.Fprint(stdout, `Share files on demand

  shell --files <command>
  shell --files-root <directory> <command>

File access is off by default. --files scopes it to the command's working
directory; --files-root chooses another root. Only regular files beneath that
root can be opened. Parent traversal, device files, and symlink escapes are
rejected by the CLI.

The browser receives no directory listing or file contents until it asks. When
enabled, a Files control appears in both xterm.js and Refstream views. Refstream
also turns filename-like terminal output into backed previews; terminal text is
never treated as filesystem authority. Read-only terminal links may read files
that were deliberately opted in, but they still cannot type into the process.

Files use the session's existing authenticated, end-to-end encrypted WebSocket.
The relay routes request IDs and encrypted frame sizes, not paths or contents.
Transfers are bounded and pull-driven so a slow viewer cannot block the PTY.
File sharing therefore cannot be combined with --no-e2ee.
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
	case "auth", "login", "logout", "whoami", "account":
		fmt.Fprint(stdout, `shell auth

Linking a machine to an account is optional. The CLI works exactly the same
without it; linking only adds a list of your shares at shell.online.

  shell login is the same command. That is what it was called up to 0.18, and
  it still works, so nothing anybody wrote down has stopped being true.

  1. Run shell auth. A browser opens on the approval screen.
     shell auth --no-browser prints the URL instead, for a machine with no
     browser on it.
  2. Approve the request. The browser hands a one-time code back to a listener
     bound to 127.0.0.1, so the code never leaves this computer.
     A browser on a different computer cannot reach that listener, so it stops
     on a page that will not load. Paste that page's address back into the
     terminal and the sign-in completes from there.
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
  shell auth asks, once, whether your signed-in browser may start sessions on
  this machine. Say yes and a small daemon runs in the background for as long
  as you stay signed in, so the machine is there in the web app whether or not
  a terminal is open. Say no and nothing runs: shell <command> still publishes
  sessions to your account exactly as before.

  It is asked rather than assumed because it is a real capability. While it is
  allowed, anyone signed in to your account can launch processes here, as you,
  without touching this terminal.

    shell auth --allow-remote-start   Agree without being asked
    shell auth --no-remote-start      Withdraw it on this machine
    shell daemon stop                  Stop until the next shell command
    shell logout                       Stop it and unlink the machine

  Saying yes the first time also installs the daemon as a background service,
  so the machine is reachable after a restart without anybody logging in and
  running something. That is the case the service exists for: a machine you
  want to reach from a browser is a machine nobody is sitting at.

    shell service status               Say whether one is installed
    shell service install              Install it again after removing it
    shell service uninstall            Remove it

  Without one the daemon still starts whenever you run a shell command, which
  covers a reboot the moment you use the tool.
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
  override individually. shell auth prints which services it is using
  whenever they are not the production ones.

Credentials live in your user config directory, readable only by you. Set
SHELL_ONLINE_CONFIG to keep them somewhere else.
		`)
	case "stats":
		fmt.Fprint(stdout, `What this machine would report

  shell stats [--json] [--days N] [--dir PATH]

Prints the numbers a statistics run would send to the game, and sends nothing.

The game's elixir vial is filled by these runs, and they happen on this machine
rather than on the server because sessions are encrypted end to end: the server
holds no key and cannot read one. So the reading happens where the plaintext
already is, and what leaves is counts.

What it reads: how many commits and how many lines changed in this repository,
how many pull requests you have open if the GitHub CLI is here, and how many
tokens your coding agents have spent, from their own local files.

What it never reads: terminal output, file contents, diffs, commit messages,
branch names, prompts or replies. Run it with --json to see the exact report.

Nothing is gathered unless you have turned the gathering on in the game, and
this command does not turn it on or send anything anywhere.
		`)
	case "agent":
		fmt.Fprint(stdout, `Machine agent

  shell agent

Watch for sessions started from the browser. A machine that has enabled browser
starts normally runs this in the background; use the foreground agent when you
want to see each command as it starts and stops.
`)
	case "daemon":
		fmt.Fprint(stdout, `Background daemon

  shell daemon status
  shell daemon start
  shell daemon stop

The daemon lets your signed-in browser start processes on this machine. It is
separate from publishing sessions started in this terminal. Stop it to return
the machine to publish-only mode; existing sessions keep running.
`)
	case "service":
		fmt.Fprint(stdout, `Machine service

  shell service install
  shell service status
  shell service uninstall

Install the background agent as the platform service so it returns after a
restart. This requires a linked account and browser-start permission.
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

shell list shows the processes on this machine. shell ls shows the sessions in
your account instead, from every linked machine; see shell help ls.
`)
	case "ls":
		fmt.Fprint(stdout, `List your account's sessions

  shell ls
  shell ls --all
  shell ls --json

Lists the sessions you started on any machine linked to your account, newest
first, with each one's name, status, uptime, and machine. Sessions that have
ended are hidden and counted; --all includes them. --json prints the complete
records on stdout, including share_url and the raw relay_status.

shell ls needs a linked machine (shell auth). It never prints a password: those
stay on the machine that started the session and in your vault. To share a
program that is itself called ls, put -- first: shell -- ls.
`)
	case "briefings":
		fmt.Fprint(stdout, `Daily-briefing consent

  shell briefings status
  shell briefings on [--all]
  shell briefings off [--all]

Your daily-briefing consent, stored on your account rather than on any one
machine, so a re-login or a new machine cannot reset it.

  on/off     The default your new sessions start with.
  --all      Also apply it to the sessions you currently have.

This is consent only: the switch is saved and read back, but this build does
not yet generate a briefing, and the command says so rather than implying it.
Per-session switches live on the session itself; see shell help permissions.
`)
	case "permissions":
		fmt.Fprint(stdout, `Session automation permissions

  shell permissions <session-id>
  shell permissions <session-id> --mcp-team-access=true|false
                                 [--daily-briefing=true|false]
                                 [--briefing-team-access=true|false]

Reads a session's automation permissions, or updates the ones you name. A
switch you do not name is left exactly as it is.

  --mcp-team-access        Let a teammate's agent reach this session over MCP.
  --daily-briefing         Generate a daily briefing for this session.
  --briefing-team-access   Let teammates read this session's briefing.

The three switches are independent: agreeing to one is not agreeing to the
others. These are the same server-owned switches the web app writes, so a
change made here is what the browser sees on its next read, and a change made
in the browser is what this reads. Only the session's owner can change them;
they are consent, and this build does not act on them yet.
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

By default, shell prints a random ten-character password. To choose a stronger
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
container restarts. First launch generates and prints a ten-character password;
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
		fmt.Fprintf(stderr, "Available topics: %s\n", helpTopicList())
		return 2
	}
	return 0
}

func printCLIReference(writer io.Writer) {
	fmt.Fprintf(writer, `Complete CLI reference

SYNOPSIS
  shell [options] [--] [command] [arguments...]
  shell list [--json]
  shell ls [--all] [--json]
  shell briefings status
  shell briefings on [--all]
  shell briefings off [--all]
  shell permissions <session-id> [--mcp-team-access=true|false]
                       [--daily-briefing=true|false] [--briefing-team-access=true|false]
  shell attach <session-id-or-prefix>
  shell kill <session-id-or-prefix>
  shell kill --all
  shell password <session-id-or-prefix>
  shell password rotate <session-id-or-prefix>
  shell help [%s]
  shell mcp grant <ID> <label> <observe|control> [ttl-seconds]
  shell mcp list <ID>
  shell mcp revoke <ID> <grant-id>
  shell mcp revoke-all <ID>

START AND SHARE
  shell [command] [arguments...]
      Wrap a command in a PTY, print its browser URL, and leave it running in
      the background. With no command, start the platform's default shell.
      Use -- before a command when argument boundaries are ambiguous.

START OPTIONS
  --read-only
      Create an immutable view-only session. The relay rejects browser input.
  --name <name>
      Label the session in shell list, shell ls, and the web app. One line, at
      most 120 characters. A persistent session that restarts without --name
      keeps the name it had, including one given in the web app.
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
  --files
      Opt in regular files under the process working directory. The browser
      discovers and reads them only on demand; nothing is shared by default.
  --files-root <directory>
      Opt in a different root. Parent traversal and symlink escapes are rejected.
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
      Use this form in scripts and agents: the human table abbreviates long
      URLs, while JSON preserves the complete share URL and password fields.
  shell ls [--all] [--json]
      List the sessions in the linked account from every machine, with name,
      status, uptime, machine, and command. Ended sessions are hidden unless
      --all is given. JSON output omits passwords. Requires shell auth.
  shell briefings status
      Show the daily-briefing default your new sessions start with.
  shell briefings on [--all]
      Turn the daily-briefing default on. --all also applies it to the
      sessions you currently have.
  shell briefings off [--all]
      Turn the daily-briefing default off. --all also applies it to the
      sessions you currently have. Consent only: this build does not generate
      a briefing yet, and the command says so.
  shell permissions <session-id>
      Read a session's automation switches: MCP team access, daily briefing,
      and briefing team access.
  shell permissions <session-id> --mcp-team-access=true|false
                                 [--daily-briefing=true|false]
                                 [--briefing-team-access=true|false]
      Update the switches you name; a switch you do not name is left as it is.
      Only the session's owner can change them. They are the same server-owned
      switches the web app writes, and this build does not act on them yet.
  shell agent
      Watch for browser-started sessions in this terminal.
  shell daemon status|start|stop
      Manage the background listener for browser-started sessions.
  shell service install|status|uninstall
      Install or inspect the persistent machine service.
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
      Print guided help. Topic aliases include run/share, ps, stop, account,
      container, platform, and cli.

ENVIRONMENT
  MCP grants authorize server-side in-memory decryption. See shell help mcp for
  credential handling, write retry semantics, revocation and supported tools.

  SHELL
      Program used when no command is supplied on Unix. Windows prefers PowerShell,
      then COMSPEC.
  SHELL_ONLINE_SERVER
      Default relay URL; overridden by --server.
  SHELL_ONLINE_E2EE_PASSWORD
      Override the automatically generated ten-character browser password.
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
`, helpTopicUsage())
}
