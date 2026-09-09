# Changelog

All notable user-visible changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Keep the open session tabs across a reload. Refreshing the page put you back at the list with every terminal closed; the tabs that were open come back, on the one that was in front. Only the session ids are remembered, so a restored tab is rebuilt from the session list rather than from a stale copy, and a session that has since ended does not return.
- Offer GPT Codex's sandbox, approval, resume and web-search options in the new-session form, and Hermes Agent's command, session, model, worktree and approval options, each read from the installed tool rather than from its documentation.

### Fixed

- Draw a shared terminal at the size of the pane holding it. The font was scaled until the whole grid fitted in one direction, which on a wide pane left about a third of it empty and the text a third smaller than there was room for. The font now comes from the width, where the columns are, and the rows are spread down the full height with the leading that is left over; neither axis may overflow. On a 1440x900 window a 120x36 session goes from 11.5px filling 77% of the pane to 14.75px filling 98%.
- Remove the box drawn around each column of the session board. It repeated the border and the wash that every card inside it already carries, so three short columns read as three mostly empty containers.
- Stop building `codex --full-auto`, which current Codex releases reject as an unexpected argument. Starting a full-auto Codex session from the browser failed on the machine it was sent to.
- Drop the warning that a kind's flags came from a published interface. Every kind now offers only options its own `--help` accepts, so there is nothing left for it to warn about.

## [0.11.1] — 2026-09-08

### Added

- Read the session list as a board as well as a table. A toggle above the list switches between them and the choice is remembered; the board's three columns carry the action each one affords, and a search box matches a session's name or its command.
- Copy a session's link, its password, and its attach command from one menu, each with the warning that belongs to it.
- Remove a finished session from the list. The row, not the machine.

### Fixed

- Give a session started from the browser the icon of the program it is running. The command was handed to `sh -c`, so what the machine recorded was the shell; a command that has an argv is now run as one, and sessions already recorded are read correctly.
- Stop a session whose machine has re-linked since it started, instead of reporting that there is no such machine, and close the session when the stop completes so the list agrees with the machine.
- Stop rebuilding the terminal on every poll, which made a shared session slow to type into.
- Fail a build whose configuration is absent rather than only one whose configuration is empty. An absent variable produced a blank page in the browser with nothing in the console.

## [0.11.0] — 2026-09-08

### Added

- Ask on every interactive `shell login` whether the browser may start sessions here, with the previous answer as the default. `--allow-remote-start` remains a shortcut rather than the only way to reach the decision.
- Show the audit log again: the page, its route and the sidebar entry.
- Publish Go module discovery metadata so `go install shell.online/cmd/shell@latest` resolves from the canonical domain.

### Fixed

- Rescue a machine whose daemon can no longer renew its token. Signing in again replaces the running daemon instead of leaving it holding credentials it will never reload, a refused renewal re-reads the credentials file, and repeated refusals back off rather than repeating every two seconds.
- Read who may type from the session rather than from the tab it was opened in, so a colleague handed a session while watching it can type without reopening.
- Stop one test closing another test's file descriptor, which failed unrelated tests at random.
- Keep the background startup pipe private to shell.online so wrapped commands can safely use file descriptor 3.
- Make foreground relay connection attempts interruptible and print share details only after the relay is connected.
- Honor long `--auto-close` deadlines instead of silently reducing them to the relay's rolling 12-hour lease.
- Refuse a second local owner for an already-running persistent session without replacing its control socket or record.
- Preserve authenticated E2EE recovery snapshot opcodes during relay backpressure so large output cannot eject viewers to the password screen.
- Show compact, unclipped encryption badges in narrow mobile headers.
- Explain when all 16 viewer slots are occupied and keep retrying until a slot opens.
## [0.10.1] — 2026-09-08

### Fixed

- Render terminal QR codes with one color transition per row instead of one per module, eliminating visible repaint noise and reducing their ANSI payload by roughly an order of magnitude.
- Give every mobile terminal navigation key a full 44-pixel touch target with more legible labels.

