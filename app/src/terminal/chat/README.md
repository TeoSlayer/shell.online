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

## What a message is

A command's output is not one utterance. `git status` says which branch you
are on, then what is staged, then what is not, and a person reading that in a
chat reads three things.

`paragraphs.ts` decides where one stops. A blank line is the first rule: it is
the one separator every program agrees on and the one a person already reads
as a break. It is not the only rule, because a great deal of output has no
blank line in it anywhere -- a stack trace, an `npm ERR!` block, a help
screen, an agent's own notes -- and split on blank lines alone all of that
arrives as the single wall this renderer exists to replace. Two more rules
catch it, and both are about shape rather than content, because shape is what
the process controls deliberately:

- **Back to the margin.** A line at column zero after a run of indented ones
  is the next item in whatever list this is: the next error and its frames,
  the next command in a help screen. Safe in every output, because a table
  never changes indent halfway down and a wrapped sentence never un-indents.
- **A change of shape, confirmed.** Sentences followed by columns are two
  things, and no program reliably prints a blank line between them. The run
  being left has to be at least two lines of one kind, so one indented line
  inside a paragraph of prose does not cut it in half -- and so a table's own
  heading row, which is one prose-looking line above the columns, stays
  attached to its table.

The same predicate is used twice. `startsNewParagraph` answers it one line at
a time, which is what the transcript works with as output streams in;
`intoParagraphs` applies it to a finished block, and neither can drift from
the other because there is only one of it.

`paragraphs.ts` also decides how each message is shown: sentences wrap as text,
while anything whose spacing is load-bearing (columns, indentation, box
drawing) is kept exactly as written in a monospace block that scrolls. It is
the distinction every messaging application makes between a message and a
code block, and it is why a long sentence no longer runs off the side of a
phone while a table still lines up.

## Commands entered elsewhere

The conversation is not only this browser's. Somebody typing on the machine
itself, or in another browser watching the same session, should appear in it.

Between the shell's `B` marker (prompt end) and its `C` marker (the command is
running), anything written onto the prompt row is a command. One sent from
here is recognised as its own echo and is already in the thread; anything else
becomes a message from the other side. Without markers there is no safe way to
tell a command from a log line that landed on the prompt, so only local
commands appear — and nothing is invented.

## Sending

Three things went wrong between pressing send and the command arriving, and
all three looked like the session rather than like the box.

**The line and the Return have to be two events.** They were one chunk,
`text\r`, and a program that reads its own input -- which every agent here
does -- treats a burst of characters ending in a carriage return as pasted
text and deliberately does not submit on it, because pasting a paragraph that
happens to contain a newline must not send half of it. So the prompt arrived
in the agent's box and stayed there: a send button that does nothing. The text
goes first, marked as a paste where the program asked for pastes to be marked,
and the Return follows a frame later on its own. They are queued rather than
timed separately, because a paste is several lines and each of them is a line
and a Return.

**The return key did nothing, sometimes.** A phone's keyboard with predictive
text on does not say which key was pressed: iOS reports every keydown as the
composition placeholder, keyCode 229 with key `Unidentified`, Return included.
The rule that sends on Return therefore never fired, the command stayed in the
box, and trying again usually worked because the prediction had settled by
then -- which is exactly what makes a bug feel like an unreliable network. So
the box also listens for `beforeinput`, which says what the browser is about
to do rather than which key asked for it. "Insert a line break" is the one
thing a box that sends on Return must not do. Every engine fires it, the
keydown rule cancels it first on a desktop, and what is left is precisely the
case the keydown rule could not see.

**What was typed appeared twice.** Once as the message, and again inside the
answer under it. The echo of a command is dropped on the way in, and the
commands waiting for their echo used to be tried oldest first and only oldest.
One command that never echoes -- a password, a line a program read and
swallowed -- then sat at the head of that queue for forty lines, and for those
forty lines every real echo was compared against the wrong command, failed,
and arrived as output. Every pending command is tried now, and a match retires
the ones in front of it, because they were sent earlier and their echo cannot
still be coming.

## Agents

Almost no session on this product is a shell. They are coding agents, and an
agent does not print lines: it takes the alternate screen and draws an
interface on it, so everything above -- which is about reading finished rows
out of a scrolling buffer -- does not apply to the case that actually happens.

Mirroring that grid does not work on a phone, and not for a reason a
stylesheet can fix: the session's grid is eighty columns, it is shared with
every other viewer so it cannot be reflowed, and eighty columns across a phone
is under five pixels a character. The only way to put an agent on a phone is
to stop showing it as a grid, which means reading it.

