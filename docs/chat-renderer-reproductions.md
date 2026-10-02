# Chat renderer: reproduction evidence

Tested 2026-10-02 on macOS with local Chrome. `main`, `origin/main` and a fresh
GitHub `ls-remote` agree on `436ee639a3ad888e86b3b7050632e2546d610fd5`.
The baseline is a separate detached worktree. Only regression test files were
copied into it; its production source was left unchanged. The browser runner
bundles the same fixture against either checkout's source.

## Before and after

| Check | Untouched main | Fix branch |
| --- | --- | --- |
| Identical unit regression suite | 136 pass, **31 fail** | **167 pass**, zero fail |
| Browser reproductions, 1280px + 390px | 4 pass, **16 fail + 2 hangs** | **22 pass**, zero fail |
| Actual Claude bytes, 3 chunk sizes × 5 paint cadences | All 15 cases fail | All 15 pass |

These are test-case counts, not counts of independent bugs. The byte-chunk cases
exercise the same recording under different delivery schedules. Full case names,
browser assertion failures and recorded warnings are in
[the machine-readable results](chat-renderer-reproduction-results.json).

Each row below ran at both browser widths:

| Browser case | Observed on main | With fixes |
| --- | --- | --- |
| Preformatted Python | `__name__` becomes bold `name`; indentation/lines lost | Exact source retained |
| Revised rich content | Stale or raw heading | Revised heading rendered |
| Standalone Markdown table | Raw rows | Header and cells rendered |
| Padded table with literal pipes | Columns lost | Cells, literal pipes and alignment retained |
| Streamed fenced code | Fence/blank lines split; literal emphasis changed | Exact code text retained |
| Blue Reading notice | Neutral colours | App blue foreground/background |
| Output arriving before cache load | Older cached answer disappears | Cached and live answers both retained |
| Actual shell/Claude/Vim bytes | Claude produces no answer in this browser schedule | Complete Claude prompt/answer, single progress headings; shell output and Vim notice |
| Orphan pipe row in Markdown | Browser `Runtime.evaluate` times out | Following text rendered |
| Rich metadata-only revision | Pass | Pass |
| Existing 30-frame Claude sequence | Pass | Pass |

The orphan-pipe case has a fresh browser process, so its hang cannot prevent
later cases from running. Other uncaught errors fail the runner. Chrome's
specific deferred ResizeObserver notification is recorded separately in both
builds; this is not a claim of a warning-free browser console.

## Captured bytes and additional findings

The existing `adaptive/fixtures/captures` recording contains real Claude Code
v2.1.280 PTY bytes. The tests feed those bytes unchanged into xterm. Transport
chunks of 31, 137 and 509 bytes cross ANSI sequences and UTF-8 boundaries;
screen reads happen every 1, 2, 3, 5 or 8 chunks. Assertions require exactly one
complete sent prompt, one copy of each progress heading, and the final answer
through “when no physical terminal is attached.” Browser checks separately use
the real `ChatTerminal`, DOM, WebCrypto and IndexedDB.

Tracing those frames established these causes:

- The cursor can be halfway through a prompt while the old composer and footer
  remain below it. That lower content does not make the prompt complete.
- Tool headings blink between a bullet and two spaces; the following tool-result
  marker identifies them. A clock can end in an ellipsis, which the old timer
  expression did not remove.
- A normalized footer spinner could match an unrelated status in the header,
  causing old conversation rows to be emitted again.
- Footer tips, including wrapped tips, could prematurely close a partial answer.

The other committed recording, Claude v2.1.281's 30-frame sequence, remains a
separate regression check. A draft cursor fix failed an added pause/preview
case; keeping the cursor row pending instead of dropping it fixed that failure.
That candidate failure is not being counted as an additional production bug.

The route browser test also reproduced a summary-permission checkbox remaining
off after its save response. `Session.tsx` omitted `summariesEnabled` when merging
the response. The strengthened test waits for the save to finish and asserts
the value before the next poll, including enable and disable.

## Broader validation

- App: **2,063 tests pass, 3 skipped, 129 files**. Chat subset: **204 pass**.
- Root: **762 tests pass, 66 files**; the full installer, Docker entrypoint,
  mocked deployment guard, manifest, SEO, mobile control and formula chain passes.
- Native macOS Go: `go test ./...` passes.
- Production app build, root web build, type checks, protocol and game UI checks
  pass. The app build uses synthetic OIDC settings. No deployment was performed.
- Expanded chat browser canary passes at 1280px and 390px: history refresh,
  renderer re-entry, replay, delayed cache, streaming, idle output, thinking
  state, formatting and scrolling.
- Real local Go host → workerd relay → Chrome passes streaming, encrypted
  connection, snapshot comparison, resize, second viewer, forced reconnect,
  pixel/grid checks, responsive public controls and verified session cleanup.
  The first attempt lacked the root web build; after building assets, it passes.
- Independent terminal snapshot tests pass all 12 fixtures, including their
  negative raw-tail control.
- Layout gates pass phone/tablet/desktop boundaries, both themes and simulated
  keyboard transitions. Terminal refit passes eight DPR/theme/width scenarios.
- Touch-scroll, session-automation and session-route browser gates pass.
  Permission typography and placement under Details are asserted at both widths;
  their screenshots were also inspected.
- Source lint has no errors. Three existing React warnings in `Session.tsx`
  remain; none relates to the added response field. Whitespace checks pass.

## Repeating the comparison

Install each checkout's locked dependencies, including `app/`, then run this
from the fix checkout's `app/` directory. Chrome must be available locally.

```sh
node scripts/test-chat-reproductions.mjs /absolute/path/to/baseline /tmp/chat-main.json
node scripts/test-chat-reproductions.mjs /absolute/path/to/fixes /tmp/chat-fixed.json
```

The first command intentionally returns nonzero on the recorded main revision.
`CHAT_REPRO_CASES=recorded_bytes,orphan_pipe` selects individual browser cases.
For unit comparison, copy only these tests from the fixes to the baseline, then
run the same command in both checkouts' `app/` directories:

```sh
npm exec -- vitest run \
  src/terminal/chat/transcript.test.ts \
  src/terminal/chat/paragraphs.test.ts \
  src/terminal/chat/chat-history.test.ts \
  src/terminal/chat/agents/stream.test.ts \
  src/terminal/chat/agents/claude-code.test.ts \
  src/terminal/chat/agents/raw-capture.test.ts --maxWorkers=4
```

## Still unconfirmed

The exact original “Running 1 shell command…” screenshot and the original live
“output only appears after refresh” sequence were not supplied/recreated. Related
failures were reproduced and fixed, but that does not prove those reports had the
same causes. Physical iOS/Android keyboards were not exercised. A Safari route
test was attempted, but WebDriver failed to create a session on both attempts;
Safari behavior remains unverified.
Windows ConPTY, actual QEMU execution, release publication, production deployment
and historical CI reruns were not performed. The 30-item
[audit](chat-renderer-audit.md) keeps those distinctions explicit.
