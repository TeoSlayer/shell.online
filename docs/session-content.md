# Session content and pulse

Available from v0.22.0, these features have different sources and lifetimes: pulse describes
output observed by an open browser pane; encrypted excerpts reuse existing local
agent material for the session owner.

## Browser pulse

An already-open app terminal shows recent output, quiet or unobserved status,
new output in background tabs, and fixed hints for recognized context-limit,
input-request and test-result text patterns. A pattern match is a cue to inspect
the terminal, not confirmation that a process is idle, finished or successful.
Replay snapshots do not count as new activity.

Pulse processes only output the authorized viewer already receives and decrypts.
It creates no model calls, terminal input, network requests or subscriptions for
unopened sessions. Parsing is bounded. Its metadata lives in browser memory and
is cleared on disconnect, loss of access or closing the pane.

## Owner-encrypted excerpts

The first adapter supports an explicit resumed OpenCode launch, for example:

```sh
shell opencode --session ses_example
shell permissions <shell-session-id> --daily-briefing=true
```

Use the actual OpenCode conversation ID in the launch command and the shell.online
session ID in the permissions command. The owner can also enable daily-briefing
consent in the app, or use `shell briefings on --all` to set their default and
enable their existing sessions. An updated running host and an account vault
with a trusted, pinned public key are required. Upgrading the CLI does not update
or restart existing hosts.

The adapter reads the existing conversation title and the latest completed
assistant response with normal `stop` termination. It excludes errors, summary
messages, synthetic text, reasoning and tool output. It does not invoke OpenCode
or a model, send a prompt, or write to the process's terminal. A response excerpt
is not a generated session summary or a fresh completion assessment.

The binding is the explicitly resumed **launch conversation**. Switching to a
different conversation inside the OpenCode interface does not change it. New,
implicit/latest, forked and unsupported launch forms produce no excerpt. Titles
alone are not published while a qualifying response is unavailable.

The host needs `sqlite3` with JSON support and the compatible OpenCode database
at `$XDG_DATA_HOME/opencode/opencode.db`, or
`$HOME/.local/share/opencode/opencode.db` when `XDG_DATA_HOME` is unset. Reads use
SQLite's read-only mode, ignore user initialization files, and have bounded
output and a timeout. Missing tools, incompatible data or unsupported agents
leave the normal fallback title and empty excerpt.

Titles are capped at 120 characters and excerpts at 600, with control characters
removed. The host checks account policy about once a minute for supported
launches; it publishes at most once per rolling 24-hour window enforced by the
account service. Identical retry envelopes are idempotent. Revocation or key
changes create a new publication generation. This polling and upload traffic
is separate from the browser-only pulse.

## Access, storage and revocation

The host encrypts content to the owner's pinned account vault key. The service
stores a bounded `sc1.` ciphertext envelope separately from session registry
metadata. The originating linked machine and session owner must match before
publication is allowed. Legacy records without machine provenance cannot publish.
Content is never added to organization-wide session lists or the stored manual
name. The browser decrypts in memory after the owner unlocks their vault; manual
names take precedence over suggested titles, and excerpts carry their source date.

Daily-briefing consent controls extraction and publication. Team delivery is not
implemented: enabling `dailyBriefingTeamAccess` or `mcpTeamAccess` does not broaden
this owner-only delivery. Organization administrators, assignees and people who
can merely list a session do not receive its encrypted excerpt through this API.

Turning consent off purges stored content and invalidates its publication
generation; turning it back on also changes generation. Credential rotation,
session provenance/ownership changes and vault public-key or version resets
invalidate prior content. Rewrapping the same vault key does not. The browser
clears decrypted material when it observes vault lock or consent/access changes.
Revocation cannot recall content someone already read or copied.

The account service needs migration `020_session_content.sql` before using these
endpoints. Session deletion cascades to its content record. Memory and
PostgreSQL stores enforce the same owner and publication rules. No plaintext
fallback is used when the vault is missing, locked or changed.
