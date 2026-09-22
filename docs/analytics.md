# Product analytics

PostHog receives explicit, content-free events from the public site, docs,
account app, current game and shared-terminal viewer. GA4 remains limited to
the public landing and docs. Existing first-party statistics remain independent.

`shared/posthog.ts` is the fixed event/property allowlist and public ingestion
configuration. `web/posthog.ts` supplies the browser transport lifecycle. The
project token is a public capture token, not a personal/admin credential.

## What is measured

- `$pageview` / `$pageleave`: route category and actual focused time (`active_ms`).
- `command_copy` / `landing_cta`: fixed button categories, never copied text.
- `app_action`: successful or failed mutations with a fixed target and HTTP method.
- `signed_in` / `signed_out`: identity transitions, without an account identifier.
- `terminal_connected` / `report_opened`: viewer connection and feedback entry.
- Relay milestones (installer/binary downloads, install outcomes, sessions and
  viewer connections) are mirrored when `POSTHOG_ENABLED=1`. These are aggregate
  counts with one fixed anonymous service identity, not users or an attributed
  end-to-end installation funnel. Filter `surface=relay` separately from browsers.

Use `surface` to separate landing, docs, terminal, app and game usage. A copy is
not an installation, an accepted send is not an agent completing work, and a
page load is not a verified human visit. Do not equate these stages in funnels.

## Privacy and operation

No autocapture, remote JavaScript, replay, DOM text, raw errors, commands,
terminal output, URLs with identifiers, queries/fragments, referrers, names,
email addresses, IP forwarding or person profiles. Properties are constructed
from finite lists rather than redacted after collection. PostHog geo enrichment
is disabled. Network requests necessarily reach its US ingestion service.

Anonymous identifiers use a Secure, SameSite=Lax, host-only session cookie, not
localStorage. An idle analytics session rotates after 30 minutes. Account changes
clear the app identifier; public-site and app identities are intentionally not
joined. GPC/DNT and saved opt-outs stop browser events. Unknown/self-hosted origins,
OAuth callbacks and the private statistics site send nothing. CSP permits only
the ingestion origin, not third-party scripts. Failed capture never blocks work.

For verification, intercept `/i/v0/e/` in browser tests and assert emitted payloads
contain no synthetic secret markers. Keep synthetic tests out of production
analytics. API acceptance proves ingestion accepted a request, not that a report
has finished processing it. A capture token cannot query dashboards.
