# Changelog

All notable user-visible changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

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

[0.6.1]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.1
[0.5.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.5.0
[0.6.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.0
[0.4.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.4.0
[0.3.9]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.3.9
[0.3.8]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.3.8
[0.3.7]: https://github.com/TeoSlayer/shell.online/commits/main
