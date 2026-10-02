# PR review — chat renderer

Reviewed the complete diff against `436ee63`, including parser progress, code
fidelity, replay identity, cache transactions and encryption, renderer disposal,
idle timers, permission state, and browser-test inputs. This is a manual review
by the implementing agent, supplemented by CodeQL and regression tests.

## Findings addressed

1. **High: output resumes after the idle commit as a second answer.**
   The existing 450ms browser pauses exercised the preview timer but never the
   1.2-second commit timer. Waiting 1.6 seconds, then extending `Partial` to
   `Partial answer completed`, reproduced two answer bubbles. The browser test
   failed with `Alternate repaint preserves one answer`. Idle output now closes
   for display and caching while retaining a reversible parser tail and message
   identity. Only changed text reopens it; an unchanged repaint preserves rich
   rendering. Actual paragraph/prompt boundaries and program exit still finish
   the previous answer. The longer-pause browser test passes at both widths.

2. **Medium: unvalidated method dispatch in the reproduction fixture.**
   CodeQL alert 45 identified `cases[name]()` where `name` came from the URL.
   The fixture now looks up only its declared cases in a `Map` and rejects
   unknown names. This is test infrastructure; no production endpoint was
   introduced. The CodeQL rerun must confirm the alert is cleared.

3. **Regression prevented while fixing finding 1: reconnect followed immediately
   by renderer disposal could omit a saved answer.**
   A replay temporarily marked identical cached text open, making it ineligible
   for the immediate cache flush. The existing encrypted refresh browser test
   caught the missing answer. Exact agent replay matches now retain their saved
   closed state and live identity; changed output can reopen them. The unit and
   encrypted browser lifecycle tests pass.

The first finding was reproduced before changing production code. The third was
caught in the draft review fix before pushing it; it is not counted as another
production failure in the original before/after report.

## Evidence and remaining limits

- Chat tests: 205 pass. The real-browser canary passes at 1280px and 390px with
  pauses extending beyond both idle timers, followed by cache/reconnect/refresh.
- Synthetic [desktop](chat-renderer-screenshots/review_preview-1280.png) and
  [mobile-width](chat-renderer-screenshots/review_preview-390.png) screenshots
  show the blue notice, code highlighting/literal identifiers, and table cells.
- CI must pass on the final PR head; earlier-head results do not certify later
  review fixes. The PR description records the final outcome.
- Physical phone keyboards, Safari, and the two exact original intermittent
  reports retain the limits in the [reproduction report](chat-renderer-reproductions.md).
- No merge, production deployment, protocol change, or CLI release is part of
  this PR preparation.
