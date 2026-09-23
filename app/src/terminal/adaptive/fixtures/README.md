# Captured sessions

Byte streams recorded from real programs through a pseudo-terminal at 120x36,
exactly as a viewer receives them. The layout tests replay them through the
same emulator the renderer uses, so a change to how a program draws itself
shows up as a failing test rather than as a broken screen on somebody's phone.

| Capture (`captures.ts`) | Program | Buffer |
|---|---|---|
| `claude` | Claude Code v2.1.280: one prompt, a tool call and a two-paragraph answer | alternate |
| `shell` | bash: `ls -la`, `git log`, a long line, a right-aligned line, colors, wide characters, a rule | normal |
| `vim` | vim with line numbers | alternate |

Claude Code breaks its own prose at the session's width, positioning each word
with `CSI n G` and each line with `CR CSI 2 C CSI 1 B`. The emulator's wrap
flag is never set on those rows, which is why `layout.ts` recovers paragraphs
from where a row ended rather than from the flag.

Re-capture when a program's interface changes. User names and host names were
replaced with `dev` and `dev@host`.