**Read it from a captured frame, or do not read it at all.** The first version
of this was written against a screen somebody imagined, and every detail was
wrong: the real Claude Code draws nothing in a box, its prompt marker is `❯`
rather than `>`, `⏺` is the agent speaking rather than a tool it ran, and its
status lines sit *below* the composer rather than above it. An adapter built
on a guess recognises nothing, and recognising nothing puts the raw grid back
on the phone. `fixtures/` holds frames captured from the program with a
pseudo-terminal and replayed through the same emulator the renderer uses, so
what the tests read is exactly what the adapter is handed. Re-capture them
when the interface changes; the tests are the warning that it has.

`stream.ts` turns a screen that is repainted into a log that is appended to.
Each frame is compared against what has already been given out, and the longest
tail of that which is also the head of this frame is what they have in common;
everything after it is new. One rule covers a screen that has not moved, one
that has scrolled, and one that has started again. The last row is never given
out because it is the row being written, and `flush` exists for the row a
program *finished* on, which looks identical and differs only in that no frame
follows it.

`claude-code.ts` reads the real shape. Everything from the composer down is
dropped by position, because what is between those rules is a line somebody is
part-way through typing. `❯` is a prompt somebody sent. `⏺` is the agent
speaking, and what follows it, indented, is the rest of what it said. An
indented line *before* the agent has spoken in a turn is a tool and the one
line it reported -- the two look identical and only their position tells them
apart. Blank lines cut the rest into messages, the same rule the line-oriented
half applies, so an agent listing a directory says what it found, then the
directories, then the pipes, then the sockets, and a person reads five things
rather than one. Prose is put back together after the terminal broke it at
eighty columns; a block whose spacing carries meaning is left as written.

**Recognising the program** is its own problem, and the obvious answers are
both wrong. Its name is in a header that scrolls away after a few exchanges,
so a session has no name on screen exactly when it has a conversation worth
reading. Its window title is not its name for long either: it becomes a
summary of the work, so a session asked to list a directory reported
`✳ List directory files`. What is stable is the glyph in front of that title,
with the two markers together as the fallback for a terminal that reports no
title. And it is asked on every frame until something answers, not once on the
first -- the first frame after a program takes the screen is the one least
likely to identify it.

There is one adapter. There were four: the other three were written against
the shape those programs were assumed to share, and capturing a real screen
showed the shape was invented. They are gone rather than shipping as reading
somebody's screen wrongly. Codex needs none in any case -- it draws on the
normal buffer rather than taking the alternate screen, so its output arrives
as lines and is cut into messages by `paragraphs.ts` like a shell's.

A program no adapter claims is still mirrored as a grid, sized so the
session's whole width is on the screen wherever that is possible at a legible
size.

## Sending

Three things went wrong between pressing send and the command arriving, and
all three looked like the session rather than like the box.

**The line and the Return have to be two events.** They were one chunk,
`text\r`, and a program that reads its own input -- which every agent here
does -- treats a burst of characters ending in a carriage return as pasted
text and deliberately does not submit on it, because pasting a paragraph that
happens to contain a newline must not send half of it. So the prompt arrived
in the agent's box and stayed there: a send button that does nothing. The text
goes first, marked as a paste where the program asked for pastes to be marked,
and the Return follows a frame later on its own. They are queued rather than
timed separately, because a paste is several lines and each of them is a line
and a Return.

**The return key did nothing, sometimes.** A phone's keyboard with predictive
text on does not say which key was pressed: iOS reports every keydown as the
composition placeholder, keyCode 229 with key `Unidentified`, Return included.
The rule that sends on Return therefore never fired, the command stayed in the
box, and trying again usually worked because the prediction had settled by
then -- which is exactly what makes a bug feel like an unreliable network. So
the box also listens for `beforeinput`, which says what the browser is about
to do rather than which key asked for it. "Insert a line break" is the one
thing a box that sends on Return must not do. Every engine fires it, the
keydown rule cancels it first on a desktop, and what is left is precisely the
case the keydown rule could not see.

**What was typed appeared twice.** Once as the message, and again inside the
answer under it. The echo of a command is dropped on the way in, and the
commands waiting for their echo used to be tried oldest first and only oldest.
One command that never echoes -- a password, a line a program read and
swallowed -- then sat at the head of that queue for forty lines, and for those
forty lines every real echo was compared against the wrong command, failed,
and arrived as output. Every pending command is tried now, and a match retires
the ones in front of it, because they were sent earlier and their echo cannot
still be coming.

## Agents

Almost no session on this product is a shell. They are coding agents -- Claude
Code, Codex, Hermes, OpenClaw -- and an agent does not print lines. It takes
the alternate screen and draws an interface on it, so everything above, which
is about reading finished rows out of a scrolling buffer, does not apply to
the case that actually happens.

