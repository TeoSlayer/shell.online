# shell.online

[![CI](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml)
[![CodeQL](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-53658c.svg)](LICENSE)

shell.online is developed by [Pilot Protocol](https://pilotprotocol.network/), open-source infrastructure for connected software agents. Start with the [knowledge base](https://shell.online/docs/) for the guided product, terminal, reliability, and trust documentation.

The website documentation is rendered from [`docs/content.json`](docs/content.json), the same versioned source shipped in each Git tag. Starting with v0.6.0, the documentation version selector discovers GitHub releases and loads the selected tag's source through a cached same-origin endpoint. A release therefore preserves its exact documentation without copying prose into a separate CMS.

Turn a terminal command into an interactive or read-only browser link. The command and PTY stay on your machine; Cloudflare only relays terminal input and output while the session is active.

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
brew trust --tap teoslayer/shell-online
brew install shell-online
```

Homebrew 6 requires one-time trust for third-party taps. Tap-level trust persists across formula updates, which keeps the short install and upgrade commands working; review the repository before granting it. Older Homebrew versions that do not provide `brew trust` do not require that line. After setup, `brew install shell-online`, `brew upgrade shell-online`, and `brew uninstall shell-online` work normally. Confirm the command selected by your `PATH` with `command -v shell` and `shell --version`.

The Homebrew formula does not install a prebuilt shell.online binary. Brew downloads the checksum-pinned tagged source, installs Go as a build-only dependency when needed, runs `go build` locally, and links the resulting `shell` binary into the Homebrew prefix. Application modules are pinned by [`go.sum`](go.sum) and resolved by Go during that build; shell.online has no runtime package dependencies.

The curl installer uses the checksum-pinned release binary instead. To compile the tagged source yourself and run it without installing it globally:

```sh
git clone --depth 1 --branch v0.6.0 https://github.com/TeoSlayer/shell.online.git
cd shell.online
go build -trimpath -ldflags="-X main.version=0.6.0" -o ./shell ./cmd/shell
./shell --version
```

This path requires Go 1.27 or newer. Keep using `./shell`, or move that binary to any directory already on your `PATH`.

Every release publishes one canonical [`SHA256SUMS`](https://shell.online/downloads/SHA256SUMS) manifest and machine-readable [`release.json`](https://shell.online/downloads/release.json). The manifest covers every platform binary plus the installer, agent skill, and metadata file. The installer verifies the selected binary before installing it, prints its SHA-256 digest, and the same artifacts and manifest are attached to the corresponding GitHub release.

Agent operators can download the ready-to-install skill from `https://shell.online/skill` as `SKILL.md`.

`shell` prints the link and detaches by default. Links are interactive unless you pass `--read-only`; there are no accounts or login prompts.

When an already-running Claude Code session invokes `shell claude` through its Bash tool, the CLI detects Claude's current session ID and starts a shareable fork of that conversation under shell.online. The fork keeps the conversation history and workspace, while the original Claude process remains open; new messages after the handoff do not synchronize between them. This is a safe handoff to a new process, not a claim that macOS can retroactively move the original PID to another PTY.

## Run and manage sessions

Omit the command to share a fresh instance of your default shell:

```sh
shell
```

Create a view-only link when people should be able to monitor output but never type:

```sh
shell --read-only python train.py
```

The access mode is fixed when the session is created. Read-only input is rejected by the Worker, so changing the page or WebSocket frames cannot turn that link into an interactive one. The terminal clearly labels view-only sessions; scrolling, responsive TUI sizing, themes, zoom, and latency measurement still work.

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

## Optional end-to-end encryption

Add `--e2ee` to encrypt terminal frames on the CLI before they enter Cloudflare. The browser decrypts them locally:

```sh
shell --e2ee your-command
```

By default the CLI generates a fresh 256-bit key and appends it to the link as a `#key=...` fragment. URL fragments are used by the browser but are not included in HTTP or WebSocket requests, so Cloudflare never receives that key. Share the complete URL; removing the fragment makes the terminal unreadable.

For a separately communicated password, set it only in the process environment that starts the CLI:

```sh
SHELL_ONLINE_E2EE_PASSWORD='use-a-long-unique-password' shell --e2ee your-command
```

The URL then carries a random salt, not the password. The CLI and browser derive an AES-256-GCM key with PBKDF2-HMAC-SHA256 using 600,000 iterations. Password entry and derivation happen in the browser. shell.online cannot recover a lost random-key URL or password.

E2EE protects terminal input, output, snapshots, resize frames, and latency probes from relay inspection or undetected modification. It does not hide connection IPs, timing, encrypted frame sizes, frame opcodes, the command label, access mode, or lifecycle metadata. It also cannot stop the relay from dropping, delaying, or replaying a previously valid encrypted frame. Read-only remains independently enforced by the Worker because the authenticated frame opcode is intentionally visible for routing and policy.

See the [E2EE guide](https://shell.online/e2ee/) for the full trust boundary and recovery limits.

## Persistent Docker terminal

The published multi-architecture image is `ghcr.io/teoslayer/shell.online:0.6.0` (`linux/amd64` and `linux/arm64`). Each tagged GitHub build includes an SBOM and build provenance. It runs a shell.online client against the hosted service, preserves a stable E2EE link, host credential, browser password, and workspace across container restarts, and is not a self-hosted relay.

```sh
docker compose up --build -d
docker compose logs shell-online
```

Compose pins the release image and retains a local `build` definition so a source checkout can be tested with `--build`. To use the published image directly:

```sh
docker pull ghcr.io/teoslayer/shell.online:0.6.0
docker run -d --name shell-online --restart unless-stopped \
  -v shell-online-state:/var/lib/shell-online \
  -v shell-online-workspace:/workspace \
  ghcr.io/teoslayer/shell.online:0.6.0
docker logs shell-online
```

The first launch prints the stable share URL and an automatically generated password. Enter that password in the browser. To supply your own instead, set `SHELL_ONLINE_E2EE_PASSWORD` before starting Compose. Do not place a valuable password directly in a committed Compose file or shell history.

Two named volumes are created:

- `shell-online-state` contains the stable session ID, host credential, E2EE key material, and generated password. Anyone who can read it can control the host identity and decrypt the session.
- `shell-online-workspace` contains `/workspace`, the persistent working directory presented by the container shell.

Restarting the container reconnects the same URL. A browser already on that URL reports offline while the container is away, then resumes when it returns. An offline persistent relay identity expires after 30 days; the saved state volume can recreate that identity and URL on the next start. Deleting the state volume creates a new identity and makes the old password/link unrecoverable.

The same mechanism is available outside Docker for deliberate integrations:

```sh
SHELL_ONLINE_E2EE_PASSWORD='use-a-long-unique-password' \
  shell --foreground --e2ee --persistent ./shell-online-state.json your-command
```

The state file is written owner-only and rejected if group or other users can read it. See the [Docker guide](https://shell.online/docker/) for restart and backup behavior.

## Security model

The share URL is a bearer credential. Anyone who has an interactive link can see terminal output and send input with the same operating-system permissions as the wrapped process. A `--read-only` link can see output but its browser input is rejected server-side. In either mode, avoid displaying secrets and share the link only with intended viewers. Run interactive processes with the least privilege they need, and use `shell kill <session-id>` if a link reaches the wrong person.

Ordinary sessions use HTTPS/WSS transport encryption between each endpoint and Cloudflare. Their terminal bytes pass through the Worker and Durable Object in memory, so Cloudflare is part of their content trust boundary. Optional `--e2ee` sessions instead expose only authenticated ciphertext and the metadata listed above to Cloudflare. shell.online does not persist terminal contents server-side in either mode; the CLI keeps a bounded in-memory replay buffer while the process is alive.

The public session ID grants viewer/input access but not host access. A separate 256-bit host token authenticates the local CLI and is never placed in the share URL. Session creation and connection attempts are IP-rate-limited, WebSocket origins are checked for browsers, frames and audiences are bounded, and local control files/sockets are owner-only.

See [SECURITY.md](SECURITY.md) for supported versions and private vulnerability reporting.

## Agents and long-running processes

Installation is noninteractive and does not invoke `sudo`. Agents can request structured session output while preserving the wrapped process's stdout:

```sh
shell --json -- your-long-running-command --flag value
```

For monitoring without browser control, add `--read-only` before the command:

```sh
shell --read-only --json -- your-long-running-command --flag value
```

The single stderr line is a JSON object containing `share_url`, `session_id`, `read_only`, and `background: true`. The agent can pass that URL and its access mode to its operator through its existing communication channel. The CLI reconnects after transient network failures, and Cloudflare renews the session while the process remains connected.

## Architecture

- Go CLI owns the local PTY and mirrors input/output locally.
- A Cloudflare Worker handles session creation, rate limiting, and static assets.
- One hibernatable Durable Object coordinates each terminal's host and viewers and enforces its immutable interactive or read-only access mode.
- The xterm.js browser renders ANSI attributes, 256-color and 24-bit color, alternate screens, mouse/input sequences, and fits the real PTY—not only a CSS box—to the active browser viewport. Terminal pages follow the system light/dark preference and include a manual switch; the cloudy landing remains light.
- Anonymous collaborator chips show who has the link open. A short renewable typing lease prevents browser keystrokes from interleaving; local attached input takes priority briefly without disconnecting remote viewers.
- A 512 KiB local ring buffer restores newly connected viewers. In E2EE mode, snapshots are encrypted before leaving the CLI. Terminal output is not retained by Cloudflare after the task closes.
- A relay ping/pong measures browser-to-machine round-trip latency; the UI reports `Offline` when the local CLI cannot answer.

An active ordinary process renews its lease indefinitely. A disconnected ordinary process has a 15-minute reconnect grace period. Its completed process closes sockets and deletes Durable Object state immediately. Persistent Docker sessions are the explicit exception: the relay keeps their non-content identity for up to 30 offline days so the same state volume can reconnect the same URL. Opening an expired ordinary link shows that the session no longer exists.

## Terminal reliability guarantees

Shared terminals fail in ways that ordinary responsive pages do not. These behaviors are part of the protocol and test surface, not cosmetic promises. The matching website guides are [Mobile terminals](https://shell.online/mobile/), [Reliability](https://shell.online/reliability/), and [Security and trust](https://shell.online/security/).

| Concern | shell.online behavior |
| --- | --- |
| Mobile terminals crop, jump, or start at the wrong size | The browser tracks the visual viewport through keyboard, browser-chrome, and rotation changes, then sends actual PTY rows and columns. Mobile uses a denser default grid so TUIs expose more content. |
| Several viewers fight over terminal dimensions | Exactly one connected browser owns PTY resizing. Ownership stays stable, follows the active collaborator when appropriate, and is suspended while a local terminal is attached. Read-only viewers may observe but cannot independently resize the shared process. |
| Mobile keyboards and browser shortcuts break controls | Input uses xterm’s terminal events plus explicit paths for raw binary replies, selected-text copy, the iOS hardware-keyboard Ctrl-C anomaly, and Ctrl-W when the browser delivers it. VisualViewport sampling follows keyboard open and dismiss transitions. Browser-reserved shortcuts that the operating system never delivers cannot be overridden by a web page. |
| Selection, copy, and large paste are unreliable | Ctrl/Cmd-C copies a terminal selection instead of sending SIGINT. Paste is split into frames no larger than 16 KiB, waits for WebSocket backpressure, and has a 1 MiB pending-input ceiling. |
| Temporary network loss destroys or strands a session | The CLI-owned process and PTY keep running when the relay disappears. CLI and browser reconnect automatically; the browser requests a bounded local replay snapshot after reconnect. Relay loss never signals or kills the child process. |
| Large output breaks WebSockets or loses terminal state | PTY reads never wait on the network. Relay and rendering queues are bounded, WebSocket writes time out, and overflow marks the display stale. A fresh snapshot from the CLI’s 512 KiB ring buffer replaces stale queued output once capacity returns. |
| Permissions and lifecycle are unclear | Links are interactive by default and immutable read-only with `--read-only`. `shell list`, `shell attach`, and `shell kill` expose local lifecycle; sessions run in the background and close automatically when the task exits. |
| Users distrust relay and bearer links | The URL is explicitly a bearer capability. Ordinary sessions use HTTPS/WSS and include Cloudflare in the content trust boundary. Optional `--e2ee` keeps terminal payloads opaque to Cloudflare while still exposing traffic and lifecycle metadata. Terminal contents are not persisted server-side. |
| Sharing does not yield an immediately usable result | `shell <command>` prints the browser URL as soon as the relay session exists, then returns control to the local shell while the task continues in the background. |

Automated tests cover viewport calculations, touch-scroll translation, deterministic resize ownership, read-only input enforcement, frame limits, large-paste chunking, queue saturation, snapshot replacement, relay reconnection primitives, ANSI rendering input, session cleanup, Go/browser cryptographic compatibility, authentication-tag tampering, persistent credential permissions, and stable-session resume. Browser emulation is useful but not treated as a substitute for the iOS Safari and Android Chrome physical-device release checklist.

## Development

Requirements: Go 1.27+ and Node.js 22+.

```sh
npm install
npm run check
npm run build:web
go test -race ./...
```

Edit product documentation in [`docs/content.json`](docs/content.json) and keep its `version` equal to `package.json`. The current bundle renders it directly; after a GitHub release is published, the website can also render that immutable tagged copy at `/docs/v<version>/`.

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
