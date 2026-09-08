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

All release binaries are static, checksummed, and built in CI. Every Linux artifact also executes the full Go and PTY integration suite under QEMU. Windows uses ConPTY and supports background sessions plus `list`, `attach`, and `kill`.

| OS | Architectures | Continuous validation |
|---|---|---|
| macOS | x86-64, ARM64 | Build-verified; ARM64 manually exercised |
| Windows 10 1809+ / 11 | x86, x86-64, ARM64 | Native Windows x86-64 ConPTY and installer suite; other artifacts build-verified |
| Linux | x86, x86-64, ARMv5, ARMv6, ARMv7, ARM64, MIPS, MIPSLE, MIPS64, MIPS64LE, PPC64, PPC64LE, RISC-V 64, s390x, LoongArch64 | Full suite executed under QEMU for every artifact; x86-64 also runs natively |
| FreeBSD | x86, x86-64, ARMv7, ARM64 | Build-verified |
| OpenBSD | x86, x86-64, ARMv7, ARM64, PPC64, RISC-V 64 | Build-verified |
| NetBSD | x86, x86-64, ARMv7, ARM64 | Build-verified |
| DragonFly BSD | x86-64 | Build-verified |
| Solaris | x86-64 | Build-verified |

QEMU proves that each Linux executable starts on its target ISA and exercises networking, cryptography, persistence, local session control, PTY input/output, and resize behavior. It does not reproduce a particular router kernel, vendor firmware, or physical CPU erratum; hardware-specific reports remain valuable.

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

## Your account

Linking a machine to an account is optional. The CLI works exactly the same
without it; linking adds a list of your shares on the web.

```sh
shell login                 # opens a browser to approve this machine
shell login --no-browser    # prints the URL; open it on this same machine
shell whoami                # show the linked account
shell logout                # unlink and revoke this machine's token
```

Login uses the OAuth 2.0 authorization code flow with PKCE and a loopback
redirect (RFC 8252). The browser hands a one-time code back to a listener bound
to `127.0.0.1`, so the code never leaves the machine, and it is useless without
a verifier that is never transmitted. The CLI receives a scoped token that can
only publish sessions, and that you can revoke per machine.

You link a machine, not a terminal. `shell login` records the account once,
and every later `shell <command>` in any window publishes without further
setup. Each share is published as it starts and marked closed when the process
exits.

What is published: the share URL, the command name, the host name, and the
timing. Never the terminal contents, and never the browser password. The share
URL keeps its `#salt=` fragment so the link can be opened from the web, which
is safe because the salt is not the secret: without the eight-character
password no key can be derived from it. A `#key=` fragment, which carries a
raw key, is stripped instead.

### Driving a machine from the browser

`shell login` asks, once, whether your signed-in browser may start sessions on
this machine:

```
  Start sessions from the browser?
  Anyone signed in to you@example.com could start processes on this
  machine, as you, without touching this terminal.
  You can say no and still publish sessions with 'shell <command>'.

  Allow it? [y/N]
```

It is asked rather than assumed because it is a real capability, and only a
yes is remembered: saying no leaves the machine publish-only and the question
is put again next time you sign in.

Say yes and a small daemon runs in the background for as long as the machine
stays signed in, so it is there in the web app whether or not a terminal is
open. Any `shell` command starts it again if it is not running, which is how a
machine comes back after a reboot.

```sh
shell daemon status              # is my browser able to start sessions here?
shell daemon stop                # stop until the next shell command
shell login --no-remote-start    # withdraw it on this machine
shell logout                     # stop it and unlink the machine
```

That covers a reboot the moment you next use the tool. A machine that sits
idle and still has to be reachable can install the daemon as a user service —
a LaunchAgent on macOS, a systemd user unit on Linux:

```sh
shell service install
```

`shell agent` does the same work in the foreground, printing each session as
it starts, for anyone who would rather watch it than have it run unattended.

Commands entered in the web app use the platform's normal command language:
`sh -c` on Unix and Windows PowerShell on Windows. Quoted and escaped arguments
therefore behave the same way they do in a local terminal.

The daemon generates an ephemeral key pair each run and publishes the public
half. A browser starting a session picks the browser password itself and seals
it to that key, so the accounts service relays an envelope it cannot open, and
the browser can open the terminal without asking for a password nobody was
shown. Stopping the daemon ends the ability to open anything sealed to it.

Exactly one poller runs per machine, held by a lock the kernel releases even
if the process is killed. Two would each publish their own key while queued
work went to whichever asked first, so a session would come up on a password
the browser that started it never had.

### Running against a local stack

Every address defaults to production, so setting only some of them leaves the
rest pointed at the real service. One switch moves the whole set:

```sh
export SHELL_ONLINE_LOCAL=1     # accounts :8787, web :5173, relay :8788
```

`SHELL_ONLINE_ACCOUNTS`, `SHELL_ONLINE_WEB` and `SHELL_ONLINE_SERVER` still
override individually, and `shell login` prints which services it is using
whenever they are not the production ones.

Credentials are stored in your user config directory, readable only by you.
Set `SHELL_ONLINE_CONFIG` to move them.

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

Requires the release toolchain Go 1.26.8 and Node.js 22+. Go 1.27.x must not be used for MIPS64 release binaries because of [Go issue 80978](https://go.dev/issue/80978).

```sh
npm install
npm run check
npm run build:web
go test -race ./...
```

The Go CLI owns the local PTY. A Cloudflare Worker creates sessions and serves the site, while one Durable Object coordinates each terminal's host and viewers. The browser uses xterm.js.

### The platform app

[`app/`](app/) is the optional accounts and collaboration platform: `shell login`, organizations, and an in-app session manager. It does not gate the CLI or copy terminal input into the accounts service. It is a separate package with its own dependencies, so it is installed and tested on its own:

```sh
npm run test:app
```

It ships as one container serving the client, its API, and a proxy to the relay — they have to share an origin, because the relay refuses a websocket whose `Origin` is not its own. See [app/DEPLOYMENT.md](app/DEPLOYMENT.md).

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and the [changelog](CHANGELOG.md).

Developed by [Pilot Protocol](https://pilotprotocol.network/) and released under the [MIT License](LICENSE).
