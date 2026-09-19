# Changelog

All notable user-visible changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- The statistics dashboard now includes account growth and activity: total
  accounts, sign-ups, app opens, returning accounts, daily trends, feature
  usage, active days, and retention cohorts.
- `STATS_EXCLUDE` lets operators omit internal addresses or domains from
  customer statistics. The dashboard reports the excluded count without
  exposing identifiers.

### Fixed

- Scheduled download checks no longer inflate installs, installer outcomes,
  or machine counts. Install checks identify themselves and do not report
  telemetry; monitors, HTTP libraries, and PowerShell web requests are no
  longer classified as people.
- Install and session tiles use their own trend series, prefetched pages are
  ignored, and new-versus-returning labels wait until enough history exists.
- `shell login` no longer sits there for eleven seconds after it has already
  succeeded. On a machine with the background service installed it asked the
  supervisor to replace the daemon and then waited for that to finish, and
  launchd throttles a relaunch by ten seconds -- so a login that had linked
  the machine, exchanged its token and written its credentials went silent at
  the very end. The restart is still asked for; it is no longer waited on,
  because nothing about the login depends on the answer.
- `shell login --no-browser` now accepts the sign-in pasted back. The flag is
  for a machine with no browser on it, so the link gets opened on a different
  computer -- whose browser is then sent to a loopback address that means
  nothing there and stops on a page that will not load, with the whole
  callback in the address bar. There was nowhere to put it and the CLI waited
  five minutes for a callback that could never arrive. Paste that page's
  address, or just the code, and the sign-in completes. A paste that is not
  the answer says what is wrong and the login keeps waiting.

### Fixed

- A session could be reported as "Status unavailable" indefinitely while the
  relay knew perfectly well it was connected. The service seeds its view of the
  relay a couple of sessions per request, and each request may land on a worker
  instance whose cache is empty; whatever a single cold batch did not reach was
  answered as unknown. The order it worked through was decided by a fixed
  property of the session, so in every cold instance the same one sorted last
  and was never checked by anybody. A batch now covers an ordinary working set,
  and sessions that are equally stale are chosen between at random, so one that
  misses a request is very unlikely to miss the next. The per-minute budget
  that actually protects the relay is unchanged.
- Shell Keep on a phone. The map can be pulled back: three zoom controls sit up
  the right-hand edge, and the camera's limits are now worked out from the
  canvas and re-read whenever it changes size, rather than once from a default
  800×600 that no phone has. The HUD is sized for the screen it is on, which
  includes a handset held sideways — every responsive rule in the game asked
  about the window's width, and a phone in landscape is 844 pixels across.
  The game opens at a zoom chosen for the screen instead of a constant that
  showed about eight tiles of country on a handset.
- A soldier is a session that is live and writable. Sessions whose process had
  exited, whose machine the relay had lost or that had been away too long to
  come back, or that were shared read-only were standing on the field as live
  soldiers, so the garrison only ever grew and the session count on the HUD
  read high. The field now reads liveness through the same functions as the
  session list, including the one that keeps a known state across a poll that
  did not manage to look.
- The Unmade appear. They used to march only on a hero whose session name read
  as bug work, which on a real team meant they never marched at all, and they
  were drawn at a third the height of the figures fighting them.

### Added

- The kingdom can be short-handed, and says so. Waves are sized from the number
  of people on the team, and it takes two live sessions a hero to meet them.
  Below that the camera takes a veil of blood at its corners, heavier the
  shorter the garrison is, and the HUD says in words how many more sessions
  would hold the line. Nothing is lost by being short and nothing counts down:
  starting a session anywhere on the team clears it within one poll.

## [0.17.0] — 2026-09-18

### Changed

- `shell login` asks whether your browser may start sessions on this machine
  once, on the first login for that account, instead of at every sign-in. The
  question was re-put every time so that somebody who missed it had a way back
  to it; the way back is the line printed after every login, which now names
  the command that reverses whichever way it stands, on all three branches.
  Signing in again is not a consent decision. A different account signing in is,
  so it is asked again. `--allow-remote-start` and `--no-remote-start` still
  answer it outright, and still reverse a settled answer without a prompt.
- Agreeing for the first time also installs the daemon as a user service -- a
  LaunchAgent on macOS, a systemd user unit on Linux -- so the machine is
  reachable after a restart without anybody logging in and running something.
  That is the case the service exists for: a machine you want to reach from a
  browser is a machine nobody is sitting at. Only on the first agreement, so
  `shell service uninstall` is not quietly undone by the next login; a machine
  that cannot install one still signs in and says what it could not do.
- A login on a machine that has a service installed now restarts the daemon
  through that service rather than spawning a detached one beside it.

### Fixed

- A session whose machine is rebooted or loses power now reaches Finished
  instead of sitting in Write for the relay's twelve-hour retention. Nothing
  used to close those sessions: the CLI reports an exit as its process ends,
  and a machine that dies never gets to. Three things now do. The machine
  closes them itself when it comes back up, having kept a note of what it left
  running. The relay says when it last held a host socket, so a machine that
  has been silent longer than any reconnect could take reads as "Machine gone"
  rather than merely offline -- and reads as live again by itself if it comes
  back. And a session the relay no longer has at all is written down as closed.
