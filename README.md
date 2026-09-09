# shell.online

[![CI](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml)
[![CodeQL](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-53658c.svg)](LICENSE)

**A browser link to any terminal process.**

Run one command, get a URL, password, and QR code, then use the same terminal from a phone or desktop. No SSH, VPN, account, or configuration. The process stays on your machine and terminal traffic is end-to-end encrypted by default.

```sh
shell claude
shell codex
shell python train.py
shell npm run dev
shell
```

- Interactive or server-enforced read-only links
- Real terminal rendering and mobile controls
- Multiple viewers with coordinated input
- Automatic reconnect without restarting the process
- Background sessions with local attach, list, and kill
- Persistent links for containers and long-lived machines

## Install

macOS, Linux, BSD, and Solaris:

```sh
curl -fsSL https://shell.online/install | sh
```

Windows PowerShell:

```powershell
irm https://shell.online/install.ps1 | iex
```

Homebrew:

```sh
brew tap teoslayer/shell-online https://github.com/TeoSlayer/shell.online
brew trust --tap teoslayer/shell-online # Homebrew 6+
brew install shell-online
```

Installers verify release checksums and print PATH instructions when needed. Binaries and the canonical [`SHA256SUMS`](https://shell.online/downloads/SHA256SUMS) are attached to every [release](https://github.com/TeoSlayer/shell.online/releases).

## Use

```sh
shell <command>                              # share in the background
shell --read-only <command>                  # viewers cannot type
shell --foreground <command>                 # also mirror locally
shell --auto-close 5m <command>              # add an earlier deadline
shell --persistent <state-file> <command>    # keep URL and password
shell list                                   # list local shares
shell attach <session-id>                    # take over locally
shell kill <session-id>                      # stop process and share
```

While attached, press `Ctrl-X`, release it, then press `D` to detach without stopping the process. Run `shell help` for a guided overview or `shell help reference` for the complete CLI reference.

The URL and password together grant access. Anyone with both can view the terminal and, unless the link is read-only, type with the wrapped process's permissions.

## How it works

1. The Go CLI owns the PTY and process on your machine.
2. Terminal frames are encrypted locally before Cloudflare relays them.
3. The browser decrypts and renders the terminal with xterm.js.

Cloudflare can see connection and lifecycle metadata, but not encrypted terminal input or output. Terminal contents are not persisted server-side. `--no-e2ee` is an explicit compatibility mode that retains HTTPS/WSS but allows the relay to see terminal content.

Read the [security model](https://shell.online/security/), [E2EE guide](https://shell.online/e2ee/), and [vulnerability policy](SECURITY.md) before sharing sensitive work.

## Supported platforms

Release binaries are static and checksummed. Every Linux target executes the complete Go and PTY test suite under QEMU; Windows uses native ConPTY.

| OS | Architectures |
|---|---|
| macOS | x86-64, ARM64 |
| Windows 10 1809+ / 11 | x86, x86-64, ARM64 |
| Linux | x86, x86-64, ARMv5/6/7, ARM64, MIPS/LE/64/64LE, PPC64/LE, RISC-V 64, s390x, LoongArch64 |
| FreeBSD | x86, x86-64, ARMv7, ARM64 |
| OpenBSD | x86, x86-64, ARMv7, ARM64, PPC64, RISC-V 64 |
| NetBSD | x86, x86-64, ARMv7, ARM64 |
| DragonFly BSD | x86-64 |
| Solaris | x86-64 |

This includes many OpenWrt, Ubiquiti, Raspberry Pi, and ROS environments. Match the artifact to `uname -m`; see the [platform guide](https://shell.online/platforms/) for validation details and limitations.

## Optional account

The CLI needs no account. Linking a machine simply gathers its shares in [app.shell.online](https://app.shell.online/) and can optionally let your signed-in browser start a session on that machine.

```sh
shell login
shell whoami
shell logout
```

The accounts service receives session metadata, never terminal contents or browser passwords. `shell login` asks before enabling remote start; use `shell login --no-remote-start` to withdraw it.

## Agents and Docker

Agents can create a share and return structured credentials to their operator:

```sh
shell --json -- <command> <args...>
```

An installable agent skill is available at [shell.online/skill](https://shell.online/skill).

For a terminal that keeps the same encrypted link, password, state, and workspace across container restarts:

```sh
docker compose up -d
docker compose logs shell-online
```

The container is a persistent client of the hosted service. See the [Docker guide](https://shell.online/docker/) for volumes, backups, and password rotation.

## Documentation

- [Quick start and guides](https://shell.online/docs/)
- [CLI reference](https://shell.online/cli/)
- [Mobile terminals](https://shell.online/mobile/)
- [Reliability](https://shell.online/reliability/)
- [Security and E2EE](https://shell.online/security/)
- [Platforms](https://shell.online/platforms/)

Documentation is generated from [`docs/content.json`](docs/content.json) and versioned with every release.

## Development

Requires Go 1.26.8 and Node.js 22+.

```sh
npm install
npm run check
npm run build:web
go test -race ./...
npm run test:app
```

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and the [changelog](CHANGELOG.md).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=TeoSlayer/shell.online&type=Date)](https://www.star-history.com/#TeoSlayer/shell.online&Date)

Developed by [Pilot Protocol](https://pilotprotocol.network/) and released under the [MIT License](LICENSE).
