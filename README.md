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

Homebrew:

```sh
brew install TeoSlayer/shell-online/shell-online
```

Installers verify checksums. Release binaries and `SHA256SUMS` are available on
the [releases page](https://github.com/TeoSlayer/shell.online/releases).

## Usage

```sh
shell <command>                           # share a command
shell                                     # share a new shell
shell --read-only <command>               # disable browser input
shell --foreground <command>              # also show it locally
shell --auto-close 5m <command>           # set an earlier deadline
shell --persistent <file> <command>       # reuse a URL and password

shell list                                # list local sessions
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
[`SECURITY.md`](SECURITY.md).

## Accounts and containers

Accounts are optional. `shell login` groups sessions from linked machines in
[app.shell.online](https://app.shell.online/). The CLI works without one.

The published container keeps one encrypted shell, URL, and password across
restarts:

```sh
docker compose up -d
docker compose logs shell-online
```

## Documentation

- [Quick start](https://shell.online/docs/)
- [CLI reference](https://shell.online/cli/)
- [Mobile behavior](https://shell.online/mobile/)
- [Reliability](https://shell.online/reliability/)
- [End-to-end encryption](https://shell.online/e2ee/)
- [Containers](https://shell.online/docker/)
- [Platforms](https://shell.online/platforms/)
- [Self-hosting](SELF-HOSTING.md)

## Development

Requires Go 1.26.8, Node.js 22, and npm.

```sh
npm ci
npm run check
go test -race ./...
npm run test:app
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

MIT licensed. See [`LICENSE`](LICENSE).

Developed by [Pilot Protocol](https://pilotprotocol.network/).
