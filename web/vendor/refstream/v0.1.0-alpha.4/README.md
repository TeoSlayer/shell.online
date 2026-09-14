# Refstream.js browser build

Vendored from [`refstream.js` v0.1.0-alpha.4](https://github.com/TeoSlayer/refstream.js/releases/tag/v0.1.0-alpha.4), commit `44dd17cf69e067b859b9ab09ba988088beaa4fd6`.

The release archive SHA-256 is `999d850a0bb75eeb17f7c2dd59e98cdf7653838ab69744f124a850bfad642c17`. The archive was verified against its published `SHA256SUMS` before extraction. Browser modules, chunks, source maps, styles, documentation, manifest and license are retained together. The two declaration files describe the browser entry points used by shell.online; the release archive does not ship browser declarations.

shell.online supplies the terminal transport, encryption, permissions and file relay. Refstream supplies the optional renderer, inspection tools and explicitly invited agent handoff. Its logical session snapshot is retained only in the current browser tab so a reload can recover task IDs and answers while the shell process is still running.

Refstream.js is MIT licensed. See `LICENSE`.