- A signed-in machine no longer drops to "offline" while nothing is wrong with
  it. What keeps a machine online is one thing -- the agent's poll, which the
  service dates -- and two situations stopped that poll. A renewal that failed
  stood the poll down for as long as the retry backoff, up to a minute, even
  though renewal begins a minute *before* the token expires and the token in
  hand was still good; the poll now continues while renewal retries on its own
  schedule, and a poll that succeeds clears the backoff rather than leaving the
  machine renewing on a minute's delay for the rest of its life. And a token
  the service refused was never renewed at all if the machine's own clock said
  it was still valid, so a skewed clock or a sign-in retired elsewhere left it
  presenting the same dead token every two seconds until somebody ran
  `shell login`. A refusal now renews whatever the clock says, and credentials
  that are genuinely finished say so and ask for `shell login` instead of going
  quiet.
- Session state stopped flickering. A card could alternate between "Offline"
  and "Status unavailable" every few seconds, and so between the Write and
  Finished columns, while nothing about the session changed: a relay check
  that was rate-limited, timed out, or landed on a worker with a cold cache
  overwrote a state the service already had with "unknown". A failed check is
  now a gap in knowledge rather than news, and no longer replaces what was
  last seen. Machines that are away are also no longer re-confirmed every five
  seconds, which used to spend the whole check budget and leave sessions nobody
  had looked at yet reading "Status unavailable" indefinitely.

## [0.16.2] — 2026-09-17

### Fixed

- Documentation now matches the ten-character generated password, the current
  80×40 mobile grid and 80×24 legacy fallback, the complete Linux architecture
  list, and the remote-start prompt shown on every interactive login. CLI help
  topic lists now come from one tested source.

## [0.16.1] — 2026-09-17

### Changed

- Shell Keep now leads with the state of the real work: active sessions and
  how many are fixing, building, or waiting appear before cosmetic progression.
  Selected sessions open in a stable edge panel with a direct route to the
  terminal, rather than a card that chases a moving figure. Pause and holdings
  menus use plain operational labels, fit without hiding the exit, and stack
  cleanly on narrow screens. First launch explains the session-to-world mapping
  before asking how the player should appear. Every session class and work
  state now has a tested visual marker.
- E2EE envelope v2 authenticates direction, sender stream, and sequence with a
  bounded replay window; read-only input is rejected again inside the CLI; and
  encrypted URL fragments can no longer be downgraded by relay metadata.

### Added

- A game skin over the web app, reached from a controller at the right of the
  top bar and left again through a pause screen whose last item returns to the
  session list. The Marches are ten holdings spread over open country, each one
  a rename of a part of the product: the Forge is where features are built, the
  Watch is where faults are met, the Chronicle is the audit log, the Vault
  holds session passwords the service cannot open. Live sessions are wrights
  standing in them, their class is the harness each one runs, and what they are
  doing is read from what the session is called. Click one to see where it is
  posted, which machine it came from and how long it has been out. Drag to
  move, wheel to zoom, and a road book in the pause menu rides you to any
  holding.

  Levels come from work that has already happened, counted by the service from
  your own sessions: how many ran and finished, on how many days, from how many
  machines. Marks come from levelling, and the pedlar sells cloth and dye and
  nothing that changes a number.

  The elixir vial shows what statistics gathering has cost, itemised by run and
  by machine. It is off until you turn it on, and the notice explaining what
  your machine would read — and what it never reads — is one press from the
  vial. The reading happens on your machine rather than on the service, because
  sessions are encrypted end to end and the service holds no key; `shell stats`
  prints exactly what would be sent, and sends nothing.

  It costs the session list nothing: the whole game is one lazily imported
  chunk, and the build fails if any of it reaches the bundle everybody else
  downloads. It honours reduced motion — on the map as well as in the
  interface — offers a safe-area inset for televisions, an interface-size
  slider and colourblind palettes, and is navigable with a keyboard or a pad
  throughout.

## [0.16.0] — 2026-09-15

### Changed

- Added optional standards-based OpenID Connect sign-in using Authorization
  Code with PKCE and provider discovery. Firebase remains the hosted default,
  including email, Google, registration and reset flows. A deployment selects
  OIDC only when both issuer and client id are present, and CI builds both
  modes to prevent either from regressing. OIDC account deletion asks the
  provider for a fresh sign-in, then removes everything shell.online holds;
  identity-provider account management remains with that provider.

### Added

- `shell --name <name> <command>` labels a session as it starts. The name
  appears on the start card, in `shell list`, and in the web app, and is kept
  when a persistent session restarts without one.
- `shell ls` lists the sessions in your account from every linked machine,
  with name, status, uptime, and machine. Ended sessions are counted and
  hidden unless `--all` is given; `--json` prints the full records without
  passwords.
- Sessions can be renamed from their page in the web app with the pencil next
  to the name, by the session's owner, its assignees, or a team admin. A blank
  name falls back to the command.
- A Download my data action on Account exports the signed-in account,
  membership, linked machines, owned or assigned sessions, and encrypted vault
  record as a local JSON file.
- Finished and relay-confirmed unavailable sessions can be cleaned up together
  from the session list after a second confirmation. Transiently offline
  sessions are kept. Filtered session results are paginated in the URL.

