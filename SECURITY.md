# Security policy

## Supported versions

Security fixes are applied to the current release on `main`. Older binaries are not supported; install the latest release from `https://shell.online/install` before reporting an issue.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Security → Report a vulnerability** flow in this repository so details remain private. Include the affected version, impact, reproduction steps, and any suggested mitigation.

You should receive an acknowledgement within three business days. We will validate the report, coordinate a fix and disclosure with you, and credit you unless you prefer to remain anonymous.

## Scope and intended behavior

- An interactive share URL intentionally grants anonymous view and input access. A recipient typing into that shared process is not an authorization bypass.
- A session created with `--read-only` grants anonymous view access only. Browser input that reaches a read-only session must be rejected by the Worker; any bypass is in scope.
- A session created with `--e2ee` encrypts terminal payloads between the CLI and browser. Cloudflare still receives frame opcodes and traffic/lifecycle metadata. Plaintext disclosure to the relay, nonce/key reuse that compromises confidentiality, acceptance of modified ciphertext, or cross-language key-derivation incompatibility is in scope.
- E2EE links remain bearer capabilities. Possession of the complete random-key URL, or of both a password-mode URL and its password, intentionally grants decryption. Relay-side dropping, delaying, and replaying of valid ciphertext are documented protocol limits rather than confidentiality claims.
- Persistent state files and Docker state volumes intentionally contain the host credential and E2EE key material. Files created by shell.online must be owner-only; disclosure caused by publishing, broadly mounting, or backing up that state outside shell.online is not a product vulnerability.
- Reports about leaked links are actionable when shell.online itself disclosed or made them predictable; links forwarded or published by their owner are not a product vulnerability.
- Availability reports should demonstrate a way to bypass the configured rate, frame-size, audience, or lifetime limits.
- The statistics dashboard is private and password-protected. Do not test it with credential stuffing or high-volume traffic.

When testing, use your own machine and sessions. Do not access another person's terminal, retain terminal contents, or degrade the public service.
