# shell.online

[![CI](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/ci.yml)
[![CodeQL](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml/badge.svg)](https://github.com/TeoSlayer/shell.online/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-53658c.svg)](LICENSE)

A browser link to any terminal process.

```sh
shell claude
```

The command keeps running on your machine. shell.online prints a URL, password,
and QR code that open the same terminal in a desktop or mobile browser. Terminal
traffic is end-to-end encrypted by default.

## Install

macOS, Linux, BSD, and Solaris:

```sh
curl -fsSL https://shell.online/install | sh
```

Windows PowerShell:

```powershell
irm https://shell.online/install.ps1 | iex
```

Homebrew (the tap lives in this repository):

```sh
brew tap teoslayer/shell-online https://github.com/TeoSlayer/shell.online
brew trust --tap teoslayer/shell-online
brew install shell-online
```

Homebrew 6 asks you to trust a third-party tap once. Older versions have no
`brew trust` and can skip that line.

Installers verify checksums. Release binaries and `SHA256SUMS` are available on
the [releases page](https://github.com/TeoSlayer/shell.online/releases).

## Platform compatibility

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

See [platform details](https://shell.online/platforms/) for PTY, router, ROS,
installer, and test caveats.

## Usage

```sh
shell <command>                           # share a command
shell                                     # share a new shell
shell --read-only <command>               # disable browser input
shell --foreground <command>              # also show it locally
shell --auto-close 5m <command>           # set an earlier deadline
shell --persistent <file> <command>       # reuse a URL and password

shell list                                # list local sessions (adapts to terminal width)
shell password <id>                       # retrieve an active password locally
shell password rotate <id>                # revoke it without restarting the process
shell attach <id>                         # attach locally
shell kill <id>                           # stop a session
```

Press `Ctrl-X`, then `D`, to detach from an attached session. See
[`shell help reference`](https://shell.online/cli/) for every command and option.

## Security

The CLI owns the PTY and encrypts terminal frames before sending them to the
relay. The browser decrypts them locally. The relay still sees connection
metadata, encrypted frame sizes, timing, labels, and session lifecycle events.
Use `--no-e2ee` only when transport encryption without payload E2EE is required.

Anyone with both the URL and password can open a share. Interactive shares can
type with the permissions of the wrapped process; use `--read-only` when viewers
should only watch. See the [security model](https://shell.online/security/) and
[the security policy](.github/SECURITY.md).

The CLI always prints the generated password and retains it while the local
session is active. After `shell login`, it also saves an encrypted copy when
that account has enabled its optional personal vault. A vault belongs to one
person, not the team, and unlocks with its password or a supported passkey;
the recovery key is the break-glass fallback. Without an owner-held copy there
is intentionally no service-side recovery backdoor.

## Accounts and containers

Accounts are optional. `shell login` groups sessions from linked machines in
[app.shell.online](https://app.shell.online/). The vault is separately optional,
and the CLI reports whether each password was saved there.

The published container keeps one encrypted shell, URL, and password across
restarts:

```sh
docker compose up -d
docker compose logs shell-online
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=TeoSlayer/shell.online&type=Date)](https://www.star-history.com/#TeoSlayer/shell.online&Date)

## Documentation

- [Quick start](https://shell.online/docs/)
- [CLI reference](https://shell.online/cli/)
- [Mobile behavior](https://shell.online/mobile/)
- [Reliability](https://shell.online/reliability/)
- [End-to-end encryption](https://shell.online/e2ee/)
- [Containers](https://shell.online/docker/)
- [Platforms](https://shell.online/platforms/)
- [Self-hosting](https://shell.online/self-hosting/) — Docker or Cloudflare

## Development

Requires Go 1.26.8, Node.js 22, and npm.

```sh
npm ci
npm run check
go test -race ./...
npm run test:app
```

See [the contribution guide](.github/CONTRIBUTING.md) before opening a pull request.

## Contributors

[![shell.online contributors](https://contrib.rocks/image?repo=TeoSlayer/shell.online)](https://github.com/TeoSlayer/shell.online/graphs/contributors)

MIT licensed. See [`LICENSE`](LICENSE).

Developed by [Pilot Protocol](https://pilotprotocol.network/).
