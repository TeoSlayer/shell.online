# Persistent terminal handoffs

An invited agent uses its ordinary command tool to connect to an existing browser
terminal. The terminal keeps the handoff records; the connection carries requests
and responses. Collecting an answer does not disconnect it.

## Embed a session

```js
import { Terminal, getTerminalSession, getTerminalAgentAccess } from 'refstream.js';
import { attachTerminalTools } from 'refstream.js/ui';

const terminal = new Terminal();
terminal.open(container);
const session = getTerminalSession(terminal);
const tools = await attachTerminalTools({
  terminal, session, toolbar, overlay,
  ui: { toolbar: ['agent', 'menu'] },
});

tools.dispose(); // Removing the view leaves this session and its grant alive.
const state = getTerminalAgentAccess(session).state;
// getTerminalAgentAccess(session).revoke() immediately revokes access.
// terminal.dispose() ends the default session and revokes its grant.
```

The default UI also uses `getTerminalSession()` when no session is supplied.
Explicit `new TerminalSession(terminal)` instances can be supplied to the UI.
Labels, tooltips, toolbar placement and complete panel renderers remain
customizable through `TerminalUiOptions`.

## Connect once, reuse the connection

The owner chooses access and copies an invitation from the Agent panel. The copy
contains a standalone Node.js 22+ connector URL and its pinned SHA-256 checksum.
The agent verifies that file, runs `node shell-agent.mjs connect`, and passes the
private invitation on stdin or through the connector's hidden prompt. The private
invitation must never appear in command arguments, shell commands, URLs or logs.

`connect` returns **`sessionId`**, the connector handle. Use that same handle for
`request`, `status` and `stop`. Reads also contain **`terminalSessionId`**, a
different, stable identity belonging to the browser terminal. That identity is
metadata, not a connector handle or an authorization credential.

Each `node shell-agent.mjs request SESSION_ID` takes one JSON request on stdin.
`node shell-agent.mjs status SESSION_ID` resumes access to the current connection
and returns the screen, input guard and retained task summaries.

| Operation | Purpose |
| --- | --- |
| `read`, `tasks` | Inspect the current application and existing handoffs. |
| `ask` | Check the current input and submit one complete prompt with a stable task ID. |
| `read_task` | Retrieve a task, its retained result, current terminal state and next step. |
| `wait_task` | Wait for new task progress, with a bounded timeout. |
| `collect_task` | Retain partial output, or collect a completed answer. Leaves the connection open. |
| `cancel_task` | Explicitly abandon a handoff record. Does not interrupt the application. |

For example, after reading an empty marked shell prompt:

```json
{"method":"ask","args":{"kind":"command","prompt":"pwd","taskId":"workdir-1","expectedSequence":12}}
```

Wait using the returned task revision, then collect its result:

```json
{"method":"wait_task","args":{"taskId":"workdir-1","afterRevision":1,"timeoutMs":15000}}
```

```json
{"method":"collect_task","args":{"taskId":"workdir-1"}}
```

Use a new task ID for a new request. Retrying the same ID and prompt retrieves the
existing task without submitting it again. A new handoff is blocked until the
previous answer is collected or the task is explicitly abandoned. A read-only
grant permits reading and waiting, but cannot submit or change a handoff.

## Completion is explicit

The statuses are `waiting`, `needs_attention`, `completed`, `collected` and
`cancelled`. A sent receipt, output, silence, a redraw, and a background-job
acknowledgement do not establish completion. An attention revision is returned
once; subsequent waits can block for new progress rather than rapidly polling.

Every final result records where its completion claim came from:

- **`shell`**: an explicit OSC 133 completion boundary for this command. The exit
  code is retained; completion does not imply a zero exit code.
- **`host`**: the embedding application called `session.completeTask(taskId,
  answer)` after receiving an actual application completion event.
- **`agent_observed`**: the visiting agent read the final answer and explicitly
  reported it. This is an observation, not independent confirmation by the host.

A generic Claude or other TUI cannot be treated as a structured conversation API.
For such an application, `collect_task` without completion evidence stores an
unconfirmed screen excerpt and leaves the task pending. It may include earlier
context and is marked truncated. After observing the actual requested answer,
the agent can submit `answer`, `completion: "agent_observed"`, and
`expectedSequence` from a fresh read. The result retains that provenance.

Hosts with a real application integration can report completion directly:

```js
// In the host's actual application-completion callback:
session.completeTask(taskId, finalAnswer);
```

The connector's `stop` refuses to abandon a pending or uncollected handoff.
Keep the connection open for follow-ups. Disconnect only when requested. The
browser owner can always **Revoke access** immediately, including during work.
The explicit `stop SESSION_ID --force` form also permits an intentionally requested
disconnect with unfinished work. Neither action sends Ctrl+C or stops the shell.

## Draft protection

All remote input requires `expectedSequence` from a recent read. Local input is
tracked before PTY echo, including IME composition. Enter requires an agent-owned
draft; another person's intervening input removes that ownership. No draft is
cleared automatically. Prefer `ask` to separate typing and Enter calls.

For an unmarked application composer, `ask` requires `confirmEmptyInput: true`
unless the host has explicitly reported an empty composer. That assertion is for
an agent that inspected and verified the composer is empty. It cannot override a
detected local draft. When the agent cannot verify emptiness, it must wait.
Multiline messages require the application's bracketed-paste mode.

After clearing a draft in a generic application, the browser owner can use
**I've cleared my draft** in the Agent panel. This acknowledges input readiness
without sending or deleting any text. A host integration can instead call
`session.confirmInputEmpty(session.input.revision)` from its actual empty-composer
callback. Further input or output invalidates that assertion. Neither method is
available to the visiting agent through the relay.

## Persistence and privacy boundaries

- The connector survives ordinary command invocations, and the logical session
  survives UI remounts. The hosted grant lasts up to four hours; the single-use
  invitation expires after five minutes. The panel distinguishes those lifetimes.
- Task records and answers remain in the live terminal session after an agent
  disconnects. A fresh invitation to that same session can retrieve them without
  resubmitting the task. Used invitations cannot be replayed to reconnect.
- Snapshots retain the logical identity, tasks and terminal state, but never
  relay capabilities or connector credentials. Restored unfinished tasks require
  inspection. Restoring a snapshot does not restart a process.
- Page reload or process restart requires host-managed snapshot storage and a
  live PTY backend to restore a working shell or Claude session. The library does
  not silently persist terminal contents in browser storage or on the relay.
- History retains the last 32 task records, with answers bounded to 32,768
  characters. Expired task IDs remain reserved, including across snapshots, so
  an old retry cannot resubmit a command. A session stops accepting new task IDs
  after 4,096 retired IDs rather than forgetting those reservations.
- The relay sees encrypted payloads. Connector state on disk contains only its
  protected local IPC credentials, never terminal contents, answers or the private
  invitation. Host-saved snapshots contain private terminal data and need the
  same protection as the underlying session.
