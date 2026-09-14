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
reported draft or protected local activity. When the agent cannot verify emptiness, it must wait.
Multiline messages require the application's bracketed-paste mode.

An observed keystroke can move a cursor, accept a suggestion or edit a draft. It
does not prove which happened. Reads distinguish `input.state` (`empty`,
`occupied`, `unknown`), `input.content` and `input.protected`. Unverified local
activity stays protected, without claiming the application contains a draft.
`input.screen` adds a bounded cursor-line excerpt and color/dim runs, labeled
`display_only`. A gray line or text after the cursor is evidence to inspect,
never permission to type. Unknown does not mean "ask the owner to clear text."

For an unintegrated TUI, the owner can inspect the actual composer and choose
**I've checked: input is empty**. This calls
`session.confirmInputEmpty(session.input.revision)` without sending or deleting
text. Further input or output invalidates that one-time acknowledgement, which
reads as `verifiedBy: "owner"`. It cannot override a host-reported draft. A real
application integration uses the semantic reports below instead. Neither
reporting method is available to a visiting agent through the relay.

## Application and composer state

Hosts can report the actual application state to the library. This is an
integration API, not a terminal screen classifier. It requires a fresh sequence
and rejects unknown fields, including composer values or raw hook payloads.

```js
// Inside the host's synchronous application-state callback:
const sequence = session.sequence; // Capture before observing the application.
const composer = editor.value.length > 0 ? 'draft'
  : editor.suggestion ? 'suggestion'
  : editor.placeholder ? 'placeholder' : 'empty';
session.reportApplicationState({ status: 'ready', composer }, sequence);

// Application lifecycle callbacks, associated with the actual current handoff:
session.reportApplicationState({ status: 'authentication_required', taskId }, session.sequence);
session.reportApplicationState({ status: 'working', taskId }, session.sequence);
session.reportApplicationState({ status: 'answer_ready', taskId }, session.sequence);
// Only after the requested answer has actually arrived:
session.completeTask(taskId, finalAnswer);
```

Read the application's **real editor model**, not `terminal.textarea.value`.
The terminal textarea is a keyboard/IME sink, not the TUI's composer. Any typed
prefix counts as `draft`, even when an inline suggestion follows it. No composer
text is included in a report. Only report `placeholder` or `suggestion` when the
editable value is empty; both read as `input.state: "empty"`, `verifiedBy: "host"`.
They need no clearance button or `confirmEmptyInput` assertion.
Reports never grant agent ownership of a draft. A composer report arriving
between paste and Enter stops submission if it changes ownership, preserving
the task for inspection instead of retrying it. Hosts with synchronous editor
callbacks should observe state after the atomic input operation finishes.

A reported composer survives ordinary output/redraws. All terminal input and
IME composition invalidate it, as do reset, restore and a buffer change. The
integration must report every application/composer/context change and report
`{ status: 'unknown', composer: 'unknown' }` when it detaches. Apply backend
events in order and associate them with the correct process and task. For an
asynchronous observation, retain the sequence captured **before** the observation;
a rejected stale report needs a fresh observation, not a newly stamped sequence.

`read().application` supplies `status`, `source`, `revision` and optional `taskId`.
The default status is `unknown`; it is never inferred from output or silence.

| Application status | Agent behavior |
| --- | --- |
| `authentication_required` | Keep the connection; the owner signs in through the application. Agent writes pause. |
| `working` | Wait for progress; agent writes pause. |
| `answer_ready` | Retrieve the response for the associated task. It has not necessarily been collected or verified complete. |
| `input_required` | Inspect the current dialog; let the owner respond. New prompts are blocked. |
| `ready` | Inspect input readiness before a new request. |
| `unknown` | Inspect available evidence; do not invent an input or completion state. |

Meaningful reports wake `wait_task`, including composer recovery. Authentication
returns `next: "authenticate"`; an associated answer-ready report returns
`next: "inspect"` until an actual answer is retained. Reports never complete a
task by themselves. New asks clear previous lifecycle observations, and snapshots
do not restore live input authorization or application-state claims.

For Claude Code, documented hooks such as `UserPromptSubmit`, `Stop` and
`StopFailure` can inform a **host-owned** lifecycle adapter. They do not provide
the live editable composer value; a stop event also does not prove the requested
work was done. Do not forward raw hook payloads, transcripts or credentials to
the relay. Map only supported states through your existing trusted host
integration. The library does not install hooks or automatically identify every
Claude screen. See [Claude Code hooks](https://code.claude.com/docs/en/hooks).

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