- A feedback form inside the web app. It opens from the account menu and the
  Account page, and from the moments where something can go wrong: starting a
  session, the session password gate, a session that ended, the vault setup
  and unlock screens, error notices, the empty sessions list, and the delete
  account form. Messages are kept by the service and, with `FEEDBACK_TO`
  set, forwarded by email. Nothing from a terminal is attached.
- The statistics dashboard counts people, not only events: unique, new and
  returning visitors, CLI machines, installers and viewers, from keyed hashes
  of address and browser family that never leave the Worker and are forgotten
  after 120 days. A funnel from a first look to a first browser keystroke says
  what each step counts, weekly cohorts show who came back, and the accounts
  app can add exact account counts and sign-up retention when the two are
  linked.
- Clicks on the landing page's Sign up free and Web app links are counted.
- The funnel gains "Copied an install command" from the landing page's copy
  buttons, and lists sessions created but never connected beside "Started a
  session". A named `utm_source` or `ref` on a landing link counts as the
  source when the browser hid the referrer, from a fixed list of names;
  visits from the web app are their own source.
- A session's first open records whether typing is allowed and how long the
  link waited; the first keystroke, how long after the open it came; a
  viewer's disconnect, how long they stayed. Browsers turned away by a full,
  expired or unknown session are counted by reason, and a viewer refused
  input in a read-only session once. The dashboard shows typed rate by
  device, who was turned away, and the typed share over sessions that allow
  typing.
- Machines running the installer or the CLI are keyed by address alone, so
  the dashboard can say how many machines that installed at least a week ago
  started a session within seven days. The privacy policy says so.
- Both install scripts send one word at their end, the outcome, and the
  binary name, so a platform that keeps failing gets noticed; nothing else
  goes with it, and `SHELL_ONLINE_INSTALL_REPORT=0` skips it. The dashboard
  shows how installs ended by the scripts' own account.
- The accounts app counts what accounts do, by day and by kind and nothing
  else: machines linked, sessions registered, commands sent, vaults created,
  invites sent and accepted, feedback sent. The dashboard shows them under
  Accounts as things done, not as distinct accounts.
- The statistics dashboard reads top to bottom as a story: what is live now,
  six headline figures each with its change against the period before, the
  funnel, then traffic, sessions, retention and accounts, each section opening
  with the finding in a sentence. Every figure about people leaves crawlers
  out and says so beside the step: page views by people, the installer run by
  curl or wget rather than read or crawled, installs completed on a person's
  machine. The raw totals stay in the ledger.

### Fixed

- Every member of a team can now read the audit log. A member who opened the
  copy of the team's audit key a teammate sealed for them re-sealed it to
  themselves by deleting it and adding it back, which the service refuses,
  because only a member holding a copy may store one. The copy is now replaced
  in one step, so it is no longer lost on the next check and the key reaches
  everyone, automatically, with nothing to paste.
- The vault on the Account page lists teammates still waiting for the audit
  key, and asks before sealing it to a teammate whose vault key has changed.
- The audit log says when a locked vault, or no vault at all, is what stands
  between the reader and the log, and offers to unlock it there.
- The session terminal is drawn directly on the app background, with no
  bordered panel, and its colors follow the light and dark themes. The
  renderer choice is a tab hanging from the tab line over the terminal's
  corner instead of a control inside the tab strip.
- Widened the vault password fields on the vault setup, unlock, and Account
  pages to twice their previous width, so a password is no longer typed into a
  box sized for the four-letter recovery-key confirmation.
- The web app, CLI, Refstream and platforms documentation pages were counted
  as "Not found". Every documentation route, current or versioned, now has its
  own page-view target; unknown paths the site answers with the landing page
  are counted apart from real 404s, and real 404s are counted at all.
- The statistics dashboard says since when people have been counted. Event
  counts run from the first event and people from the day the visitor salt was
  set, so a 30-day range could show thirty days of views beside one day of
  people. A people figure over fewer days than the count beside it now names
  that day, in the funnel, the headline tiles and the footer.
- Crawlers that identify themselves are no longer counted as people. The
  funnel said they were not, and they were.
- Deploying to production refuses a Wrangler config that serves a documentation
  page from the assets binding instead of the Worker, since such a page is
  never counted. Production served the web app, CLI, Refstream and platforms
  pages that way.

### Changed

- Prevented Mermaid labels from being clipped by waiting for fonts before
  layout and reserving consistent padding around every diagram node.
- Added responsive Mermaid diagrams to the principal documentation guides;
  desktop uses wide flows while phones receive compact top-to-bottom layouts.
- Added proper inner spacing to the landing page's live phone captures and made
  every Homebrew, standalone, and source-build command readable on mobile.
- Redrew the landing page phone frame with a titanium-style band, Dynamic
  Island, iOS status bar, physical side buttons and a home indicator.
- Added versioned Web app and Refstream alpha documentation pages, including
  machine linking, session state, personal-vault scope, renderer boundaries,
  persistent agent handoffs, backed files, and alpha fallback behavior.

## [0.15.1] — 2026-09-14

### Changed

- Made account deletion a visible danger-zone action while keeping the existing
  reauthentication and typed-email confirmation safeguards.
- Marked Refstream clearly as an unstable alpha when selected and replaced its
  translucent app chrome with an opaque terminal-native palette.
- Prevented historical terminal capability queries in a restored snapshot from
  being answered into the live process, which could corrupt tmux input.
