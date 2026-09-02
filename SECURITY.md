# Security policy

## Supported versions

Security fixes are applied to the current release on `main`. Older binaries are not supported; install the latest release from `https://shell.online/install` before reporting an issue.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Security → Report a vulnerability** flow in this repository so details remain private. Include the affected version, impact, reproduction steps, and any suggested mitigation.

You should receive an acknowledgement within three business days. We will validate the report, coordinate a fix and disclosure with you, and credit you unless you prefer to remain anonymous.

## Scope and intended behavior

- An interactive share URL intentionally grants anonymous view and input access. A recipient typing into that shared process is not an authorization bypass.
- A session created with `--read-only` grants anonymous view access only. Browser input that reaches a read-only session must be rejected by the Worker; any bypass is in scope.
- By default, every session created by the current CLI encrypts terminal payloads between the CLI and browser. Cloudflare still receives frame opcodes and traffic/lifecycle metadata. Plaintext disclosure to the relay, nonce/key reuse that compromises confidentiality, acceptance of modified ciphertext, or cross-language key-derivation incompatibility is in scope. Older clients that predate default E2EE are unsupported and should be upgraded.
- `--no-e2ee` is an explicit opt-out for compatibility or debugging. In that mode HTTPS/WSS protects each transport hop, but terminal payloads intentionally pass through Cloudflare in memory. Relay access to that plaintext is expected behavior and the CLI must label it clearly; accidental fallback from the default encrypted mode is in scope.
- E2EE access remains a bearer capability. Possession of both the complete salted URL and its browser password intentionally grants decryption. Relay-side dropping, delaying, and replaying of valid ciphertext are documented protocol limits rather than confidentiality claims.
- The CLI generates an eight-character base64url password with 48 bits of entropy when no password is supplied. This is an explicit convenience/security tradeoff for task-bound shares, not a claim of passphrase-strength protection. `SHELL_ONLINE_E2EE_PASSWORD` accepts a longer unique password for sensitive or long-lived sessions; recipients should receive the URL and password through separate channels when appropriate.
- Persistent state files and Docker state volumes intentionally contain the host credential, browser password, and E2EE key material. Files created by shell.online must be owner-only. A saved password cannot be changed in place because the stable URL and key are bound to it; password rotation creates new state and a new URL. Disclosure caused by publishing, broadly mounting, or backing up that state outside shell.online is not a product vulnerability.
- Active-session records in the per-user local control directory intentionally retain the browser password so `shell list` can reconstruct usable access. The directory and records must remain owner-only and are deleted when their processes close.
- Reports about leaked links are actionable when shell.online itself disclosed or made them predictable; links forwarded or published by their owner are not a product vulnerability.
- Availability reports should demonstrate a way to bypass the configured rate, frame-size, audience, or lifetime limits.
- The statistics dashboard is private and password-protected. Do not test it with credential stuffing or high-volume traffic.

When testing, use your own machine and sessions. Do not access another person's terminal, retain terminal contents, or degrade the public service.
