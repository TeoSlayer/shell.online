# Chat renderer audit — 2026-10-02

Work is isolated on `fix/chat-renderer-all-sessions` in
`/Users/alexgodo/agent-work/shell-chat-renderer-fresh-20261002`. The user freshly
cloned GitHub after this environment's network restriction blocked cloning.
Local `main` and `origin/main` both point to `045a145` (#306), the head delivered
by that fresh clone. The earlier prepared fixes were applied cleanly on top;
local main is untouched. Fetch main again before merging if it advances.

## Changes prepared

- Honor preformatted messages instead of flattening their code through Markdown.
  Explicit fenced blocks retain indentation, blank lines and literal identifiers,
  while still receiving syntax colour. Normal-buffer sessions keep a fence
  together across chunks and quiet periods.
- Consume non-table pipe rows instead of looping indefinitely in the Markdown
  parser. Detect standalone/padded tables, including optional outer pipes,
  alignment and literal pipes inside cells. Keep their rows in one message.
- Preserve rich message nodes when only metadata changes; update their content
  when a completed message is revised.
- Load device history before consuming the connection's snapshot, and avoid
  saving over history while its read is pending.
- Serialize cache writes across renderer replacements, await transaction commit
  before loading, and flush on hiding/disposal without depending on an animation
  frame. Reject malformed cached data without blocking live output.
- Parse alternate-screen snapshots before replay deduplication. Retain output
  from this visit across reconnects, including messages no longer on screen.
- Keep an active answer growing in place through a snapshot. Trailing spinner
  and status rows no longer cause its partial last row to be committed early.
- Deduplicate a terminal snapshot clipped to multiple final rows of a cached
  answer, preserving the complete answer and continued output. Maintain replay
  boundaries when the message limit trims history. Stop suppressing duplicates
  once a genuinely new prompt/answer appears.
- Preserve consecutive blank rows inside code across repaint frames, while
  continuing to collapse excess spacing in prose.
- Restore blue informational notice styling, as confirmed by the user.

## User issue list

| Items | Status in this checkout |
| --- | --- |
| 1 | Renderer remains under validation; no claim of overall completion. |
| 2 | Cross-frame prose blank-row collapse already in baseline (#302); preserved, with code whitespace protected. |
| 3 | Blue “Reading … as messages” notice restored. |
| 4 | Fixed replay ordering, clipped terminal tails and capped-history deduplication; added delayed-cache and active-answer cases. |
| 5 | Re-entry coverage expanded; cache reads now wait for outgoing writes to commit. |
| 6–7 | Baseline prompt/tool separation and clock normalization preserved; adapter tests pass. |
| 8 | Closed the parser loop, cache races, hidden repeated answers after a new prompt, and partial-answer duplication found during this audit. The original intermittent report still needs browser confirmation. |
| 9–10 | Permission typography and Details placement already in baseline (#295, #296); no new UI changes. |
| 11 | Installed binary reports `0.24.2-dev.d337061`; no downgrade to 0.24.0 performed. |
| 12 | Chat renderer's JSON transcript path remains removed. Newer main's session-summary feature is separate and unchanged. |
| 13–14 | Existing viewport/safe-area changes preserved; mobile-layout tests pass. Real keyboard validation remains outstanding. |
| 15 | Existing removal of fullscreen fallback and chat-only padding preserved. |
| 16 | Existing Chrome startup/profile fixes preserved. Browser test cannot launch its local server here. |
| 17 | Existing quiet-time commit/stale-spinner handling preserved; reset also clears stale thinking state. |
| 18 | Delayed loading, write ordering, encryption and isolation pass unit/DOM tests; actual IndexedDB browser run pending. |
| 19–20 | Formatting changes prepared; DOM smoke checks pass. Browser layout remains unverified. |
| 21 | Existing sent-prompt deduplication preserved; replay deduplication fixed. |
| 22 | Cache-load race, overlapping saves and reconnect history loss fixed; hidden-page/disposal flush added; browser refresh fixture expanded. |
| 23 | Existing desktop grid unchanged; no new visual claim. |
| 24 | Baseline already contains release 0.24.1. No release or deployment performed. |
| 25 | Preformatted/fenced code corruption fixed and regression cases added. |
| 26 | Partial-answer duplication reproduced and fixed; the specific original “Running 1 shell command…” screenshot has not been reproduced. |
| 27 | Version/deploy behavior unchanged; version string is not deployment evidence. |
| 28 | Protocol unchanged; protocol consistency check passes. |
| 29–30 | No CI reruns or merge attempted. Work is based on the fresh clone's main; current remote head and CI still need checking before merge. |

## Validation and limits

- App tests: **2,022 passed, 3 skipped across 125 files**, with four workers.
  Three server suites that require prohibited local port binding were excluded
  (`boot`, `static-files`, `relay-proxy`). Targeted chat tests: **185 passed**.
  An earlier broad client run hit a game simulation timeout under high worker
  concurrency; its isolated rerun and the four-worker full run both passed.
- Type checking and production bundle build pass with synthetic OIDC settings
  (`https://auth.fixture.invalid`, client `chat-renderer-fixture`). This is a
  build check, not a production configuration or deployment.
- Chat source lint, protocol consistency, game UI checks and whitespace checks pass.
- DOM smoke checks using a locally available LinkeDOM and real xterm parser
  passed for code fidelity, rich updates, orphan pipe rows, delayed cache,
  replay, reconnect, and active-answer continuation. Cache I/O was mocked in
  that supplementary check; it does not validate browser layout or IndexedDB.
  Separate history tests use real WebCrypto with controlled storage scheduling.
- Expanded browser canary builds and includes desktop/mobile, encrypted
  IndexedDB, refresh, information colours and active-answer cases. Execution
  is blocked by `listen EPERM` on 127.0.0.1. Browser-control tool also reports
  unsupported authentication. The user has been asked to run the canary outside
  the restricted environment; its result is still pending.
- No production deployment or physical iOS/Android keyboard check has been done.

Remaining browser gates, from the fresh checkout's `app/` directory:

```sh
node scripts/test-chat-renderer-ui.mjs
node ../scripts/test-app-layout-browser.mjs
node scripts/test-terminal-refit-ui.mjs
```

These use temporary profiles and synthetic sessions. The layout gate covers
desktop/mobile navigation, terminal versus chat padding, grid sizing and a
simulated software keyboard. Physical-device keyboard behavior remains a
separate acceptance check.
