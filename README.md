# shell.online

[![CI](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml)
[![CodeQL](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-53658c.svg)](LICENSE)

Turn a terminal command into an interactive browser link. The command and PTY stay on your machine; anyone with the link can watch or type. Cloudflare only relays terminal input and output while the session is active.

## Install

Homebrew is not required. The verified installer supports macOS and Linux on arm64 and amd64:

```sh
curl -fsSL https://shell.online/install | sh
shell claude
```

The installer uses `/usr/local/bin` when writable, `$XDG_BIN_HOME` when set, and otherwise `~/.local/bin`. It detects Rosetta, verifies the binary checksum before writing it, never invokes `sudo`, and never silently edits shell configuration. If the destination is not on `PATH` or another `shell` command shadows it, the installer prints specific repair instructions. Set `SHELL_ONLINE_INSTALL_DIR` to choose an absolute writable destination.

Homebrew users can tap this repository directly once, then use the short formula name:

```sh
brew tap teoslayer/shell-online https://github.com/TeoSlayer/shell.online
brew trust --formula teoslayer/shell-online/shell-online
brew install shell-online
```

Homebrew 6 requires the one-time, formula-scoped trust command for third-party taps. Older Homebrew versions that do not provide `brew trust` do not require that line. After setup, the short `brew install shell-online`, `brew upgrade shell-online`, and `brew uninstall shell-online` commands work normally. Confirm the command selected by your `PATH` with `command -v shell` and `shell --version`.

Homebrew and the curl installer both use the checksum-pinned release binary. To compile the tagged source yourself and run it without installing it globally:

```sh
git clone --depth 1 --branch v0.3.9 https://github.com/TeoSlayer/shell.online.git
cd shell.online
go build -trimpath -ldflags="-X main.version=0.3.9" -o ./shell ./cmd/shell
./shell --version
```

This path requires Go 1.27 or newer. Keep using `./shell`, or move that binary to any directory already on your `PATH`.

Every release publishes one canonical [`SHA256SUMS`](https://shell.online/downloads/SHA256SUMS) manifest and machine-readable [`release.json`](https://shell.online/downloads/release.json). The manifest covers every platform binary plus the installer, agent skill, and metadata file. The installer verifies the selected binary before installing it, prints its SHA-256 digest, and the same artifacts and manifest are attached to the corresponding GitHub release.

Agent operators can download the ready-to-install skill from `https://shell.online/skill` as `SKILL.md`.

`shell` prints the link and detaches by default. The browser link grants interactive access to anyone who has it. There are no accounts or login prompts.

When an already-running Claude Code session invokes `shell claude` through its Bash tool, the CLI detects Claude's current session ID and starts a shareable fork of that conversation under shell.online. The fork keeps the conversation history and workspace, while the original Claude process remains open; new messages after the handoff do not synchronize between them. This is a safe handoff to a new process, not a claim that macOS can retroactively move the original PID to another PTY.

## Run and manage sessions

Omit the command to share a fresh instance of your default shell:

```sh
shell
```

Sessions run in the background. Inspect or stop them locally:

```sh
shell help
shell list
shell list --json
shell attach <session-id-or-prefix>
shell kill <session-id-or-prefix>
shell kill --all
```

`shell help` provides a guided start/share/attach/detach/stop flow; `shell help attach` explains local takeover and detaching in detail.

`attach` takes the existing process over in the local terminal and replays its current screen. While attached, the terminal title keeps the `Ctrl-X D to detach` reminder visible. Press `Ctrl-X`, release it, then press `D` to detach without stopping the process (`Ctrl-]` remains a legacy alternative). Local input and resulting terminal output remain visible to connected browsers.

The session closes and disappears automatically when its task exits. Use `--foreground` when you also want the process mirrored in the local terminal:

```sh
shell --foreground your-long-running-command
```

An optional deadline can close it earlier. Durations support `ms`, `s`, `m`, `h`, `d`, `w`, `mo`, and `y`; local or ISO dates are also accepted:

```sh
shell --auto-close 5m your-command
shell --auto-close "tomorrow 09:00" your-command
```

The task exiting is always the final upper bound, including when no deadline is supplied.

## Security model

The share URL is a bearer credential. Anyone who has it can see terminal output and send input with the same operating-system permissions as the wrapped process. Share links only with people you trust, avoid displaying secrets in a shared terminal, and run the process with the least privilege it needs. Use `shell kill <session-id>` if a link reaches the wrong person.

Transport is encrypted with HTTPS/WSS between each client and Cloudflare. Terminal bytes pass through the Worker and Durable Object in memory, so this is not end-to-end encryption and Cloudflare is part of the trust boundary. shell.online does not persist terminal contents server-side; the CLI keeps a bounded in-memory replay buffer while the process is alive.

The public session ID grants viewer/input access but not host access. A separate 256-bit host token authenticates the local CLI and is never placed in the share URL. Session creation and connection attempts are IP-rate-limited, WebSocket origins are checked for browsers, frames and audiences are bounded, and local control files/sockets are owner-only.

See [SECURITY.md](SECURITY.md) for supported versions and private vulnerability reporting.

## Agents and long-running processes

Installation is noninteractive and does not invoke `sudo`. Agents can request structured session output while preserving the wrapped process's stdout:

```sh
shell --json -- your-long-running-command --flag value
```

The single stderr line is a JSON object containing `share_url`, `session_id`, and `background: true`. The agent can pass that URL to its operator through its existing communication channel. The CLI reconnects after transient network failures, and Cloudflare renews the session while the process remains connected.

## Architecture

- Go CLI owns the local PTY and mirrors input/output locally.
- A Cloudflare Worker handles session creation, rate limiting, and static assets.
- One hibernatable Durable Object coordinates each terminal's host and viewers.
- The xterm.js browser renders ANSI attributes, 256-color and 24-bit color, alternate screens, mouse/input sequences, and continuously fits the PTY to the browser viewport. Terminal pages follow the system light/dark preference and include a manual switch; the cloudy landing remains light.
- Anonymous collaborator chips show who has the link open. A short renewable typing lease prevents browser keystrokes from interleaving; local attached input takes priority briefly without disconnecting remote viewers.
- A 512 KiB local ring buffer restores newly connected viewers. Terminal output is not retained by Cloudflare after the task closes.
- A relay ping/pong measures browser-to-machine round-trip latency; the UI reports `Offline` when the local CLI cannot answer.

An active process renews its lease indefinitely. A disconnected process has a 15-minute reconnect grace period. A completed process closes its sockets and deletes its Durable Object state immediately. Opening an old link shows that the session no longer exists.

## Development

Requirements: Go 1.27+ and Node.js 22+.

```sh
npm install
npm run check
npm run build:web
go test -race ./...
```

## Privacy-limited product analytics

The Worker writes a small, privacy-limited product funnel to the `shell_online_events` Cloudflare Analytics Engine dataset:

- landing and shared-terminal page views;
- installer, release binary, and agent skill downloads;
- successful copy actions;
- session creation, first host connection, first share opening, first remote input, and session end;
- coarse device (`mobile`, `tablet`, `desktop`, `cli`, or `bot`) and referrer buckets such as `hacker_news`, `github`, `direct`, and `other`.

The dataset never stores IP addresses, cookies, persistent visitor IDs, raw user agents or referrers, command labels, session IDs, terminal contents, or clipboard contents.

`installer_download` records a request for the `/install` script, not proof that installation completed. Its device and client dimensions distinguish browser opens from `curl`/`wget`; release-binary downloads and session creation are the stronger activation signals.

The same normalized events are accumulated into hourly aggregates for the private project dashboard, including:

- live connected sessions and viewers from anonymous three-minute presence leases;
- session creation, startup, sharing, collaboration, and outcome funnels;
- page views, devices, coarse referrers, and CLI versions;
- installer, agent skill, binary download, and copy activity;
- average/maximum session duration and peak audiences;
- a complete event/target aggregate ledger.

Live presence is tracked separately from historical counters, expires automatically, and uses random internal keys that are never exposed publicly.

The site uses the open-source Uncut Sans typeface by Kasper Nordkvist under the SIL Open Font License 1.1.

## Current platform support

The distributed CLI supports macOS and Linux on arm64 and amd64. Windows ConPTY support is planned but is not distributed yet.

## Contributing and license

Bug reports and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), review the [Code of Conduct](CODE_OF_CONDUCT.md), and see the [changelog](CHANGELOG.md). The source is released under the [MIT License](LICENSE); bundled component licenses are preserved in [third-party notices](THIRD_PARTY_NOTICES.md).