- Updated the optional Refstream renderer to `v0.1.0-alpha.5` from its verified
  browser release. xterm.js remains the default.

## [0.15.0] — 2026-09-14

### Added

- Reusable Refstream agent connections. A connected agent can keep its handle
  for follow-ups, while task IDs, progress, and collected answers survive panel
  changes and reconnects.
- Tab-local Refstream session recovery for page reloads. Snapshots expire after
  four hours, disappear when the tab closes, and never go to the relay.

### Changed

- Updated the optional Refstream renderer to `v0.1.0-alpha.4` from its verified
  browser release. xterm.js remains the default.
- Clarified the lifetime, revocation, process-continuity, and privacy boundaries
  of agent handoffs in the README, website, app guide, and agent documentation.

## [0.14.1] — 2026-09-13

### Changed

- Updated terminal, platform, and standalone-relay runtime dependencies after
  their complete Windows, QEMU, container, and race-test matrices passed.
- Expanded the agent skill and machine-readable documentation with explicit
  file-root, encryption, Refstream, and scoped agent-invitation guidance.
- Kept all CodeQL phases on one version and grouped their future Dependabot
  updates so partial upgrades cannot break the analysis workflow.

## [0.14.0] — 2026-09-13

### Added

- Opt-in, rooted file access over the existing encrypted session WebSocket.
  Browsers can open a scoped file tree on demand, and Refstream mode turns
  filename-like terminal output into backed previews without granting access
  outside the CLI-selected root.
- A Refstream agent-connect surface with separately selectable read or control
  permission. Agents can read, search, wait, type, execute, and send terminal
  key combinations through a revocable, one-session invitation.

- A persisted terminal renderer dropdown in public shares and signed-in
  session tabs. xterm.js is the default; Refstream (alpha) can be selected without
  changing the process, relay protocol, encryption, or session permissions.
- Refstream mode now mounts its terminal-native find, command inspection,
  retained-output download, eight themes, text sizing, and back-to-live tools
  in both public shares and signed-in sessions.

## [0.13.0] — 2026-09-12

### Added

- An optional personal session vault that unlocks with a normal password, a
  supported WebAuthn PRF passkey, or the existing recovery key. Vault material
  remains encrypted in the browser and is never shared at team scope.
- Relay-backed session status in the accounts app, distinguishing online,
  starting, offline, finished, unavailable, and temporarily unknown sessions.
- Guided CLI help for the foreground agent, background daemon, and installed
  machine service, plus safer confirmation before an interactive `kill --all`.

### Changed

- Generated browser passwords are now ten Base64URL characters (60 random
  bits). The CLI still prints every password and says whether an encrypted copy
  was saved to the signed-in account's optional vault.
- Session filters, tables, boards, detail pages, vault counts, and remembered
  tabs use current relay state instead of treating every unclosed database row
  as online.
- Search and assignee pickers support arrow keys, Home, End, Enter, Escape, and
  reliable focus return. Sign-out and other asynchronous actions expose their
  in-progress state immediately.

### Fixed

- Clear browser input queued during encryption or backpressure when another
  collaborator takes the typing lock, preventing delayed input from leaking
  into their turn.
- Allocate real ephemeral ports in service boot tests so an unrelated local
  development server cannot make the suite fail.

### Security

- Vault unlock-method updates require a recent sign-in and compare-and-swap
  the current vault version without replacing the account encryption key.
- Bound and validate password KDF parameters, passkey counts, credential IDs,
  salts, labels, and ciphertext envelopes before the browser processes them.
- Relay liveness checks accept only valid session IDs, use only the configured
  relay origin, and are bounded by timeouts, caching, in-flight deduplication,
  and per-isolate request budgets.

## [0.12.2] — 2026-09-12

### Added

- A standalone, single-node relay for ordinary Docker hosts. It uses Node.js,
  WebSockets, local metadata state and Caddy-managed TLS, and requires no
  Cloudflare account or credentials.
- A versioned self-hosting documentation page and a release image at
  `ghcr.io/teoslayer/shell.online-relay` for amd64 and arm64.
- `shell password <ID>` retrieves an active session password from the local
  owner-only record. `shell password rotate <ID>` changes credentials without
  restarting the process and persists the new generation for stable sessions.

### Changed

- `--no-e2ee` output refers to the configured relay instead of assuming every
  deployment runs on Cloudflare.
- Session assignments and permission handoffs now update in place, without a
  reconnect or a window where the former writer can still send input.

### Fixed

- Keep `--auto-close today` valid throughout the final second of the local
  day, rather than expiring at the instant that second begins.
- Keep notifications, audit entries, session password shares, and member
  removal inside the active organization.
- Escape CLI login callback content, keep the mobile account menu usable, and
  reject invalid terminal dimensions before they reach a PTY.

### Security

- Password rotation switches the host cipher before disconnecting existing
  viewers, atomically replaces the owner's sealed account-vault copy, and
  removes stale teammate copies. The relay receives neither old nor new
  plaintext credentials.
- A verified browser cache can no longer overwrite a newer vault generation.
  Vault credentials are tried first and replace stale local cache entries only
  after successfully opening a live encrypted frame.
- Removing a team member now deletes every session-password copy sealed to
  that account. Owners must still rotate active sessions to revoke passwords a
  former member may already have seen.
