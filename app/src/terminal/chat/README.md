# The chat renderer

A session read as a conversation: what this browser sends is a message, what
the process writes back is the reply to it.

It is a renderer, not a feature. `createTerminal` builds it in place of
xterm.js or Refstream, it satisfies the same `TerminalSurface` contract, and
the pane around it — the socket, the encryption, the password gate, the
permission checks, the audit log — is unchanged. Nothing about the session is
different; only what the bytes become on the way to the screen.

## Where the two halves of a conversation come from

They are known at different times, so they are taken from different places.

| Half | Source | Why not the other way |
|---|---|---|
| **Sent** | the line submitted in the composer | It is a fact here. Recovering it from the echo instead is guesswork the moment a program stops echoing, which every password prompt does. |
| **Received** | finished rows read out of a terminal emulator | The byte stream does not contain the answer. It contains the instructions for painting one. |

That second row is the whole design. It is tempting to strip escape codes out
of the stream and split on newlines, and it is wrong in at least five ways that
all show up in the first minute of real use:

- a progress bar redrawing with `\r` becomes two hundred near-identical lines
- a line longer than the terminal is wide is cut in half, with no newline to
  say it was not meant to be two lines
- anything that addresses the cursor rewrites rows you have already shown
- the shell echoes what was typed, so every command appears twice
- the prompt, with somebody's hostname and working directory in it, is output

So the bytes are parsed by a real emulator, and the conversation is read from
the grid that parse produces. All five stop being problems, because all five
are problems an emulator already solves.

## The emulator is free

`chat-terminal.ts` builds an `@xterm/xterm` `Terminal` and never calls
`open()` on it. Unopened, it has no renderer, no canvas and no DOM: it is the
parser and the buffer, which is exactly the part that knows what the process
meant. xterm is already the default renderer, so this adds no dependency and
nothing to the bundle.

## Which rows are finished

`screen-reader.ts`. Two rules:

**The cursor row is never released.** Whatever is on it is still being
written. A shell leaves its prompt there between commands, so the prompt falls
out of the conversation without a single rule about prompts. The one time the
prompt is released is the instant Enter is pressed, when it carries the command
with it — and that is the echo, which `transcript.ts` drops because the command
is already in the thread as the message that caused it.

**A wrapped line is released whole.** The emulator flags a row that continues
the row above it, so the pieces are joined back into the line the process
wrote rather than being cut at the terminal's width.

Where reading resumes is held by an emulator **marker**, not a row number. Row
numbers shift when scrollback fills and the oldest rows are dropped; a marker
is moved by the emulator, and reports itself disposed when the row it held was
dropped — which is the one case where output really was lost, and is shown in
the thread as a gap rather than silently skipped.

## The prompt

Two different things remove it, and both are exact rather than guessed.

Between commands the prompt sits on the cursor row, which is never released,
so it simply never arrives. At the moment Enter is pressed it *is* released,
carrying the command with it — and that line is dropped as the echo, because
the command is already in the thread as the message that caused it.

The remaining case is output that lands on the prompt row without a command:
a dev server logging while somebody sits at a prompt writes at the cursor, so
the row that is eventually released reads `~/work/api > listening on :8080`.
A shell publishing `OSC 133` markers says exactly where its prompt ends, so
the prompt is captured at the `B` marker and taken off the front of any line
that starts with it. Without markers the line is left alone: a guess here
deletes real output.

## Where one answer ends

`transcript.ts`, in preference order:

1. **The shell says so.** `OSC 133` command markers give the exact boundary and
   the exit status. From the first marker seen, the timing rule below is left
   alone entirely.
2. **The next thing is submitted.** A new command always ends the previous
   answer, whatever the clock says.
3. **The process goes quiet.** `IDLE_CLOSE_MS`, as a fallback for the shells
   that publish nothing.

## Full-screen programs

vim, `top`, an agent drawing its own interface. None of it is an utterance, and
slicing a repainting grid into bubbles produces nonsense. Entering the
alternate screen opens one card in the thread; the card mirrors that grid as
text for as long as the program runs, the composer forwards keys straight
through instead of composing lines, and the frame the program exited on is kept
in the conversation afterwards.

The mirror is read from the same parse everything else is read from, so it
cannot fall out of step with the session, and there is no second emulator.

## Phones

Four things are different below the phone breakpoint, and all four were bugs
before they were rules.

**The surface is the pane's screen element**, not a box of its own: the
renderer is handed that element to open into and marks it. So it inherits
`.pane-screen`, which aligns to `flex-start` because a terminal grid is
exactly as wide as its columns and must not be stretched. A conversation is
the opposite. Left on `flex-start` every child was shrink-to-fit and the
thread took its own 940px max line length as a width — fine by coincidence on
a desktop, two thirds off the right edge of a phone.

**The composer clears one thing at a time.** The bottom navigation bar when
the keyboard is down, the keyboard when it is up, never both. `--chat-dock`
holds the distance and transitions between them.

**The bar leaves when the keyboard arrives.** It is fixed to the window, so
it does not move for a keyboard: it stays underneath it, holding space the
thing being typed into cannot have. `keyboard-inset.ts` publishes
`--keyboard-inset` and `data-keyboard="open"` on the root, and `shell.css`
slides the bar out on that.

**The composer is 16px.** Safari on iOS zooms the whole page in when a
smaller field is focused and then leaves it zoomed, so a session became a
magnified corner of itself on every tap into the box.

Viewport units do not follow the root zoom the phone breakpoint applies, so
anything measured in `vh`/`dvh` down here divides by `--zoom`. `scripts/
test-mobile-controls.mjs` guards the touch targets, the 16px and the bar.

## The files

| File | What it does |
|---|---|
| `chat-terminal.ts` | The `TerminalSurface`. Owns the emulator, the reader, the transcript and the redraw schedule. |
| `screen-reader.ts` | Finished rows out of the grid, with their colours. Pure, apart from the emulator interface it reads. |
| `transcript.ts` | Rows and submissions into messages. No DOM, no emulator, no clock of its own. |
| `chat-view.ts` | The thread and the floating box. Renders by difference. |
| `keys.ts` | A key press into the bytes a terminal expects, and which control chips belong to which mode. |
| `preview.ts` | A scripted session, at `/chat-preview.html` under `npm run dev`. Development only. |

`transcript.ts`, `screen-reader.ts` and `keys.ts` are tested without a browser,
which is most of why they are separate from the two files that need one.
