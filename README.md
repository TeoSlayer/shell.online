# shell.online

[![CI](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml)
[![CodeQL](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-53658c.svg)](LICENSE)

A browser link to any terminal process.

Run one command, get a URL and password, and open the same terminal from a phone or desktop. No SSH, VPN, account, or configuration. The process and PTY stay on your machine; terminal traffic is end-to-end encrypted by default.

Features:

- Share a shell, coding agent, build, server, training job, or TUI.
- View and type from any modern browser, with mobile terminal controls.
- Collaborate without interleaved input; local attach still works.
- Create immutable read-only links for monitoring.
- Reconnect without killing or restarting the local process.
- Close automatically when the wrapped process exits.
- Run in the background by default and manage sessions locally.

## Install

macOS, Linux, and BSD/Solaris:

```sh
curl -fsSL https://shell.online/install | sh
```

Windows PowerShell:

```powershell
irm https://shell.online/install.ps1 | iex
```

The installer verifies the release checksum and prints PATH instructions when needed. Published binaries and [`SHA256SUMS`](https://shell.online/downloads/SHA256SUMS) are also attached to every [GitHub release](https://github.com/TeoSlayer/shell.online/releases).

With Homebrew:

```sh
brew tap teoslayer/shell-online https://github.com/TeoSlayer/shell.online
brew trust --tap teoslayer/shell-online
brew install shell-online
```

Homebrew versions before 6 do not need the `brew trust` line.

## Supported platforms

All release binaries are static, checksummed, and built in CI. Windows uses ConPTY and supports background sessions plus `list`, `attach`, and `kill`.

| OS | Architectures |
|---|---|
| macOS | x86-64, ARM64 |
| Windows 10 1809+ / 11 | x86, x86-64, ARM64 |
| Linux | x86, x86-64, ARMv5, ARMv6, ARMv7, ARM64, MIPS, MIPSLE, MIPS64, MIPS64LE, PPC64, PPC64LE, RISC-V 64, s390x, LoongArch64 |
| FreeBSD | x86, x86-64, ARMv7, ARM64 |
| OpenBSD | x86, x86-64, ARMv7, ARM64, PPC64, RISC-V 64 |
| NetBSD | x86, x86-64, ARMv7, ARM64 |
| DragonFly BSD | x86-64 |
| Solaris | x86-64 |

That includes common OpenWrt and Ubiquiti-style Linux devices; choose the artifact matching `uname -m`. ROS 1/ROS 2 commands need no adapter—after sourcing the ROS environment, wrap `roscore`, `roslaunch`, `ros2 run`, or `ros2 launch` normally. See the [platform guide](https://shell.online/platforms/).

## Use

```sh
shell claude
shell codex
shell python train.py
shell npm run dev
shell ros2 launch <package> <launch-file>
shell
```

`shell` prints a link and an eight-character browser password, then leaves the process running in the background. Send both to the person opening the terminal.

Useful commands:

```sh
shell --read-only python train.py  # viewers cannot type
shell list                         # show local sessions
shell attach <session-id>          # take over locally
shell kill <session-id>            # stop a session and its process
shell --foreground <command>       # mirror it in this terminal
shell --auto-close 5m <command>    # add an earlier deadline
shell --no-e2ee <command>          # transport encryption only
shell --persistent <state-file> <command> # reuse the same URL and password after restart
```

While attached, press `Ctrl-X`, release it, then press `D` to detach without stopping the process. Run `shell help` for a guided overview or `shell help reference` for the complete reference.

## How access works

The URL and password together are a bearer credential. Anyone with both can see the terminal and, unless the share is read-only, type with the permissions of the wrapped process. Share them only with intended viewers.

E2EE is automatic: the CLI encrypts terminal frames before Cloudflare relays them, and the browser decrypts them locally. Cloudflare still sees connection and lifecycle metadata, but not terminal input or output. `--no-e2ee` deliberately makes terminal content visible to the relay while retaining HTTPS/WSS transport encryption.

Read the [security model](https://shell.online/security/), [E2EE guide](https://shell.online/e2ee/), or [private vulnerability policy](SECURITY.md) before sharing sensitive work.

## Agents

Agents can create a share without interactive setup and return structured details to their operator:

```sh
shell --json -- <command> <args...>
```

An installable agent skill is available at [`https://shell.online/skill`](https://shell.online/skill).

## Persistent Docker terminal

The Docker client preserves the same encrypted link, password, and workspace across container restarts:

```sh
docker compose up -d
docker compose logs shell-online
```

It connects to the hosted shell.online relay; it is not a self-hosted server. See the [Docker guide](https://shell.online/docker/) for volumes, backups, password rotation, and the published GHCR image.

Native shares also run in the background. Re-run `shell --persistent <state-file> <command>` with the same owner-only state file to restore the same URL and password after a process or machine restart; `shell kill` still stops the current task. Use Docker's restart policy when automatic restart after boot is required.

## Documentation

- [Quick start and guides](https://shell.online/docs/)
- [CLI reference](https://shell.online/cli/)
- [Mobile terminals](https://shell.online/mobile/)
- [Reliability](https://shell.online/reliability/)
- [Security](https://shell.online/security/)
- [End-to-end encryption](https://shell.online/e2ee/)
- [Docker](https://shell.online/docker/)
- [Platforms, routers, Windows, and ROS](https://shell.online/platforms/)

The website documentation is generated from [`docs/content.json`](docs/content.json) and versioned with each release.

## Development

Requires Go 1.27+ and Node.js 22+.

```sh
npm install
npm run check
npm run build:web
go test -race ./...
```

The Go CLI owns the local PTY. A Cloudflare Worker creates sessions and serves the site, while one Durable Object coordinates each terminal's host and viewers. The browser uses xterm.js.

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and the [changelog](CHANGELOG.md).

Developed by [Pilot Protocol](https://pilotprotocol.network/) and released under the [MIT License](LICENSE).
