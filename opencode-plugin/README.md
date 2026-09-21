# Briefing adapter groundwork — runtime blocked

This is an inert development checkpoint, not a working automatic-briefing
feature. The OpenCode adapter does not start a poller, cannot submit a prompt,
and does not return an uncorrelated previous response as a generated briefing.
Installing this plugin does not enable automatic generation.

The reviewed OpenCode v1.18.30 runtime exposes status and `prompt_async`, but
does not atomically reject a prompt when its target conversation becomes busy.
The public TUI plugin API does not supply that missing operation. A separate
idle check followed by submission cannot safely preserve a human conversation.

## Diagnostic plugin

`shell-briefing-tui.mjs` observes the current TUI route and writes its conversation
ID to `shell.current_session` in the shared OpenCode KV store. It clears the
marker when leaving a conversation. The marker is not scoped to a shell host,
is shared by multiple TUIs, and may remain stale after process exit. It cannot
authorize submission; the disabled adapter does not consume it.

For an isolated development TUI only, the plugin entry belongs in `tui.json`,
not `opencode.json`: `"plugin": ["/absolute/path/shell-briefing-tui.mjs"]`.
No live-session installation or restart is required to preserve this checkpoint.
The plugin invokes no model and performs no terminal input.

## Requirements before activation

- An atomic runtime operation must validate the current TUI/run and idle
  revision, reject queued human work without creating a message, and enforce
  request expiry.
- Submission must return a durable operation/message receipt. Completion must
  be correlated to that exact parent message; cancellation must target only
  that operation, never a human turn.
- Conversation ownership and heartbeat must distinguish simultaneous TUIs.
  Durable claims must protect the same conversation across hosts and restarts.
- Passive excerpts and generated briefings need a shared publication scheduler
  and a distinct generated-content source/disclosure.
- A synthetic, no-model integration must prove the actual runtime boundary
  before any real conversation or provider is used.

The coordinator tests use synthetic adapters and local test servers. They cover
consent generation, conversation binding, rolling 24-hour limits, uncertain
dispatch, cancellation checks and sealed publication. Passing them does not
establish support in a real OpenCode runtime.

```sh
go test -race ./cmd/shell -run 'Briefing|OpenCodeContent|OpenCodeHTTP' -count=1
go vet ./cmd/shell
node --check opencode-plugin/shell-briefing-tui.mjs
```
