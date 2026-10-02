# Chat renderer audit — 2026-10-02

Work is isolated on `fix/chat-renderer-all-sessions` in
`/Users/alexgodo/agent-work/shell-chat-renderer-fresh-20261002`. The user freshly
cloned GitHub after this environment's network restriction blocked cloning.
After the user enabled Full access, GitHub fetch and localhost/Chrome execution
were verified. Local `main` was updated to freshly fetched `436ee63` (#308),
matching `origin/main`, and the fixes rebased cleanly onto it. Fixes remain on
their own branch. Fetch main again before merging if it advances.

The before/after evidence and commands are in [the reproduction report](chat-renderer-reproductions.md).

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
- Keep informational notices out of the replay's chronological matching. The
  real-browser refresh test exposed duplicated cached answers when a Reading
  notice followed old messages in storage but preceded them in the snapshot.

- Replay actual Claude PTY bytes at multiple chunk sizes and paint cadences.
  Hold incomplete cursor rows for reversible previews, normalize blinking tool
  markers and clocks ending in ellipses, ignore footer tips, and prevent a
  footer spinner from matching an unrelated header status.
- Merge summary consent immediately from its save response instead of leaving
  the checkbox stale until the next poll.

## User issue list

| Items | Status in this checkout |
| --- | --- |
| 1 | Expanded real-browser regression suite passes at desktop and phone widths; production and physical-device acceptance remain separate. |
| 2 | Cross-frame prose blank-row collapse already in baseline (#302); preserved, with code whitespace protected. |
| 3 | Blue “Reading … as messages” notice restored. |
| 4 | Fixed replay ordering, informational-notice anchors, clipped terminal tails and capped-history deduplication; delayed-cache and active-answer browser cases pass. |
| 5 | Re-entry coverage expanded; cache reads now wait for outgoing writes to commit. |
| 6–7 | Prompt/tool separation retained. Actual captured bytes reproduced incomplete prompts, blinking-marker duplication and clocks ending in ellipses; fixes pass 15 chunk/paint combinations. |
| 8 | Closed the parser loop, cache races, hidden repeated answers after a new prompt, and partial-answer duplication found during this audit. Browser cases pass; the original intermittent report still needs confirmation in the affected live session. |
| 9–10 | Typography and Details placement already in baseline (#295, #296), checked in Chrome at 1280px and 390px. A separate reproduced summary-consent save/checkbox lag is fixed. |
| 11 | Installed binary reports `0.24.2-dev.d337061`; no downgrade to 0.24.0 performed. |
| 12 | Chat renderer's JSON transcript path remains removed. Newer main's session-summary feature is separate and unchanged. |
| 13–14 | Existing viewport/safe-area changes preserved; responsive browser tests and simulated keyboard opening/closing pass for chat and terminal in both themes. Physical-device keyboard validation remains outstanding. |
| 15 | Existing removal of fullscreen fallback and chat-only padding preserved. |
| 16 | Existing Chrome startup/profile fixes preserved; browser gates launch and pass locally with isolated profiles. No historical CI rerun performed. |
| 17 | Existing quiet-time commit/stale-spinner handling preserved; reset also clears stale thinking state. |
| 18 | Delayed loading, write ordering, encryption and isolation pass unit tests and actual IndexedDB browser checks. |
| 19–20 | Code, headings, tables and rich revisions pass the actual-browser fixture at 1280px and 390px. |
| 21 | Replay deduplication fixed. Raw captured bytes also reproduced a prompt published while still incomplete; cursor-boundary handling fixes it. |
| 22 | Cache-load race, overlapping saves and reconnect history loss fixed; hidden-page/disposal flush added; browser refresh/re-entry checks pass. |
| 23 | Existing grid preserved; terminal refit passes desktop/narrow, DPR 1/2, light/dark, resize and hide/show scenarios. |
| 24 | Latest fetched main contains the 0.25.0 release and Homebrew update. No new release or deployment performed. |
| 25 | Preformatted/fenced code corruption fixed and regression cases added. |
| 26 | Repeated “Listing 1 directory…” and “Listing files in current directory” reproduced with actual captured bytes and fixed. The exact original “Running 1 shell command…” screenshot remains unconfirmed. |
| 27 | Version/deploy behavior unchanged; version string is not deployment evidence. |
| 28 | Protocol unchanged; protocol consistency check passes. |
| 29–30 | No CI reruns or merge attempted. Local main was fetched and fixes rebased onto `436ee63`; check remote head and CI again before merge. |

## Validation and limits

- Full app tests: **2,063 passed, 3 skipped across 129 files**, with four workers
  and no suites excluded. The three formerly blocked server suites (`boot`,
  `static-files`, `relay-proxy`) also pass. Targeted chat tests: **204 passed**.
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
- Expanded browser canary **passes at 1280px and 390px**, using real Chrome,
  xterm and encrypted IndexedDB. This includes refresh/re-entry, information
  colours, active answers, formatting, scrolling and replay.
- App layout browser checks **pass** across phone/tablet/desktop boundaries,
  light/dark themes and simulated keyboard transitions for both renderers.
- Terminal refit browser checks **pass all eight scenarios** (desktop/narrow,
  DPR 1/2, light/dark). Desktop dark and narrow light result images inspected.
- Root test chain passes: **762 tests across 66 files**, installers, Docker entrypoint,
  mocked deployment guard, QEMU artifact manifest, SEO, mobile source guard and formula.
  Native macOS `go test ./...` passes. The manifest check is not QEMU execution.
- Before/after comparison: identical unit tests give **31 failures on main and
  167/167 passes with the fixes**. Browser reproductions give **18 failures/timeouts
  on main and 22/22 passes with the fixes**, across desktop and mobile widths.
- Live local Go host → relay → Chrome passes streaming, snapshot, resize, reconnect,
  encryption, second viewer and cleanup. Touch scrolling and permissions/route gates pass.
- Browser proof records deferred ResizeObserver notifications in both builds. Lint
  has no errors; three existing React warnings in `Session.tsx` remain.
- No production deployment, historical CI rerun, Windows ConPTY execution or
  physical iOS/Android keyboard check has been done.
- Safari WebDriver failed to create a session on two attempts, so Safari remains
  unverified; this was a setup failure, not a passing browser test.

Passing browser gates, from the fresh checkout's `app/` directory:

```sh
node scripts/test-chat-renderer-ui.mjs
node ../scripts/test-app-layout-browser.mjs
node scripts/test-terminal-refit-ui.mjs
```

These use temporary profiles and synthetic sessions. The layout gate covers
desktop/mobile navigation, terminal versus chat padding, grid sizing and a
simulated software keyboard. Physical-device keyboard behavior remains a
separate acceptance check.