## [0.10.0] — 2026-09-08

### Added

- Render a compact one-scan QR in interactive terminals after creating an encrypted share. The QR carries the URL and password entirely in its fragment, so it unlocks locally without exposing the password to Cloudflare; JSON, pipes, and non-interactive output remain unchanged.
- Add LLM-assisted issue intake, pull-request diff review, changelog suggestions, and generated GitHub release notes.
- Automatically delete unmistakably unrelated or spam issues and close equivalent pull requests only when two independent reviews agree at 98% confidence; preserve technical criticism and relevant but flawed contributions.
- Use GitHub's current Copilot inference path rather than the retired GitHub Models endpoint.

### Fixed

- Route every accounts-app asset response through its Worker security-header wrapper.
- Treat exhausted Copilot review quota as advisory instead of failing otherwise valid pull requests.
- Draw a terminal opened in the web app at the size the process is actually running at. The pane sized the emulator to its own pixels instead, so a 120-column session was drawn at around 110 columns and 24 of its 36 rows: every long line wrapped a second time and the bottom third of anything full-screen was missing. It now scales the type to fit the session's grid, the way the standalone viewer already did, and follows that grid when a phone joins or leaves the session.

## [0.9.0] — 2026-09-08

### Added

- Add `shell login`, which links a machine to an account from the terminal and returns to the web app. Sessions started with `shell` then appear there on their own.
- Add organizations. Signing up creates one; an invite link joins one. Everyone in an organization sees every member's sessions, each of which has an owner and an assignee.
- Add a web app that lists sessions from every linked machine and opens them as tabs you can type into, rather than as links out.
- Let a signed-in browser start and stop sessions on a linked machine, after that machine agrees to it once at `shell login`. The browser chooses the session password and seals it to a key the machine publishes, so the service relays an envelope it cannot open.
- Add session ownership, handoff history, comments, mentions, and notifications without copying terminal input into the accounts service.
- Detect which coding-agent harnesses a machine can run, so the web app offers the ones that are actually there.
- Add terms of service, accepted at sign-up.

### Fixed

- Scope remote-start consent to one account and accounts service, stop a stale
  daemon when that identity changes, and make single-use invite claims atomic.
- Remember which linked machine owns each session so Stop always targets that
  machine, and preserve quoting in browser-started commands through the native
  platform shell.
- Restrict CLI OAuth callbacks to literal IPv4 or IPv6 loopback addresses, so
  a local name-resolution override cannot receive an authorization code.
- Keep production infrastructure identifiers out of tracked Wrangler config,
  verify the pinned Cloud SQL proxy before execution, and compile the web app
  against the public relay rather than a development address.
- Point `shell login` at the deployment that serves it. The accounts address had never resolved, and the approval screen resolved to the marketing site, so either would have failed on the first release carrying the command.
- Update `golang.org/x/crypto` to a patched release. The Windows binaries linked its SSH package, reached through the PTY library, and so carried thirteen advisories including seven rated critical. No shell.online code path called into it, and the other platforms never linked it at all.

## [0.8.1] — 2026-09-04

### Fixed

- Build with Go 1.26.8 to avoid Go 1.27's MIPS64 `epoll` alignment regression, which could crash networked programs with `SIGBUS`.

### Added

- Execute the complete Go test suite under QEMU for all 15 Linux release artifacts, covering x86, ARM, MIPS, PowerPC, RISC-V, s390x, and LoongArch.
- Exercise real PTY creation, input, output, and terminal resizing in every emulated architecture family.
- Require the QEMU manifest to cover every Linux target in the authoritative release manifest.

## [0.8.0] — 2026-09-04

### Added

