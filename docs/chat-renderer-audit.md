# Chat renderer audit — 2026-10-02

Work is isolated on `fix/chat-renderer-all-sessions`. The current baseline is
`d21dd56`, obtained from a local `upstream/main` reference. **It has not been
verified against current GitHub main.** SSH fetch, HTTPS fetch and a fresh
HTTPS clone all failed because this environment cannot resolve github.com.
Rebase onto freshly fetched main before reviewing for merge or deployment.

## Changes prepared

- Honor preformatted messages instead of flattening their code through Markdown.
  Explicit fenced blocks retain indentation, blank lines and literal identifiers,
  while still receiving syntax colour. Normal-buffer sessions keep a fence
  together across chunks and quiet periods.
- Consume non-table pipe rows instead of looping indefinitely in the Markdown
  parser. Detect standalone pipe tables and tilde code fences.
- Preserve rich message nodes when only metadata changes; update their content
  when a completed message is revised.
- Load device history before consuming the connection's snapshot, and avoid
  saving over history while its read is pending.
- Parse alternate-screen snapshots before replay deduplication. Retain output
  from this visit across reconnects, including messages no longer on screen.
- Keep an active answer growing in place through a snapshot. Trailing spinner
  and status rows no longer cause its partial last row to be committed early.
- Restore blue informational notice styling, as confirmed by the user.

## User issue list

| Items | Status in this checkout |
| --- | --- |
| 1 | Renderer remains under validation; no claim of overall completion. |
| 2 | Cross-frame blank-row collapse already in baseline (#302); preserved. |
| 3 | Blue “Reading … as messages” notice restored. |
| 4 | Fixed replay ordering; added delayed-cache and active-answer cases. |
| 5 | Re-entry coverage retained and expanded with cache/reconnect cases. |
| 6–7 | Baseline prompt/tool separation and clock normalization preserved; adapter tests pass. |
| 8 | Closed the parser loop, cache race, and partial-answer duplication found during this audit. The original intermittent report still needs browser confirmation. |
| 9–10 | Permission typography and Details placement already in baseline (#295, #296); no new UI changes. |
| 11 | Installed binary reports `0.24.2-dev.d337061`; no downgrade to 0.24.0 performed. |
| 12 | Chat renderer's JSON transcript path remains removed. Newer main's session-summary feature is separate and unchanged. |
| 13–14 | Existing viewport/safe-area changes preserved; mobile-layout tests pass. Real keyboard validation remains outstanding. |
| 15 | Existing removal of fullscreen fallback and chat-only padding preserved. |
| 16 | Existing Chrome startup/profile fixes preserved. Browser test cannot launch its local server here. |
| 17 | Existing quiet-time commit/stale-spinner handling preserved; reset also clears stale thinking state. |
| 18 | Delayed history loading and session isolation covered in the expanded browser fixture; actual IndexedDB run pending. |
| 19–20 | Formatting changes prepared; DOM smoke checks pass. Browser layout remains unverified. |
| 21 | Existing sent-prompt deduplication preserved; replay deduplication fixed. |
| 22 | Cache-load race and reconnect history loss fixed; browser refresh fixture expanded. |
| 23 | Existing desktop grid unchanged; no new visual claim. |
| 24 | Baseline already contains release 0.24.1. No release or deployment performed. |
| 25 | Preformatted/fenced code corruption fixed and regression cases added. |
| 26 | Partial-answer duplication reproduced and fixed; the specific original “Running 1 shell command…” screenshot has not been reproduced. |
| 27 | Version/deploy behavior unchanged; version string is not deployment evidence. |
| 28 | Protocol unchanged; protocol consistency check passes. |
| 29–30 | No CI reruns or merge attempted. Fresh remote main and CI remain prerequisites. |

## Validation and limits

- Client and mobile-layout checks: 1,103 passed across 85 files. Targeted chat tests: 164 passed.
- Type checking and production bundle build pass with synthetic OIDC settings
  (`https://auth.fixture.invalid`, client `chat-renderer-fixture`). This is a
  build check, not a production configuration or deployment.
- DOM smoke checks using a locally available LinkeDOM and real xterm parser
  passed for code fidelity, rich updates, orphan pipe rows, delayed cache,
  replay, reconnect, and active-answer continuation. Cache I/O was mocked in
  that supplementary check; it does not validate browser layout or IndexedDB.
- Expanded browser canary builds and includes desktop/mobile, encrypted
  IndexedDB, refresh, information colours and active-answer cases. Execution
  is blocked by `listen EPERM` on 127.0.0.1. Browser-control tool also reports
  unsupported authentication.
- Full app tests on the initial baseline had 1,944 passing, 20 skipped, and
  failures in three server suites due to prohibited local port binding.
