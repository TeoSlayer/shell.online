# Changelog

All notable user-visible changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

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