- Add native Windows ConPTY execution, detached background startup, owner-restricted local control, PowerShell installation, and working `list`, `attach`, and `kill` commands on x86, x64, and ARM64.
- Publish 36 checksummed binaries across macOS, Windows, Linux, FreeBSD, OpenBSD, NetBSD, DragonFly BSD, and Solaris, including ARMv5/6/7, big- and little-endian MIPS, PowerPC, RISC-V, s390x, and LoongArch targets for routers and small devices.
- Document ROS 1/ROS 2 usage and the complete supported-platform matrix in the README, versioned web knowledge base, install scripts, agent material, and built-in CLI help.

### Changed

- Make `--persistent <state-file>` portable to Windows so a background process can recover the same encrypted URL and password after a restart; the Docker restart policy continues to provide automatic recovery.
- Generate and verify every release artifact from one authoritative target manifest, and include Windows installer integrity metadata in the canonical SHA-256 bundle.

## [0.7.3] — 2026-09-02

### Fixed

- Suppress dead share URLs and impossible attach/kill instructions when a wrapped task exits during the startup handshake; report its real exit status instead.
- Parse spaced and unquoted multi-token `--auto-close` values deterministically, and return status 2 for missing or invalid values instead of executing them as commands.
- Require a deliberate second browser `Ctrl-D` within three seconds before sending an authenticated EOF frame; read-only sessions reject it.
- Make terminal sizing phone-aware and session-wide: 120×36 with desktop viewers, 80×24 while any phone is connected, with each transition ordered ahead of viewer input so typing handoff cannot resize one command late.

## [0.7.2] — 2026-09-02

- Match xterm's unused viewport area to the active terminal theme, removing the separate black rectangle beneath a fitted 80×24 screen on mobile.

## [0.7.1] — 2026-09-02

- Keep every shared process on one immutable 80×24 PTY grid so desktop, mobile, read-only, and local viewers cannot resize or deform one another's TUI.
- Fit that canonical grid independently in every browser, preserving personal zoom and mobile keyboard handling without changing the process dimensions.

## [0.7.0] — 2026-09-02

### Changed

- Make E2EE automatic for every new CLI share, with a cryptographically random eight-character browser password when `SHELL_ONLINE_E2EE_PASSWORD` is not set.
- Add an explicit `--no-e2ee` compatibility/debugging opt-out, label its Cloudflare plaintext trust boundary in CLI output, and reject conflicting password or persistence options.
- Include `e2ee_password` in structured session events so agents can give operators everything needed to open a share; keep `--e2ee` as a redundant compatibility flag.
- Refresh human CLI output with an animated connection state and a compact colored session card while keeping JSON and non-TTY output deterministic.
- Persist generated and configured browser passwords for stable CLI and Docker sessions, reuse them across restarts, and refuse mismatched replacement passwords rather than silently breaking an existing URL.

### Security

- Use password-derived AES-256-GCM keys for all new shares while continuing to expose the documented routing and traffic metadata to Cloudflare.
- Document the generated password's 48-bit entropy, recommend longer unique passwords for sensitive or long-lived work, and treat persistent state volumes as browser-password, host-credential, and decryption secrets.

## [0.6.2] — 2026-08-31

### Added

- Add a complete built-in CLI reference through `shell help reference`, covering commands, flags, environment variables, structured output, relay states, auto-close grammar, aliases, and exit status.
- Add the same full reference as a first-class, searchable, versioned documentation page rendered from the repository source.

## [0.6.1] — 2026-08-31

### Fixed

- Make `shell list` independently check each public relay session instead of equating a living local process with a working share link.
- Report relay state as online, reconnecting, expired, or temporarily unknown in the table and expose the raw `relay_status` in JSON without sending E2EE URL fragments.

## [0.6.0] — 2026-08-31

### Added

- Add optional `--e2ee` terminal-frame encryption with locally generated URL-fragment keys or separately shared passwords derived on each endpoint.
- Add a persistent multi-architecture GHCR Docker client with durable state and workspace volumes, an automatically generated browser password, one stable share URL across restarts, an SBOM, and build provenance.
- Add dedicated E2EE and Docker knowledge-base guides, cryptographic compatibility vectors, ciphertext tamper tests, persistent-state permission tests, and resume API coverage.

