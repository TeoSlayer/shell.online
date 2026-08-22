# Changelog

All notable user-visible changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

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

[0.3.8]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.3.8
[0.3.7]: https://github.com/TeoSlayer/shell.online/commits/main
