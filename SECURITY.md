# Security policy

## Supported versions

Security fixes are applied to the current release on `main`. Older binaries are not supported; install the latest release from `https://shell.online/install` before reporting an issue.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Security → Report a vulnerability** flow in this repository so details remain private. Include the affected version, impact, reproduction steps, and any suggested mitigation.

You should receive an acknowledgement within three business days. We will validate the report, coordinate a fix and disclosure with you, and credit you unless you prefer to remain anonymous.

## Scope and intended behavior

- A share URL intentionally grants anonymous view and input access. A recipient typing into the shared process is not an authorization bypass.
- Reports about leaked links are actionable when shell.online itself disclosed or made them predictable; links forwarded or published by their owner are not a product vulnerability.
- Availability reports should demonstrate a way to bypass the configured rate, frame-size, audience, or lifetime limits.
- The statistics dashboard is private and password-protected. Do not test it with credential stuffing or high-volume traffic.

When testing, use your own machine and sessions. Do not access another person's terminal, retain terminal contents, or degrade the public service.
