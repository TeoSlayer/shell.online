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
| **The Barrow** | Sessions that have closed | `game-stats` counts; see §4 |
| **Marks** | — | Derived from level |
| **Elixir** | Tokens the gathering has spent | `game_collection_runs` |

### Heroes

One hero per team member. A hero is **not** a session; they exist whether or not
that member has anything running, because a colleague with nothing open is still
on the team.

Heroes are drawn at **twice the size of a soldier**. At the same size they were
indistinguishable from their own retinue, which is the one thing on this map
that has to be legible at a glance.

Every hero commands **ground washed in their own colour** — an ellipse that
follows them, so a company reads as an area rather than a crowd. Yours is washed
stronger and rimmed brighter, and never colour alone: yours is also the one the
view opens on, the one the HUD names, and the only one that answers a click. The
colours are derived from the account id and assigned across the roster at once,
so no two collide and nobody is green, because the map is grass.

Above each hero: a **shield bearing their initials**, their name in brass, a
**health bar**, and a **mana bar**. On *your own* hero the board's rim, its
shield and its lettering are **turquoise**, and nothing else on the map is. The
ground wash already says which company is yours, but a wash is on the floor and
the board is where the eye goes; across a country with four companies on it,
this is what answers "which one am I". It is a second signal, not the only one. The mana bar is a read-out like everything
else — it is the share of that person's sessions doing something rather than
sitting at a prompt. Nothing consumes it and it cannot be spent; "mana" is the
skin's word for how much is in flight.

Each hero holds a **camp**: a barracks, a muster tent and a gate, with their
soldiers around it. Camp positions are *solved for* from the member's `uid`, not
stored — the same person gets the same ground on every machine for everybody
looking at the same team, so storing it would mean two places that could
disagree. They are assigned for the whole roster at once, because "no two
members share ground" is not a property a hash can promise one member at a time.

A hero's class is the harness they run most. Their own chosen class lives in
their own saved game, which no other account can read, and asking the service to
publish it would store a second fact that can disagree with the first. Your own
choice still wins for your own hero, because only your browser knows it.

### Soldiers

A soldier is one session, and belongs to the hero who owns it. A member with ten
Claude Code sessions and three OpenClaw sessions has **thirteen soldiers of two
classes**, all of them theirs, all of them around their camp.

Above each soldier: **its harness's own logo** on a brass-rimmed disc, and the
session's name. The logos are the ones in `public/icons/`, which is where the
session list gets them — a soldier *is* a session, so the mark over its head
should be the mark beside it in the console. Spelling the class out in words was
most of what was on screen at a camp of a dozen.

Every board above a head — hero or soldier — is visible at **every zoom**, and
**scales against the zoom**: it grows as the map shrinks, because zoomed out is
exactly when you need to find your own company and exactly when the figure under
the board is smallest.

Soldiers stay with their hero. They mill about the camp when the hero is still,
and follow when the hero moves — loosely, arriving at their own pace, because a
retinue in formation reads as a parade.

### The Unmade

Faults, made visible. They come for a hero who has soldiers doing bug work, and
they come to **that hero's camp**, in numbers, continuously. Each besieged camp
takes a share rather than one drawing the whole wave.

A team where nobody is fixing anything has a quiet map, and that is the correct
picture of a quiet day; it is also what makes a loud one mean something. Soldiers
doing feature work **visibly build** for the same reason — a map where only
broken things move would quietly teach everybody that only broken things count.

### The fallen

When a session closes, its soldier does not blink out. It turns for **the
Barrow** and walks there, and is taken off the field when it arrives. A session
ending is where experience comes from, and a figure that vanishes is the one way
of showing that which says nothing.

The Barrow's screen is the ledger behind the experience bar, written out: every
count, what each is worth, and the sum. A progress bar with no derivation behind
it is one you have to take on faith.

---

## 3. Movement

**Point and click, as in an ARTS.** Left-click on open ground orders *your own*
hero to walk there; their soldiers follow. Where they are sent becomes where they
hold, so they do not wander back to camp.

Nobody else's hero can be ordered. Marching a colleague around the map would be a
toy, and it would be the only thing in this game that changes what somebody else
sees.

Clicking a figure inspects it instead of moving — a hero or a soldier, not the
watch and not the Unmade. **The whole drawn body answers**, not the tile it
stands on: a figure rises well over a hundred pixels out of its own tile, so
testing in tile space meant only the feet were clickable and a click on the
chest asked about whatever field was behind them. Where two figures overlap,
the one drawn on top is the one that answers. **The card stands beside whoever was clicked and walks
with them**; every fact on it carries a mark as well as a word, and what it shows
depends on what was clicked: a hero shows the company they command, a soldier
shows whose company it is in. This is the one piece of the game that is not a
read-out, and deliberately the only one: walking your hero around changes nothing
about your account. It is there because a map you can only look at is a diagram.

The view opens on **your own hero** once the roster arrives, not on the Keep.

## 4. The ten holdings

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
| The Barrow | Sessions that have closed, and what they came to |

The country is 128 tiles across and ends in **old-growth forest**: a thicket of
oversized trees, boulders and the occasional ruin hugging the edge, and a baked
canopy carried far past the playable bounds so that zooming out shows a place
with edges rather than a polygon in a void. The treeline wanders in and out by a
couple of tiles, because a wood whose inner edge is a perfect straight line does
not hide a straight line — it draws a second one beside it.