- Targeted email invitations require a verified Firebase email. Team-key and
  session-key shares now reject invalid P-256 identities and oversized or
  malformed ciphertext, and key distributors must already hold the team key.
- The accounts app now sends a restrictive browser security policy from both
  its Node server and Cloudflare Worker deployment.

## [0.12.1] — 2026-09-12

### Added

- Vault management on the Account page: what the vault is, the session
  passwords it holds, and the team audit key it keeps. Only you can see
  what is in it.
- An end-to-end encrypted audit log. What is typed into a session from the
  browser is encrypted to your team's audit key before it leaves the browser,
  so every member of the team can read it and shell.online cannot.

### Changed

- Give the accounts app a clear primary position in the landing-page header
  and hero now that browser-started sessions are available.
- Searching and exporting the audit log run in the browser, on the decrypted
  entries.
- The service refuses unencrypted input entries for the audit log.

### Fixed

- Accept `--auto-close today`, which the CLI reference documents but which
  never worked: it meant midnight, so it had already passed whenever the
  command ran. It now means the end of today.
- Say that an unquoted `--auto-close` date has passed, instead of calling it
  invalid. `--auto-close=2020-01-01` already said so; `--auto-close 2020-01-01`
  reported a grammar error for a value it had understood perfectly well.
- The sign-up page said typed input was not recorded. It is recorded, now
  end-to-end encrypted for your team.

## [0.12.0] — 2026-09-11

### Added

- A session vault. Every session's password is sealed to your account, so it
  opens in any browser you unlock, including sessions started in a terminal.
  Setting one up is a one-time step that shows a recovery key; shell.online
  stores the vault sealed and cannot open it.
- `shell` seals each encrypted session's password to your vault when it
  registers the session, using the vault key the browser handed it at
  `shell login`, and will not seal to a key that has changed since.
- A privacy policy at `/privacy`, linked from sign-in, sign-up, the Terms and
  the Account page.
- Delete your account from the Account page. It removes your sign-in, your
  machines' tokens, your sessions, vault, comments and notifications; hands a
  team you own to its longest-standing admin, or member if there is none; and
  deletes the team when nobody else is in it.

### Changed

- Sessions started from the browser use 128-bit passwords, since nobody types
  them.
- Sharing a session seals its password to the colleague's vault rather than
  to one of their browsers, so it opens on every device they use. A colleague
  whose vault key changed is confirmed before anything is sealed to them.
- Signing out locks the vault in that browser.

### Fixed

- A stored password is no longer deleted when a frame fails to decrypt, which
  could lose a browser-started session for good.
- The browser's password cache drops the least recently used entry rather than
  the oldest written.
- Starting a session on a machine that cannot receive a password is refused,
  instead of producing a session nobody can open.
- The README's Homebrew command taps this repository and includes the one-time
  `brew trust` step Homebrew 6 asks for. It used to name a tap that does not
  exist.
- A request that cannot reach the service says so plainly, instead of "Could
  not reach the accounts service at . Is it running?", and an outage page from
  the edge no longer surfaces as a JSON parse error.
- The `shell login` approval page says what a linked machine shares with
  your team: the full command line, machine name, session name and timings,
  and what is typed from a browser. It used to say only the command name and
  timing were published.

## [0.11.3] — 2026-09-11

### Changed

- Keep the public site focused on the core flow, real use cases, and three
  installation paths; move deeper material into the versioned documentation.
- Make `shell help` a short guided overview while retaining the exhaustive
  `shell help reference`, and render `shell list` as readable cards in narrow
  terminals.
- Keep audit search visible, move secondary filters into one searchable
  disclosure, and collapse charts until they are requested.

### Fixed

- Keep every session action visible at ordinary laptop widths without making
  table rows taller, and make mobile pickers reliable bottom sheets.
- Open browser-started sessions as soon as they arrive, and make failed session
  or audit loads recoverable in place.
- Prevent mobile terminal header controls and documentation controls from
  colliding, and give touch controls dependable target sizes.
- Stop inline code from overlapping install checklist copy.

## [0.11.2] — 2026-09-10

### Added

- Document self-hosting for the relay and optional accounts app, with a
  credential-free Wrangler example.
- Assign a session to several teammates from the same dropdown. Each tick saves immediately, every assignee can type, and older clients still see the first assignee.
- Choose who can open a session when you start it. The password is generated and sealed to each person ticked, so nothing is typed and nobody is told a secret; people can be added afterwards from the session page.
- Offer the session you just started as soon as the machine publishes it, instead of leaving you to find its row.
- Pick a model for Claude Code and Codex sessions.
- Copy a session's link, password or attach command from the session page, not only from the list.

### Fixed

- Keep the Docker Compose image and embedded CLI version aligned with the
  repository release.
- Stop "Mark all read" blanking the inbox. The reply left out the roster the list is drawn from.
- Keep a session password that was typed once, so opening the same session again does not ask for it.
- Seal a session's password only to the people chosen for it. It went to the whole team, so every colleague could open every session and the choice was never offered.
- Say which person is the owner and which is the assignee on a phone, where the table stacks and its header is gone.
- Keep the terminal above the on-screen keyboard rather than behind it.
- Fix the top bar on a home-screen install, where the status bar inset was eaten out of the bar instead of added to it, and carry the wordmark and the account menu there.
- Read the audit log newest first, and call its chart "By user".
- Stop re-deriving every session's password on every poll, which is most of what the session list was doing on a phone.

