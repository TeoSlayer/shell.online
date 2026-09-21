# shell.online

[![CI](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml)
[![CodeQL](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-53658c.svg)](LICENSE)

Share any terminal process in one command.

```sh
shell claude
```

The process stays on your machine. The CLI prints a browser link, password,
and QR code. Terminal traffic is end-to-end encrypted by default.

An agent can also observe a session through scoped MCP grants and, when explicitly enabled,
send input with host acknowledgement, human priority and duplicate protection. See
[MCP access and its decryption boundary](docs/MCP.md). Control is off by default.

## Install

| Platform | Command |
| --- | --- |
| macOS, Linux, BSD, Solaris | `curl -fsSL https://shell.online/install \| sh` |
| Windows PowerShell | `irm https://shell.online/install.ps1 \| iex` |
| Homebrew | `brew tap teoslayer/shell-online https://github.com/TeoSlayer/shell.online`<br>`brew trust --tap teoslayer/shell-online`<br>`brew install shell-online` |

Installers verify release checksums. Downloads and `SHA256SUMS` are on the
[releases page](https://github.com/TeoSlayer/shell.online/releases).

## Use

| Goal | Command |
| --- | --- |
| Share a process | `shell <command>` |
| Share a new shell | `shell` |
| Watch without typing | `shell --read-only <command>` |
| Name a session | `shell --name "web app" <command>` |
| Keep local foreground control | `shell --foreground <command>` |
| Close after a duration | `shell --auto-close 5m <command>` |
| Reuse a link across restarts | `shell --persistent <file> <command>` |
| Share working-directory files | `shell --files <command>` |
| Share another file root | `shell --files-root <dir> <command>` |

Sessions run in the background unless `--foreground` is used. They close when
the wrapped process exits.

### Manage sessions

| Goal | Command |
| --- | --- |
| List local sessions | `shell list` |
| List account sessions | `shell ls` |
| Attach locally | `shell attach <id>` |
| Show an active password | `shell password <id>` |
| Rotate a password | `shell password rotate <id>` |
| Stop a session | `shell kill <id>` |
| Link this machine | `shell auth` |
| Read session automation permissions | `shell permissions <id>` |
| Set daily-briefing consent | `shell permissions <id> --daily-briefing=true` |
| Enable your briefing default and existing own sessions | `shell briefings on --all` |
| Read your briefing default | `shell briefings status` |
| Full reference | `shell help reference` |

Press `Ctrl-X`, then `D`, to detach from `shell attach`.

Session automation permissions share one owner-controlled record between CLI and
app. Changes appear in the open app on its next refresh. The three switches are
independent: `--mcp-team-access`, `--daily-briefing`, and
`--briefing-team-access` accept explicit `true` or `false`. These switches record
consent only; a team MCP gateway and automatic idle-agent briefing generation are
not implemented in this release. A briefing default affects new sessions;
`--all` additionally updates only your existing sessions, not teammates' sessions.

### Updating running sessions

The Go host now retains terminal screen state for reconnects, rather than only a
tail of output bytes. Existing hosts keep using their original executable until
they are restarted safely. Installing an update does not restart your processes.

## Included

- Interactive desktop and mobile browser terminal
- PTY, full-screen TUI, resize, reconnect, tmux, and mosh-style redraw support
- E2EE by default; read-only shares are also enforced by the CLI
- Multi-viewer collaboration with input ownership
- QR handoff from terminal to phone
- Optional file browser with root and traversal controls
- Optional account, machine linking, personal password vault, and web app
- Refstream renderer and agent connection path *(alpha)*
- Persistent Docker session and self-hosted deployment

## Security

| Property | Behavior |
| --- | --- |
| Access | Anyone with both the URL and password can open a share |
| Encryption | The CLI encrypts; the browser decrypts locally |
| Relay visibility | Metadata, timing, encrypted frame sizes, labels, and lifecycle |
| Browser input | Runs with the wrapped process's local permissions |
| Password recovery | Local session or optional personal vault; no service backdoor |
| Plain transport mode | Explicit `--no-e2ee` only |

In v0.21.2 the browser's session-password cache is memory-only: after a reload a
session recovers from the account's encrypted vault, or requires the share
password (or host-side recovery with `shell password`). The legacy v3
localStorage blob is not wiped; it remains a read-only recovery input until a
lossless vault migration removes it.

Use `--read-only` for viewers who should not type. See the
[security model](https://shell.online/security/) and
[security policy](.github/SECURITY.md).

## Platforms

| OS | Architectures | Verification |
| --- | --- | --- |
| macOS | amd64, arm64 | Build |
| Windows | 386, amd64, arm64 | Native ConPTY on amd64; build on others |
| Linux | 386, amd64, armv5/6/7, arm64, LoongArch64, MIPS/MIPSLE/MIPS64/MIPS64LE, PPC64/PPC64LE, RISC-V 64, s390x | Runtime under QEMU |
| FreeBSD | 386, amd64, armv7, arm64 | Build |
| OpenBSD | 386, amd64, armv7, arm64, ppc64, riscv64 | Build |
| NetBSD | 386, amd64, armv7, arm64 | Build |
| DragonFly BSD | amd64 | Build |
| Solaris | amd64 | Build |

[Platform details](https://shell.online/platforms/) cover PTYs, routers, ROS,
installers, and test caveats.

## Documentation

| Start | Operate | Understand |
| --- | --- | --- |
| [Quick start](https://shell.online/docs/) | [Web app](https://shell.online/app/) | [Security](https://shell.online/security/) |
| [CLI reference](https://shell.online/cli/) | [Mobile](https://shell.online/mobile/) | [E2EE](https://shell.online/e2ee/) |
| [Containers](https://shell.online/docker/) | [Reliability](https://shell.online/reliability/) | [Refstream alpha](https://shell.online/refstream/) |
| [Self-hosting](https://shell.online/self-hosting/) | [Platforms](https://shell.online/platforms/) | [Contributing](.github/CONTRIBUTING.md) |

## Development

Requires Go 1.26.8, Node.js 22, and npm.

```sh
npm ci
npm run check
go test -race ./...
npm run test:app
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=TeoSlayer/shell.online&type=Date)](https://www.star-history.com/#TeoSlayer/shell.online&Date)

## Contributors

[![shell.online contributors](https://contrib.rocks/image?repo=TeoSlayer/shell.online)](https://github.com/TeoSlayer/shell.online/graphs/contributors)

[TeoSlayer](https://github.com/TeoSlayer) ·
[teovl](https://github.com/teovl) ·
[Alexgodoroja](https://github.com/Alexgodoroja) ·
[pstayets](https://github.com/pstayets) ·
[monperrus](https://github.com/monperrus) ·
[artemiia](https://github.com/artemiia)

MIT licensed. Developed by [Pilot Protocol](https://pilotprotocol.network/).