For a long time the answer was to mirror that grid in a card. On a phone that
is unreadable, and not for a reason a stylesheet can fix: the session's grid is
eighty columns wide and shared with every other viewer, so it cannot be
reflowed, and eighty columns across a phone is under five pixels a character.
The only way to put an agent on a phone is to stop showing it as a grid, which
means reading it.

`agents/` is that reading, in three parts.

`stream.ts` turns a screen that is repainted into a log that is appended to.
Each frame is compared against what has already been given out, and the longest
tail of that which is also the head of this frame is what they have in common;
everything after it is new. One rule covers a screen that has not moved, a
screen that has scrolled, and a screen that has started again. The last row of
a frame is never given out, because it is the row being written -- and `flush`
exists for the row a program *finished* on, which looks identical and is only
distinguishable by the fact that no frame follows it.

`boxed-agent.ts` is the shape these interfaces share: a header box, prompts
marked `>`, tool calls marked with a bullet and their result indented under
them, prose, and the box you type into at the foot. Everything a border is
drawn around is furniture and is dropped; the last box on the screen is
dropped by position, because what is inside it is a line somebody is part-way
through typing. Prose is put back together after the terminal broke it at
eighty columns -- a row that ran to the edge is a continuation, a row that
stopped short of it stopped on purpose -- so it reflows to the phone instead
of keeping a ragged edge across the middle of it. A block whose spacing is
carrying meaning is left exactly as it was.

`known.ts` says which agent each adapter is for, and how sure it is. Claude
Code was written against its screen. The other three were written against the
shared shape and not against a captured frame of their own, and that is
recorded rather than left to be discovered: the conversation says so in its
first line, and the renderer menu on the pane is the way back to the screen
itself.

Every adapter is gated on its own program's name, because the shape cannot
tell them apart and must not be asked to. A line the shape does not recognise
is prose, which is the failure worth having: an agent laid out differently is
read as its own text, wrapped to the phone. What is lost is the structure.
Nothing that was on the screen is lost.

A program no adapter claims -- an editor, a pager, `top` -- is still mirrored
as a grid, and the grid is now sized so the session's whole width is on the
screen wherever that is possible at a legible size. On a phone eighty columns
is not, so it keeps a legible size and scrolls sideways; on a tablet it fits.

## Phones

Everything here was a bug before it was a rule.

**The viewport is measured, not asked for.** The shell is `--app-height` less
`--keyboard-inset` (see `lib/app-height.ts`), because `100dvh` is not the same
number on every engine or at every moment. That arithmetic is the shell's
rather than this renderer's; what matters here is that a phone's visible area
*moves* -- a keyboard covers it, a browser toolbar slides in and out of it --
and a desktop browser's never does, so a layout bug that only exists while it
moves cannot be seen in a desktop browser at all. One shipped that way: the bar
settled a hundred and eighty pixels up the screen and swept that distance
whenever anybody scrolled, and a static page measured on a desktop said the
layout was correct, because for the one frame it was. `viewport-theatre.ts`
replaces `window.visualViewport` in the preview with one that can be driven, so
a toolbar and a keyboard are both reproducible here. The measurements are also
coalesced to one write a frame and skipped when the answer has not moved a
pixel, because a browser reports the viewport in fractional pixels and reports
it often.

**A session is one screen tall and does not scroll.** Every other page on a
phone is a document -- a list of sessions, an audit log, a settings sheet --
and the page carries it. A session is not: it has one thing that scrolls, the
conversation, and a box at the foot of the screen that is typed into. While
the page could also move, the box was wherever the page had been left rather
than under the thumb.

So `keyboard-inset.ts` marks the root `data-pane="open"` while a pane is the
page, and `shell.css` turns the shell into a column exactly one screen tall,
less whatever the keyboard is covering. The bottom bar is a row of that column
rather than something fixed on top of it, and the pane is the row that takes
what is left. **Nothing measures a height.** It used to: the pane was given
one worked out in JavaScript from where its top edge was, taken once, and
stale from the next layout onwards -- a tab line wrapping or a notice
appearing above it left the conversation in a short box in the middle of the
screen with a strip of dead page underneath. A flex row is the same answer,
recomputed by the browser on every layout.

**The composer sits on the foot of the pane, and that is the foot of the
screen.** `--chat-dock` is 8px and does not change, because the pane's own
foot is the top of the bar -- or the top of the keyboard, once the keyboard
has taken the bar away. There is exactly one place the clearance is decided.
There used to be two, and the two added up: a composer a bar's height above a
pane that had already stopped a bar's height above the screen.