### Added

- Keep the open session tabs across a reload. Refreshing the page put you back at the list with every terminal closed; the tabs that were open come back, on the one that was in front. Only the session ids are remembered, so a restored tab is rebuilt from the session list rather than from a stale copy, and a session that has since ended does not return.
- Offer GPT Codex's sandbox, approval, resume and web-search options in the new-session form, and Hermes Agent's command, session, model, worktree and approval options, each read from the installed tool rather than from its documentation.

### Fixed

- Draw a shared terminal at the size of the pane holding it. The font was scaled until the whole grid fitted in one direction, which on a wide pane left about a third of it empty and the text a third smaller than there was room for. The font now comes from the width, where the columns are, and the rows are spread down the full height with the leading that is left over; neither axis may overflow. On a 1440x900 window a 120x36 session goes from 11.5px filling 77% of the pane to 14.75px filling 98%.
- Remove the box drawn around each column of the session board. It repeated the border and the wash that every card inside it already carries, so three short columns read as three mostly empty containers.
- Stop building `codex --full-auto`, which current Codex releases reject as an unexpected argument. Starting a full-auto Codex session from the browser failed on the machine it was sent to.
- Drop the warning that a kind's flags came from a published interface. Every kind now offers only options its own `--help` accepts, so there is nothing left for it to warn about.

## [0.11.1] — 2026-09-08

### Added

- Read the session list as a board as well as a table. A toggle above the list switches between them and the choice is remembered; the board's three columns carry the action each one affords, and a search box matches a session's name or its command.
- Copy a session's link, its password, and its attach command from one menu, each with the warning that belongs to it.
- Remove a finished session from the list. The row, not the machine.

### Fixed

- Give a session started from the browser the icon of the program it is running. The command was handed to `sh -c`, so what the machine recorded was the shell; a command that has an argv is now run as one, and sessions already recorded are read correctly.
- Stop a session whose machine has re-linked since it started, instead of reporting that there is no such machine, and close the session when the stop completes so the list agrees with the machine.
- Stop rebuilding the terminal on every poll, which made a shared session slow to type into.
- Fail a build whose configuration is absent rather than only one whose configuration is empty. An absent variable produced a blank page in the browser with nothing in the console.

## [0.11.0] — 2026-09-08

### Added

- Ask on every interactive `shell login` whether the browser may start sessions here, with the previous answer as the default. `--allow-remote-start` remains a shortcut rather than the only way to reach the decision.
- Show the audit log again: the page, its route and the sidebar entry.
- Publish Go module discovery metadata so `go install shell.online/cmd/shell@latest` resolves from the canonical domain.

### Fixed

- Rescue a machine whose daemon can no longer renew its token. Signing in again replaces the running daemon instead of leaving it holding credentials it will never reload, a refused renewal re-reads the credentials file, and repeated refusals back off rather than repeating every two seconds.
- Read who may type from the session rather than from the tab it was opened in, so a colleague handed a session while watching it can type without reopening.
- Stop one test closing another test's file descriptor, which failed unrelated tests at random.
- Keep the background startup pipe private to shell.online so wrapped commands can safely use file descriptor 3.
- Make foreground relay connection attempts interruptible and print share details only after the relay is connected.
- Honor long `--auto-close` deadlines instead of silently reducing them to the relay's rolling 12-hour lease.
- Refuse a second local owner for an already-running persistent session without replacing its control socket or record.
- Preserve authenticated E2EE recovery snapshot opcodes during relay backpressure so large output cannot eject viewers to the password screen.
- Show compact, unclipped encryption badges in narrow mobile headers.
- Explain when all 16 viewer slots are occupied and keep retrying until a slot opens.
## [0.10.1] — 2026-09-08

### Fixed

- Render terminal QR codes with one color transition per row instead of one per module, eliminating visible repaint noise and reducing their ANSI payload by roughly an order of magnitude.
- Give every mobile terminal navigation key a full 44-pixel touch target with more legible labels.

## [0.10.0] — 2026-09-08

### Added

- Render a compact one-scan QR in interactive terminals after creating an encrypted share. The QR carries the URL and password entirely in its fragment, so it unlocks locally without exposing the password to Cloudflare; JSON, pipes, and non-interactive output remain unchanged.
- Add LLM-assisted issue intake, pull-request diff review, changelog suggestions, and generated GitHub release notes.
- Automatically delete unmistakably unrelated or spam issues and close equivalent pull requests only when two independent reviews agree at 98% confidence; preserve technical criticism and relevant but flawed contributions.
- Use GitHub's current Copilot inference path rather than the retired GitHub Models endpoint.

### Fixed

- Route every accounts-app asset response through its Worker security-header wrapper.
- Treat exhausted Copilot review quota as advisory instead of failing otherwise valid pull requests.
- Draw a terminal opened in the web app at the size the process is actually running at. The pane sized the emulator to its own pixels instead, so a 120-column session was drawn at around 110 columns and 24 of its 36 rows: every long line wrapped a second time and the bottom third of anything full-screen was missing. It now scales the type to fit the session's grid, the way the standalone viewer already did, and follows that grid when a phone joins or leaves the session.