### Security

- Encrypt terminal input, output, snapshots, resize messages, and latency probes with AES-256-GCM while authenticating relay-visible frame opcodes.
- Keep random keys in URL fragments that are not sent to Cloudflare; password mode sends only a random salt and derives the key locally with PBKDF2-HMAC-SHA256.
- Store persistent host credentials and decryption material in owner-only state, reject overly broad file permissions, and bind relay resume to the saved host credential and immutable access/encryption mode.

### Changed

- Preserve persistent relay identity for up to 30 offline days while keeping ordinary task-bound session deletion unchanged.
- Document E2EE metadata exposure, bearer-link implications, replay/drop limitations, unrecoverable keys, and Docker volume trust boundaries without vague security claims.

## [0.5.0] — 2026-08-31

### Added

- Add a structured website knowledge base covering setup, mobile terminal behavior, reliability, and the precise security/trust model.
- Add bounded browser paste and render queues, snapshot recovery after output pressure, and explicit tests for iOS terminal-key anomalies and large paste framing.

### Changed

- Give exactly one browser deterministic ownership of PTY sizing; transfer it to an active collaborator and suspend browser sizing while a local terminal is attached.
- Keep PTY reads independent of relay speed, add WebSocket write deadlines, and recover slow or reconnected viewers from the CLI's bounded terminal snapshot.
- Expand README reliability guarantees and clearly document mobile, multi-viewer, lifecycle, high-output, reconnect, bearer-link, and Cloudflare trust behavior.

## [0.4.0] — 2026-08-27

### Added

- Add `shell --read-only <command>` for view-only browser links.
- Label read-only terminals in the browser and report access mode in CLI output, `shell list`, and JSON events.

### Security

- Store access mode as immutable session metadata and reject browser input for read-only sessions inside the Worker.

## [0.3.9] — 2026-08-24

### Added

- Add a source-building Homebrew formula directly to this repository. Brew fetches the tagged source and Go build dependency, compiles locally, and installs the result; after one-time tap trust, install, upgrade, or uninstall with the short `shell-online` formula name.
- Add real phone-form-factor Codex captures and clear Homebrew, standalone installer, and build-it-yourself paths to the landing page.

### Changed

- Harden the no-Homebrew installer with Rosetta detection, writable-path validation, actionable download and checksum errors, safer shell-profile guidance, and warnings when an older `shell` executable shadows the new installation.
- Track Homebrew command copies separately while preserving the existing privacy-limited analytics and stored statistics.
- Expand the landing page with eight practical terminal-sharing use cases, complete primary search and social metadata, linked Pilot Protocol attribution, visible crawlable fallback copy, and strict no-index handling outside the canonical homepage.

## [0.3.8] — 2026-08-22

### Security

- Build all release binaries with Go 1.27.0, eliminating standard-library vulnerabilities present in the previous toolchain.
- Add automated dependency auditing, govulncheck, CodeQL, secret scanning guidance, and least-privilege pinned CI actions.
- Document the bearer-link trust model and private vulnerability-reporting process.

### Added

- Publish deterministic SHA-256 manifests and machine-readable release metadata for every supported binary.
- Show the release version and checksum manifest from the landing page and terminal controls.
- Verify and print the selected binary's digest during installation.

## [0.3.7] — 2026-08-22

- Reject stale private background flags with a parent-bound startup handshake.
- Support safe Claude Code conversation handoffs through a forked process.

[0.6.2]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.2
[0.7.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.0
[0.7.1]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.1
[0.7.2]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.2
[0.7.3]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.3
[0.8.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.8.0
[0.8.1]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.8.1
[0.6.1]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.1
[0.5.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.5.0
[0.6.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.0
[0.4.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.4.0
[0.3.9]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.3.9
[0.3.8]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.3.8
[0.3.7]: https://github.com/TeoSlayer/shell.online/commits/main