### The roads, and what stands beside them

The lanes between holdings **bend**. Every road used to be a ruled line from
one gate to the next, and nine of them out of one Keep made a wheel with
spokes: a diagram of how the holdings connect rather than a picture of a
country somebody walks through. Each road now takes a bow whose size and
direction come out of its own two endpoints, with a small wander over the top
and a width that swells and narrows, and it is stamped as a disc per step so
the edge is ragged at the scale the ground is drawn at.

The line is worked out **once** and read by both the ground and the scatter's
clearance. They used to walk a straight line each, which agreed only because
identical expressions cannot disagree; a curve can, and the failure would be a
tree standing in the middle of a lane.

Beside the lanes: **fences** in runs along one side, **hay bales** in twos and
threes set back off the verge, and **lanterns**. None of the three is in any
art pack the game has, so all three are drawn — a fence is posts and rails
following the diamond grid, a bale is a cylinder on its side, a lantern is a
post with a light on it.

### Dusk

The map is lit for evening. Not one dark sheet over the picture, which dims
the thing you are looking at by exactly as much as the thing you are not, but
three tints by distance: the far wood deepest and coldest, the ground behind
it less so, the buildings and the people least of all. The tints are cold
rather than merely dark, because reducing every channel equally reads as
somebody turning the brightness down and pulling the red hardest reads as
evening.

What lifts it back is the lamps, and that is what makes them worth having
rather than ornaments: they are the only warm thing left out there. A lamp
casts a **pool on the ground**, under everything standing on it, because that
is where lamplight goes — drawn over the top it washes out the very figures it
is meant to be lighting. The pools are the one layer dusk is not applied to.

Each camp gets a pair of lamps at its gate, lit only while somebody holds it.
They are there for one job: the banners stand at that gate, and a banner
nobody can make out is a banner that does not say whose ground this is.

The flicker is a few percent of wander, each lamp on its own phase so a road
of them does not pulse in unison. Under reduced motion the lamps **hold at
full brightness rather than going out** — everything else that moves here is
ornament and is hidden outright, but a lamp is what makes the ground under it
legible, so the setting takes the movement and leaves the light.

### Landmarks and the imported art

The holdings carry a handful of pieces from a medieval art pack, placed on the
holdings they belong to rather than scattered: a **castle on Prompt Keep**,
because the Keep is the account itself and the middle of the map, and two
**siege engines at Watchmen's Rise**, where faults are met. A landmark that is
everywhere is scenery.

Each standing camp flies **two kinds of banner**: red flags for "a camp", and
one grey standard dyed to its holder's colour for "whose". The dye is the whole
reason the grey render is there — the flat red-on-gold flags cannot be tinted
to anybody's colours without going muddy, and grey takes a tint cleanly.

The pack is not vendored whole. It is roughly two hundred files, most of a
gigabyte of it in print-resolution renders, and the game uses about a dozen;
`scripts/import-kingdom.mjs` records exactly which files were taken and what
was done to each, so the choice can be revisited without anybody guessing.
Provenance is in `docs/third-party-notices.md`.

## 5. The shop

Cosmetic by construction, and a test asserts it stays that way. Two shelves,
because they are two different choices:

- **What you wear** — hero skins, the colours your own figure is drawn in. Some
  are cut for one class.
- **What your soldiers wear** — retinue liveries, washed over the soldiers that
  stand for your sessions, so a map with several companies reads as several
  companies. Never class-bound: a livery dresses a company of mixed classes.

Neither ever touches anybody else's figures. Nothing sold makes anything
stronger, faster or more valuable. Marks come from levelling and levelling comes
from work that already happened, so the shop is downstream of the read-out and
can never feed back into it.

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

**7.1 — The roster. Done.** `GET /api/sessions` returns `{ sessions, members,
you }`. It is polled every four seconds; heroes are built from `members`,
soldiers from `sessions` grouped by owner, and your own hero from `you.uid`. A
session with no recorded owner falls back to its assignee and then to the
viewer. *No server change was needed.*

**7.2 — Camps. Done.** Solved from the map, then assigned to members by hash
with probing so no two share ground. *No server change, no storage.*

**7.3 — Live work. Done.** A soldier's work comes from the session name and
command through `world/work.ts`, which the service shares. Sessions arriving and
leaving the roster muster and dismiss soldiers, and `setRoster` is idempotent so
the poll costs nothing when nothing has changed. *No server change.*

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

## 8. The interface

The HUD lives in the **corners**, not in a strip. Everything on it is glanced at
rather than read, and things that are glanced at belong at the edges of the eye:
who you are top left, what you have bottom left, who is out bottom right, pause
top right, the key prompt at the foot.

The names of places are lettered in **Pirata One** (SIL OFL, vendored), and
nothing else is. A whole interface in blackletter is one nobody can read in a
hurry; you stop walking to read a signpost, which is exactly the difference.

When the service cannot be reached the game shows an **example** team with an
example history, labelled as such in the HUD and in the Barrow. Without it the
map is visible and nothing the map is for is reachable: no finished sessions, no
experience, no marks, and a shop that will not open.

## 9. Accessibility and input

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

## 10. What it costs the corporate view

One lazily imported chunk, one icon and one route: **2.07 kB gzipped** measured
against a baseline build. `scripts/check-bundle.mjs` fails the build if any game
code reaches the entry bundle.