## [0.9.0] — 2026-09-08

### Added

- Add `shell login`, which links a machine to an account from the terminal and returns to the web app. Sessions started with `shell` then appear there on their own.
- Add organizations. Signing up creates one; an invite link joins one. Everyone in an organization sees every member's sessions, each of which has an owner and an assignee.
- Add a web app that lists sessions from every linked machine and opens them as tabs you can type into, rather than as links out.
- Let a signed-in browser start and stop sessions on a linked machine, after that machine agrees to it once at `shell login`. The browser chooses the session password and seals it to a key the machine publishes, so the service relays an envelope it cannot open.
- Add session ownership, handoff history, comments, mentions, and notifications without copying terminal input into the accounts service.
- Detect which coding-agent harnesses a machine can run, so the web app offers the ones that are actually there.
- Add terms of service, accepted at sign-up.

### Fixed

- Scope remote-start consent to one account and accounts service, stop a stale
  daemon when that identity changes, and make single-use invite claims atomic.
- Remember which linked machine owns each session so Stop always targets that
  machine, and preserve quoting in browser-started commands through the native
  platform shell.
- Restrict CLI OAuth callbacks to literal IPv4 or IPv6 loopback addresses, so
  a local name-resolution override cannot receive an authorization code.
- Keep production infrastructure identifiers out of tracked Wrangler config,
  verify the pinned Cloud SQL proxy before execution, and compile the web app
  against the public relay rather than a development address.
- Point `shell login` at the deployment that serves it. The accounts address had never resolved, and the approval screen resolved to the marketing site, so either would have failed on the first release carrying the command.
- Update `golang.org/x/crypto` to a patched release. The Windows binaries linked its SSH package, reached through the PTY library, and so carried thirteen advisories including seven rated critical. No shell.online code path called into it, and the other platforms never linked it at all.

## [0.8.1] — 2026-09-04

### Fixed

- Build with Go 1.26.8 to avoid Go 1.27's MIPS64 `epoll` alignment regression, which could crash networked programs with `SIGBUS`.

### Added

- Execute the complete Go test suite under QEMU for all 15 Linux release artifacts, covering x86, ARM, MIPS, PowerPC, RISC-V, s390x, and LoongArch.
- Exercise real PTY creation, input, output, and terminal resizing in every emulated architecture family.
- Require the QEMU manifest to cover every Linux target in the authoritative release manifest.

## [0.8.0] — 2026-09-04

### Added

- Add native Windows ConPTY execution, detached background startup, owner-restricted local control, PowerShell installation, and working `list`, `attach`, and `kill` commands on x86, x64, and ARM64.
- Publish 36 checksummed binaries across macOS, Windows, Linux, FreeBSD, OpenBSD, NetBSD, DragonFly BSD, and Solaris, including ARMv5/6/7, big- and little-endian MIPS, PowerPC, RISC-V, s390x, and LoongArch targets for routers and small devices.
- Document ROS 1/ROS 2 usage and the complete supported-platform matrix in the README, versioned web knowledge base, install scripts, agent material, and built-in CLI help.

### Changed

- Make `--persistent <state-file>` portable to Windows so a background process can recover the same encrypted URL and password after a restart; the Docker restart policy continues to provide automatic recovery.
- Generate and verify every release artifact from one authoritative target manifest, and include Windows installer integrity metadata in the canonical SHA-256 bundle.

## [0.7.3] — 2026-09-02

### Fixed

- Suppress dead share URLs and impossible attach/kill instructions when a wrapped task exits during the startup handshake; report its real exit status instead.
- Parse spaced and unquoted multi-token `--auto-close` values deterministically, and return status 2 for missing or invalid values instead of executing them as commands.
- Require a deliberate second browser `Ctrl-D` within three seconds before sending an authenticated EOF frame; read-only sessions reject it.
- Make terminal sizing phone-aware and session-wide: 120×36 with desktop viewers, 80×24 while any phone is connected, with each transition ordered ahead of viewer input so typing handoff cannot resize one command late.

## [0.7.2] — 2026-09-02

- Match xterm's unused viewport area to the active terminal theme, removing the separate black rectangle beneath a fitted 80×24 screen on mobile.

## [0.7.1] — 2026-09-02

- Keep every shared process on one immutable 80×24 PTY grid so desktop, mobile, read-only, and local viewers cannot resize or deform one another's TUI.
- Fit that canonical grid independently in every browser, preserving personal zoom and mobile keyboard handling without changing the process dimensions.

## [0.7.0] — 2026-09-02

### Changed

- Make E2EE automatic for every new CLI share, with a cryptographically random eight-character browser password when `SHELL_ONLINE_E2EE_PASSWORD` is not set.
- Add an explicit `--no-e2ee` compatibility/debugging opt-out, label its Cloudflare plaintext trust boundary in CLI output, and reject conflicting password or persistence options.
- Include `e2ee_password` in structured session events so agents can give operators everything needed to open a share; keep `--e2ee` as a redundant compatibility flag.
- Refresh human CLI output with an animated connection state and a compact colored session card while keeping JSON and non-TTY output deterministic.
- Persist generated and configured browser passwords for stable CLI and Docker sessions, reuse them across restarts, and refuse mismatched replacement passwords rather than silently breaking an existing URL.

### Security

