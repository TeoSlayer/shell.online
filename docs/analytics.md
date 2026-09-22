# Public website measurement

The landing page is a static HTML entry point with a small interaction bundle.
The terminal renderer is loaded only when a visitor opens a terminal or other
application route. Brand artwork is served locally.

## What the counters mean

| Signal | What it establishes |
| --- | --- |
| Page response | The Worker served a document request, excluding prefetches. It does not prove that the page rendered. |
| `page_loaded` | The eligible public page's JavaScript initialized and reported a load. Blocking scripts or analytics can prevent it. |
| `cta_click` | A particular landing button was clicked, not an account created. |
| `copy` | The clipboard API reported success for the install or run command, not that the command was executed. |
| `installer_download` | An install script was fetched. |
| `binary_download` | A complete, non-range binary response was served. Repeated full downloads can count again. |
| `install_outcome:ok` | The installer reported success. This is not an independently verified installation. |
| Session created / started | Separate API-creation and host-connection lifecycle events. |

These are separate event totals. Do not divide unmatched ad clicks, downloads
and sessions and call the result a verified conversion rate. Repeat activity,
different reporting windows, bot classification and blocked telemetry affect
the totals. New browser-load events have no historical backfill.

The existing install-to-session cohort uses secret-salted address hashes. Shared
networks can merge machines; changing networks can split one machine. Its end
event is a session-creation request, not proof of a working session. It does not
connect a phone ad click to a later installation on another computer.

## Attribution and privacy boundaries

- Google Analytics is limited to the public `shell.online` landing and recognized
  documentation routes. Private terminals, account pages and stats pages do not
  load the tag. Unknown query parameters or unrecognized fragments disable it.
- Supported campaign links preserve finite source and medium buckets. X/Twitter,
  `t.co` referrals and the presence of `twclid` are recognized. Raw click IDs,
  campaign names, search terms and ad-content strings are not collected by our
  public events. Arbitrary campaign/ad-level reporting is therefore unavailable.
- GA receives a canonical page URL without query or fragment, an empty referrer
  and a fixed public title. Google Signals and ad-personalization signals are off.
  GA cookies are host-only, use the `shell_public_ga` prefix and expire after
  90 days. These are Google Analytics cookies, not cookie-free measurement.
- The first-party event endpoint accepts bounded bodies and fixed event/target/
  source values. It does not store submitted page URLs, terminal content, link
  passwords, frame keys or bearer tokens.
- GPC, DNT, an existing analytics decline and Google's disable flag suppress
  browser marketing events. GPC/DNT also suppress first-party visitor hashing.
  Aggregate operational request counts are separate and can still be recorded.
- Public event reports and installer reports can be spoofed; rate limits and
  bot classification reduce noise but are not proof of individual users.

## Local validation

Run `npm run check` and `npm run build:web`. For the real-browser layout and
interaction gate, start Vite on port 5178 and run
`node scripts/test-landing-browser.mjs`. `LANDING_TEST_URL` may point to another
loopback-only preview. The gate checks phone, tablet and desktop layouts,
locally served logos, touch targets, command selection, copy success/failure,
and the real screenshot switch. Local previews emit no marketing events.

Before deploying analytics changes, inspect actual Google collection requests
with collection intercepted rather than sent. Verify one page view, correct
source/medium, copy and CTA events, and no private URL fields. Mocked `dataLayer`
tests alone do not prove what Google's script transmits.
