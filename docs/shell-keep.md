# Shell Keep — the specification

The game skin over `app.shell.online`. This is the document the implementation
is held to: what things are, what they are renames of, and where each number on
screen comes from. When the code and this file disagree, one of them is a bug.

Implementation notes live next to the code (`app/src/game/README.md` records the
seams). This file is about *what the game is*, not how it is built.

---

## 1. The rule everything else follows

**Every thing in the game is a rename of something real, and every number is a
read-out of work that happened.**

Nothing can be earned by playing. There is no failure state, nothing decays
while you are away, no streak to break, and the shop sells only colour. A
garrison nobody can point at a feature for would drift into fantasy filler the
first time anybody edited it, and a bar that fills while you watch it is a bar
that is lying about your week.

---

## 2. The cast

| In the game | In the product | Source |
|---|---|---|
| **Hero** | A team member | `members` from `GET /api/sessions` |
| **Your hero** | You | `you` from `GET /api/sessions` |
| **Soldier** | A session | `sessions`, grouped by `ownerUid` |
| **Soldier's class** | The harness that session runs | `kindForCommand(session.command)` |
| **Camp** | That member's working area | Derived: placed from their `uid` |
| **The Unmade** | Faults being worked on | Sessions whose work reads as `bug` |
| **Holding** | A part of the product | Fixed; see §4 |
| **Marks** | — | Derived from level |
| **Elixir** | Tokens the gathering has spent | `game_collection_runs` |

### Heroes

One hero per team member. A hero is **not** a session; they exist whether or not
that member has anything running. Heroes are drawn considerably larger than
soldiers — they are the thing the map is about, and a hero the same size as
their own soldiers is a hero nobody can find.

Each hero holds a **camp**: a barracks, a banner in their colour, and the ground
around it. Camp positions are derived from the member's `uid`, so they are
stable across sessions and the same for everybody looking at the same team.

### Soldiers

A soldier is one session, and belongs to the hero who owns it. A member with ten
Claude Code sessions and three OpenClaw sessions has **thirteen soldiers of two
classes**, all of them theirs, all of them around their camp.

The class is the harness, and it is visible: each class has its own unit sprite
and its own sigil on the roster.

| Class | Harness | Sprite |
|---|---|---|
| Artificer | `claude-code` | `Unit_05` |
| Arcanist | `codex` | `Unit_01` |
| Herald | `hermes` | `Unit_11` |
| Beastmaster | `openclaw` | `Unit_07` |
| Footman | `terminal` | `Unit_17` |

Soldiers stay with their hero. They mill about the camp when the hero is still,
and follow when the hero moves — not in formation, which reads as a parade, but
loosely, arriving at their own pace.

### The Unmade

Faults, made visible. They come for a hero who has soldiers doing bug work, and
they come to **that hero's camp**. A team where nobody is fixing anything has a
quiet map, and that is the correct picture of a quiet day; it is also what makes
a loud one mean something.

---

## 3. Movement

**Point and click, as in an ARTS.** Left-click on the ground orders *your own*
hero to walk there. Their soldiers follow. Nobody else's hero can be ordered —
they move as their own soldiers' work dictates.

Clicking a figure inspects it instead of moving; the inspect panel is what tells
you which session a soldier is.

This is the one piece of the game that is not a read-out, and it is deliberately
the only one: walking your hero around changes nothing about your account. It is
there because a map you can only look at is a diagram.

---

## 4. The nine holdings

Fixed landmarks. They are the country's geography and its lore, and they are
where the roads go. They are *not* where soldiers are posted — that is the
hero's camp.

| Holding | Is a rename of |
|---|---|
| Prompt Keep | Your account, and the shell process behind it |
| The Relay | The relay. It carries your session and can read no part of it |
| The Forge | Sessions building a feature |
| Watchmen's Rise | Sessions fixing a fault |
| The Vault | Session passwords, sealed once per member |
| The Muster Yard | Your linked machines |
| Pedlar's Gate | The shop |
| The Chronicle | The audit log |
| Ravens' Roost | Your inbox |

The country is 128 tiles across and ends in old-growth forest, so that zooming
out shows a place with edges rather than a polygon in a void.

---

## 5. The shop

Cosmetic by construction, and a test asserts it stays that way. Two kinds of
thing:

- **Hero skins** — the colours your own hero is drawn in. Only your hero; you
  cannot reskin a colleague.
- **Retinue colours** — the wash over your own soldiers, so a team of several
  heroes reads as several companies.

Nothing sold makes anything stronger, faster or more valuable. Marks come from
levelling and levelling comes from work that already happened, so the shop is
downstream of the read-out and can never feed back into it.

---

## 6. Where the numbers come from

### Tier one — the service, from rows it already has

No new collection and no consent needed. `server/lib/game-stats.ts` counts the
caller's own sessions:

- sessions that ran and ended cleanly
- distinct days anything was started
- machines that answered the muster
- how many finished sessions read as mending, and how many as making

Experience is a fixed function of those. The browser adds none of it up.

**Nothing here reads a session.** Sessions are end-to-end encrypted; these are
counts of rows and the names people gave their own sessions.

### Tier two — the machine, by the agent, on request

Off until turned on, and one press turns it off again. `internal/stats` reads,
on the operator's own machine:

- git in the repository: commits, lines added and removed
- open pull requests, if the GitHub CLI is installed
- tokens the local coding agents have spent, from their own history files

What leaves the machine is six integers. There is no field for a branch name, a
commit message, a path, a diff or a line of output, and a test holds that shape.
`shell stats` prints exactly what would be sent and sends nothing.

The elixir vial shows the total; pressing it shows the itemised bill, by run and
by machine.

---

## 7. Plan: hooking the game to live data

Today the field runs on a stand-in garrison when the service cannot be reached,
and the HUD says so rather than pretending. The steps to make it live, in order,
each one useful on its own:

**7.1 — The roster.** `GET /api/sessions` already returns `{ sessions, members,
you }`. Poll it, build heroes from `members`, soldiers from `sessions` grouped by
`ownerUid ?? uid`, and mark your own hero from `you.uid`. *No server change.*

**7.2 — Camps.** Derive each camp from the member's `uid` — a stable hash to a
position in the open country, clear of holdings, roads and water. *No server
change, no storage.* A camp is not a thing to be saved; it is a fact about a uid.

**7.3 — Live work.** A soldier's work already comes from the session name and
command through `world/work.ts`, which the service shares. Sessions arriving and
leaving the roster muster and dismiss soldiers. *No server change.*

**7.4 — Acting on sessions from the field.** The inspect panel gains the actions
the session list has — stop, rename, hand off — calling the same functions in
`src/lib/api.ts` and reusing the same guards from `src/lib/session-view.ts`.
There must be no second source of truth for who may do what. *No server change.*

**7.5 — Starting a session from the keep.** "Muster a soldier" opens the same
`startSession` path the console uses, with the class picker standing in for the
harness choice. *No server change.*

**7.6 — What a colleague may see.** Heroes other than yours show their soldiers'
counts and classes, because the session list already shows those to the team.
They do **not** show anything the console would not. The rule is: if the
corporate view would not show it to you, the keep does not either.

**7.7 — Saving what is yours.** Already done: `game_profiles` holds the class,
the skin, what has been bought and spent, and whether the gathering is on.
Nothing about other members is stored by the game.

### What this plan deliberately does not do

- **No new session data.** Everything above uses rows the service already keeps.
- **No writing to the game from a browser that could lie.** Experience, marks and
  the elixir are all derived or agent-reported.
- **No second permission model.** Every action goes through the same guards as
  the console.

---

## 8. Accessibility and input

Held to the `game-ui-design` skill, enforced by `scripts/check-game-ui.mjs` in
`npm test`:

- 16px floor for body text, 24px for anything read in a hurry
- 44px minimum for anything that can be hit
- interface motion at or under 300ms, and **reduced motion reaches the canvas** —
  birds go, smoke holds still, dust stops
- a bounded z-index scale, a visible focus ring
- no physical button named anywhere except the one table that knows what the
  player is holding
- colour is never the only signal: every state carries an icon or a word
- a safe-area inset with a calibration target, an interface-size slider, and
  colourblind palettes

---

## 9. What it costs the corporate view

One lazily imported chunk, one icon and one route: **2.07 kB gzipped** measured
against a baseline build. `scripts/check-bundle.mjs` fails the build if any game
code reaches the entry bundle.