- Use password-derived AES-256-GCM keys for all new shares while continuing to expose the documented routing and traffic metadata to Cloudflare.
- Document the generated password's 48-bit entropy, recommend longer unique passwords for sensitive or long-lived work, and treat persistent state volumes as browser-password, host-credential, and decryption secrets.

## [0.6.2] — 2026-08-31

### Added

- Add a complete built-in CLI reference through `shell help reference`, covering commands, flags, environment variables, structured output, relay states, auto-close grammar, aliases, and exit status.
- Add the same full reference as a first-class, searchable, versioned documentation page rendered from the repository source.

## [0.6.1] — 2026-08-31

### Fixed

- Make `shell list` independently check each public relay session instead of equating a living local process with a working share link.
- Report relay state as online, reconnecting, expired, or temporarily unknown in the table and expose the raw `relay_status` in JSON without sending E2EE URL fragments.

## [0.6.0] — 2026-08-31

### Added

- Add optional `--e2ee` terminal-frame encryption with locally generated URL-fragment keys or separately shared passwords derived on each endpoint.
- Add a persistent multi-architecture GHCR Docker client with durable state and workspace volumes, an automatically generated browser password, one stable share URL across restarts, an SBOM, and build provenance.
- Add dedicated E2EE and Docker knowledge-base guides, cryptographic compatibility vectors, ciphertext tamper tests, persistent-state permission tests, and resume API coverage.

### Security

- Encrypt terminal input, output, snapshots, resize messages, and latency probes with AES-256-GCM while authenticating relay-visible frame opcodes.
- Keep random keys in URL fragments that are not sent to Cloudflare; password mode sends only a random salt and derives the key locally with PBKDF2-HMAC-SHA256.
- Store persistent host credentials and decryption material in owner-only state, reject overly broad file permissions, and bind relay resume to the saved host credential and immutable access/encryption mode.

### Changed

- Preserve persistent relay identity for up to 30 offline days while keeping ordinary task-bound session deletion unchanged.
- Document E2EE metadata exposure, bearer-link implications, replay/drop limitations, unrecoverable keys, and Docker volume trust boundaries without vague security claims.

## [0.5.0] — 2026-08-31

### Added

- Add a structured website knowledge base covering setup, mobile terminal behavior, reliability, and the precise security/trust model.
- Add bounded browser paste and render queues, snapshot recovery after output pressure, and explicit tests for iOS terminal-key anomalies and large paste framing.

### Changed

- Give exactly one browser deterministic ownership of PTY sizing; transfer it to an active collaborator and suspend browser sizing while a local terminal is attached.
- Keep PTY reads independent of relay speed, add WebSocket write deadlines, and recover slow or reconnected viewers from the CLI's bounded terminal snapshot.
- Expand README reliability guarantees and clearly document mobile, multi-viewer, lifecycle, high-output, reconnect, bearer-link, and Cloudflare trust behavior.

## [0.4.0] — 2026-08-27

### Added

- Add `shell --read-only <command>` for view-only browser links.
- Label read-only terminals in the browser and report access mode in CLI output, `shell list`, and JSON events.

### Security

- Store access mode as immutable session metadata and reject browser input for read-only sessions inside the Worker.

## [0.3.9] — 2026-08-24

### Added

- Add a source-building Homebrew formula directly to this repository. Brew fetches the tagged source and Go build dependency, compiles locally, and installs the result; after one-time tap trust, install, upgrade, or uninstall with the short `shell-online` formula name.
- Add real phone-form-factor Codex captures and clear Homebrew, standalone installer, and build-it-yourself paths to the landing page.

### Changed

- Harden the no-Homebrew installer with Rosetta detection, writable-path validation, actionable download and checksum errors, safer shell-profile guidance, and warnings when an older `shell` executable shadows the new installation.
- Track Homebrew command copies separately while preserving the existing privacy-limited analytics and stored statistics.
- Expand the landing page with eight practical terminal-sharing use cases, complete primary search and social metadata, linked Pilot Protocol attribution, visible crawlable fallback copy, and strict no-index handling outside the canonical homepage.

## [0.3.8] — 2026-08-22

### Security

- Build all release binaries with Go 1.27.0, eliminating standard-library vulnerabilities present in the previous toolchain.
- Add automated dependency auditing, govulncheck, CodeQL, secret scanning guidance, and least-privilege pinned CI actions.
- Document the bearer-link trust model and private vulnerability-reporting process.

### Added

- Publish deterministic SHA-256 manifests and machine-readable release metadata for every supported binary.
- Show the release version and checksum manifest from the landing page and terminal controls.
- Verify and print the selected binary's digest during installation.

## [0.3.7] — 2026-08-22

- Reject stale private background flags with a parent-bound startup handshake.
- Support safe Claude Code conversation handoffs through a forked process.

[0.6.2]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.2
[0.7.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.0
[0.7.1]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.1
[0.7.2]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.2
[0.7.3]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.7.3
[0.8.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.8.0
[0.8.1]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.8.1
[0.6.1]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.1
[0.5.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.5.0
[0.6.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.6.0
[0.4.0]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.4.0
[0.3.9]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.3.9
[0.3.8]: https://github.com/TeoSlayer/shell.online/releases/tag/v0.3.8
[0.3.7]: https://github.com/TeoSlayer/shell.online/commits/main
