# shell.online

**Leave your desk. Keep your terminal moving.**

Start an agent or terminal command on your computer. Open the same session on
your phone, tablet, or another computer. Watch its output, reply to prompts,
or invite a teammate. Free, open source, and no account needed to try it.

[Get started](#get-started) · [Read the docs](https://shell.online/docs/) ·
[Open the app](https://app.shell.online/) · [Latest release](https://github.com/TeoSlayer/shell.online/releases/latest)

[![CI](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-53658c.svg)](LICENSE)

## Get started

### 1. Install on the computer doing the work

**macOS, Linux, BSD or Solaris** — run in a terminal:

```sh
curl -fsSL https://shell.online/install | sh
```

**Windows** — run in PowerShell:

```powershell
irm https://shell.online/install.ps1 | iex
```

The installers check release checksums. Prefer another method?
[Use Homebrew](https://shell.online/platforms/) or [build from source](#build-from-source).

### 2. Start your agent—or any terminal command

Choose one agent you already have installed:

| Agent | Command |
| --- | --- |
| Claude Code | `shell claude` |
| Codex | `shell codex` |
| OpenCode | `shell opencode` |
| Muse | `shell muse` |

Other terminal programs work too: `shell -- npm run dev`,
`shell -- python script.py`, or just `shell` for a fresh shell.

This starts a new process. It does not attach to a process that is already
running. If your agent has a resume command, you can start that through `shell`.

### 3. Open the link anywhere

Your terminal prints a link, password and QR code. Scan the QR code or open the
link in a browser. **Keep the host computer awake and online.** Closing the
browser does not stop the process; the session ends when its process exits.

<details>
<summary>See a real session on a phone</summary>

<img src="https://shell.online/screenshots/codex-working-mobile.png" width="280" alt="An actual Codex session shown in the shell.online mobile terminal" />

This is terminal output from the host computer, not a second copy of the agent.

</details>

## What you can do

| You want to… | Start here |
| --- | --- |
| Check progress and reply away from your desk | [Use your phone](https://shell.online/mobile/) |
| Let someone watch without typing | `shell --read-only <command>` |
| Work together in the same terminal | Share the link and password with an intended teammate |
| Find sessions across your machines | `shell auth`, then follow the [optional app guide](https://shell.online/app/) |
| Let another agent inspect or control a session | [Create a scoped MCP grant](https://shell.online/agents/) |
| Keep files and reuse a Docker session link | [Docker workspace guide](https://shell.online/docker/) |
| Run the relay on your own server | [Self-hosting guide](docs/self-hosting.md) |

## Everyday commands

| Command | What it does |
| --- | --- |
| `shell list` | Find sessions on this machine |
| `shell attach <ID>` | Join an existing local session; Ctrl-X, then D detaches |
| `shell kill -- <ID>` | Stop that one session |
| `shell --name "Review" codex` | Give a new session a useful name |
| `shell --foreground claude` | Keep local terminal interaction while sharing |
| `shell password <ID>` | Reveal one active session's password locally |
| `shell password rotate <ID>` | Change browser access and revoke MCP grants |
| `shell help` | See built-in help |

[Full command reference](https://shell.online/cli/) ·
[Connection troubleshooting](https://shell.online/reliability/) ·
[Alternative renderer (Refstream alpha)](https://shell.online/refstream/)

## Know what you are sharing

- **The process stays on your computer.** This is terminal sharing, not remote desktop or a cloud machine. A sleeping or offline host cannot be controlled.
- **The link and password are access credentials.** An interactive share lets its holder type with the process's permissions. Use `--read-only` when viewing is enough; keep QR codes private too.
- **Terminal traffic is end-to-end encrypted by default.** Only an explicit `--no-e2ee` disables this protection. Native MCP grants authorize server-side decryption for the authorized MCP client. A browser password is not an MCP bearer.
- **File access is off by default.** `--files` or `--files-root` deliberately exposes a selected directory.
- **A saved link is not a saved process.** Persistence can reuse credentials and files; it cannot restore process memory.

[Security model](https://shell.online/security/) · [Encryption details](https://shell.online/e2ee/) ·
[Report a vulnerability privately](.github/SECURITY.md)

## Install or build the version you mean to use

The latest published CLI release is **v0.23.1**. `main` also contains newer app
and integration work; a merged change is not proof that every hosted component
or running CLI host has been updated. Check the [changelog](CHANGELOG.md) and
[release notes](https://github.com/TeoSlayer/shell.online/releases).

Run `shell --version` to inspect your installed binary. Installing an update
does **not** restart existing sessions. Save active work before restarting a host.

Supported hosts include macOS, Windows, Linux, FreeBSD, OpenBSD, NetBSD,
DragonFly BSD and Solaris. Phones need only a browser.
[See architectures and runtime-test coverage](https://shell.online/platforms/).

### Build from source

Install **Git and Go 1.26.8**. Node.js is not needed to build the CLI or use the hosted relay.

```sh
git clone --depth 1 --branch v0.23.1 https://github.com/TeoSlayer/shell.online.git
cd shell.online
go build -buildvcs=false -trimpath -ldflags="-X main.version=0.23.1" -o shell ./cmd/shell
./shell --version
```

In Windows PowerShell, use `-o shell.exe` and `.\shell.exe --version` instead.
Run `./shell codex` (Windows: `.\shell.exe codex`) from this directory, or put
the binary in a directory on your PATH. These commands build the tagged release,
not whatever happens to be on `main`.

## Find your way around

| Area | What is there |
| --- | --- |
| [`cmd/shell`](cmd/shell), [`internal`](internal) | Go CLI, PTY host, encryption and account client |
| [`worker`](worker), [`shared`](shared) | Hosted relay, MCP, protocol and shared logic |
| [`web`](web), [`docs/content.json`](docs/content.json) | Public website, terminal viewer and versioned guides |
| [`app`](app/README.md) | Optional accounts app, API, database and game |
| [`standalone`](standalone), [`docker-compose.yml`](docker-compose.yml) | Self-hosted relay and persistent Docker client—different deployments |
| [`docs`](docs/README.md) | User guides and deeper operator references |

Want to contribute? [Pick the checks for your change](.github/CONTRIBUTING.md).
Please keep real terminal output, share links, passwords and tokens out of issues and PRs.

## Support the project

If shell.online makes your day easier, [give it a star](https://github.com/TeoSlayer/shell.online/stargazers)
or [tell us what needs improving](https://github.com/TeoSlayer/shell.online/issues/new/choose).
Thanks to [everyone who has contributed](https://github.com/TeoSlayer/shell.online/graphs/contributors).

MIT licensed. Developed by [Pilot Protocol](https://pilotprotocol.network/).