**A session does not change size for a keyboard.** It is the one thing on a
phone that must not: the terminal inside it is a grid of a fixed number of
columns, so a pane that shrinks refits that grid to a smaller font -- text
that shrinks as you start typing, and a strip of blank screen where the grid
no longer reaches -- and the refit coming back is a bar that arrives a
centimetre from where it left. So `--visible-height` is measured while the
keyboard is down and held while it is up, and the keyboard simply covers the
foot of the session. What rises is the composer, by exactly `--keyboard-inset`,
with the thread making the same room under itself. The bar stays where it is,
behind the keyboard, because taking it out of the layout would resize the pane
for no reason anybody can see.

**The bar leaves when the keyboard arrives, on every page but a session.** A
document page does shrink to the space above the keyboard, so its bar has to
leave or it would be underneath one. `keyboard-inset.ts` publishes
`--keyboard-inset` and `data-keyboard="open"` on the root, and `shell.css`
takes the bar's row out on that -- except where a pane is open, for the reason
above.

**The composer is docked with a transform**, not with `bottom`. The dock used
to animate as a layout property, which re-laid out the thread behind it on
every frame of the keyboard arriving. A transform is composited and moves
nothing else.

**A full-screen program still composes a line.** Direct mode forwards each key
as it is pressed, which is right on a keyboard and was the worst thing in this
renderer on a phone: the box stayed empty while what you typed was painted
into the program's own input box, somewhere inside a grid that does not fit
the screen. You typed a prompt to an agent and could not see it. A touch
screen composes and sends a line; what it gives up is the arrow keys, which a
phone keyboard does not have.

**The composer is a bar across the foot of the surface**, not a card floating
inside it. It floated with eighteen pixels of page either side of the pane and
another eight inside that, so its background stopped well short of both edges
and the conversation showed past it -- a blurred panel cut off down both
sides. The surface is full-bleed now and the composer goes with it; what is
rounded is the field inside it, where a rounded thing belongs.

**There are no buttons in it.** A row of control-key chips used to stand above
the box: on a phone it was half the composer's height, at all times, for
controls wanted twice a session. A keyboard has the keys themselves. What a
touch screen has lost with them is any way to interrupt a running program, and
that wants somewhere of its own rather than a row inside the thing you type
into.

**The field is 16px and cannot be smaller.** Safari on iOS zooms the whole
page in when a field under that is focused and then leaves it zoomed. What can
come down is everything around the text, and has: the leading, the padding,
and the row of chips that is gone.

**Nothing zooms the session by accident.** The composer is 16px wherever there
is a coarse pointer, because Safari on iOS zooms the whole page in when a
smaller field is focused and then leaves it zoomed. The composer refuses
double-tap zoom. The two blocks wide enough to be swiped sideways -- a
preformatted listing, and a full-screen program's mirror -- allow panning and
refuse pinch, so a swipe along a table is not read as a pinch on the page.

**The surface is the pane's screen element**, not a box of its own: the
renderer is handed that element to open into and marks it. So it inherits
`.pane-screen`, which aligns to `flex-start` because a terminal grid is
exactly as wide as its columns and must not be stretched. A conversation is
the opposite. Left on `flex-start` every child was shrink-to-fit and the
thread took its own 940px max line length as a width -- fine by coincidence on
a desktop, two thirds off the right edge of a phone.

Viewport units do not follow the root zoom the phone breakpoint applies, so
anything measured in `vh`/`dvh` down here divides by `--zoom`. `scripts/
test-mobile-controls.mjs` guards the touch targets, the 16px, the zoom
refusals, the column and the bar.

## The files

| File | What it does |
|---|---|
| `chat-terminal.ts` | The `TerminalSurface`. Owns the emulator, the reader, the transcript and the redraw schedule. |
| `screen-reader.ts` | Finished rows out of the grid, with their colours. Pure, apart from the emulator interface it reads. |
| `paragraphs.ts` | Where one message stops and the next starts, and how each is shown. Pure. |
| `transcript.ts` | Rows and submissions into messages. No DOM, no emulator, no clock of its own. |
| `chat-view.ts` | The thread and the box at the foot of it. Renders by difference. |
| `keys.ts` | A key press into the bytes a terminal expects, and which control chips belong to which mode. |
| `agents/stream.ts` | A repainted screen as a log that is appended to. Pure. |
| `agents/claude-code.ts` | Claude Code's screen, read as utterances. Written against captured frames. Pure. |
| `agents/fixtures/` | Frames captured from the programs themselves. |
| `preview.ts` | A scripted session, at `/chat-preview.html` under `npm run dev`. Development only. |
| `viewport-theatre.ts` | A phone's viewport, driveable from a desktop. Development only. |

`transcript.ts`, `paragraphs.ts`, `screen-reader.ts` and `keys.ts` are tested
without a browser, which is most of why they are separate from the two files
that need one.
