# Shell Keep

The game skin over `app.shell.online`. Everything the game is lives in this
directory and in `src/styles/game.css`. Nothing else in the application knows
it exists, except at the handful of seams listed below.

## Why it is isolated

Two reasons, and the second is the one that bites.

**Cost.** The keep carries a renderer, a sprite atlas and a stylesheet of its
own. None of that belongs in the bundle somebody downloads to look at a list of
sessions, so it is reached through one dynamic import and travels in its own
chunk. `npm run verify:bundle` fails the build if any of it reaches the entry
bundle — it looks for `SHELL_KEEP_MARKER`, which the game writes onto the DOM.

**Blast radius.** A game is a large amount of code that no paying use of this
product depends on. Keeping it behind one import means it can be changed,
broken or removed without touching the console, and it means a reviewer can see
at a glance that a change to the keep cannot have changed how a session starts.

## The seams

Six, all of them small, all of them deliberate. If you are adding a seventh,
that is worth a conversation first.

| File | What it does |
|---|---|
| `src/App.tsx` | One lazy route at `/game`, and `SignedInApp` split out so the QA harness can mount the app under a stand-in identity |
| `src/components/AppShell.tsx` | The `LaunchGame` button at the right of the top bar |
| `src/styles/shell.css` | That button's styles, `.launch-game*` |
| `src/auth/AuthProvider.tsx` | `AuthContext` is exported so the QA harness can supply an identity. No guard changed |
| `src/lib/api.ts` | `request` is exported, so the game calls its own endpoints without a second copy of the token handling and the error sentences |
| `scripts/check-bundle.mjs` | The guard that keeps all of the above honest |

There is one seam the other way, and it is worth knowing about because it is
the only place the service reaches into the game:

| File | What it does |
|---|---|
| `src/game/world/work.ts` | Decides whether a session reads as mending or making. `server/lib/game-stats.ts` imports it |

It has no imports of its own, which is why it can be shared. The map walks a
wright to the garrison its work belongs to and the service counts the same
session towards the same column; two copies of those patterns would drift until
the map and the ladder disagreed about what a session was. It is reached only
from the game chunk and from the service, so it stays out of the corporate
bundle, and `check-bundle.mjs` still says so.

The game also owns a slice of the service, which is not a seam so much as its
own corner. Nothing else on the server reads any of it:

- `server/routes/game.ts` — the saved game, and what a browser may not set
- `server/lib/game-stats.ts` — what a level is worth, counted from sessions
- `server/routes/gathering.ts` — what a machine may report, and how hard it is believed
- `game_profiles` in migration 014, `game_collection_runs` in migration 015
- four methods on the `Store` interface

And a slice of the CLI, for the half of the gathering that has to happen where
the plaintext is:

- `internal/stats` — reads git, `gh` and the agents' own history files
- `cmd/shell/stats.go` — `shell stats`, which prints what would be sent and sends nothing
- the `"probe"` case in `cmd/shell/agent_loop.go`

Nothing in this directory imports from `src/routes`, and nothing outside it
imports from here except through the seams above.

## Layout

```
world/     the map, the projection, the simulation, the scatter, the border,
           and what the kingdom is asked to hold
pixi/      what gets drawn, and the camera: scene, actors, plates, ground, ambience
engine/    input, the focus grid, the fixed-step loop, the camera's limits
state/     options, progress, the shop, the roster, the shape of the screen,
           what is saved
ui/        the DOM interface over the canvas: HUD, menus, shop, the gathering
lore/      names, flavour, and the codex
```

Three of those files are arithmetic that more than one layer has to agree
about, which is why each of them is pure and tested on its own:

- `world/kingdom.ts` — how large a wave is, whether the garrison meets it, and
  how heavily the veil is drawn. The simulation, the HUD and the veil all read
  it; two copies would drift, and the way that would show is a screen washed in
  blood over a map with nothing on it.
- `engine/zoom.ts` — the camera's floor, ceiling, opening zoom and step. It was
  inline in the renderer, computed against a screen size that was wrong.
- `state/layout.ts` — which shape of screen this is. Not a media query: a
  handset held sideways is 844 pixels across and sails past every
  `width <= 640px` rule in the stylesheet.

**`world/` imports nothing from `pixi/`, and nothing from `pixi.js`.** That is
the rule the layout is for, and it is what lets a thousand ticks of the
simulation be run in a test and looked at -- which is how the shaking was found,
by counting direction reversals rather than by watching.

The projection lives in `world/iso.ts` for that reason. It was in `pixi/` at
first, which was wrong twice over: it is pure arithmetic about the shape of the
map with no Pixi in it, and once the border and the camps needed it, `world/`
was importing upwards out of the renderer while this file claimed it did not.

## MCP request flows

The keep shows what external MCP clients are asking this garrison to do, from
the game's own authenticated endpoint: `GET /api/game/mcp-flows` answers with
owner-scoped, short-lived lifecycle metadata — an opaque request id, the target
session, an allowlisted tool, `started` or `settled`, a timestamp, and on
`settled` a real outcome. The service has already filtered it to the signed-in
person and to sessions its own live devices are running; the game re-validates
every row strictly in `state/mcp-flows.ts` and drops anything malformed (a
non-v4 id, an unknown field, a tool or outcome outside the shared allowlists, a
`settled` row with no outcome, a `started` row that claims one), anything older
than the short TTL, and any target that is not a live session this account owns.
One call has one id: rows sharing a target and an id collapse to the most
settled, latest one.

What it deliberately does not claim is a source. The service cannot attest
which agent, if any, made a request, so the panel and the canvas show a neutral
"External MCP client" marker and arrows only to figures actually standing on
this field. There is no invented agent-to-agent edge, and an observation whose
target is not drawn draws nothing at all.

`Input delivered` means the terminal accepted the write, never that the agent
finished; cancellation, timeout, failure and uncertain delivery each read
differently. The panel empties on its own clock (`useExpiringMcpFlows`), so a
hung fetch can neither leave stale arrows nor wedge the field; the poll is
bounded, never stacks requests, and clears its observations on failure, on the
stand-in garrison, and the moment the signed-in account changes. Demo activity
is never shown as evidence of a real request.

Files: `state/mcp-flows.ts` (parser, expiry, labels), `state/use-garrison.ts`
(the poll and ownership scoping), `ui/McpFlows.tsx` (the panel),
`pixi/mcp-flows.ts` (the canvas layer). Covered by `state/mcp-flows.test.ts` and
`scripts/test-game-mcp-flows-ui.mjs`, which mounts the real panel, parser, poll
and pixi layer over a stubbed API in a real browser (Chrome and Safari).

## Running it

```sh
npm run dev
```

- `http://localhost:5173/qa.html` — **the whole app, signed in.** This is what
  to test: the route inside the product, the controller in the top bar, and the
  way back out to the session list. Calls to the service will fail, because the
  identity is a stand-in and the server checks a real token; those error states
  are worth seeing.
- `http://localhost:5173/game-preview.html` — the game on its own, for working
  on the artwork without the app around it.

Neither page is an input to `vite build`, which builds `index.html` and nothing
else, so both exist in development and in no deployment.

## Working on the art

Kenney's packs, all CC0, vendored into `public/game/` with provenance in
`docs/third-party-notices.md`. An earlier version of this drew everything as
palette-indexed text sprites, which was small and diffable and produced
structures nobody could identify; recognisable art was worth more than a clever
pipeline.

Two import scripts keep the vendoring honest rather than leaving mystery files
in the repository:

```sh
node scripts/import-kenney.mjs <pack-dir>       # the XML atlas, converted to Pixi's JSON
node scripts/import-fantasy-ui.mjs <pack-dir>   # the panel frames, recoloured to brass
```

The second one is three bytes and a checksum: the frames are 1-bit paletted, so
it rewrites the single palette entry that is not transparent and leaves every
pixel where Kenney drew it.

The map itself is not art. `world/marches.ts` is where the holdings, the roads
and the water are; `world/scatter.ts` decides where a tree may stand, and its
test is mostly about the three places one must never be — in a road, inside a
holding, or in the river — because each of those reads as a collision fault
rather than as scenery.

## The rules the game is held to

`scripts/check-game-ui.mjs` runs in `npm test` and enforces the
`game-ui-design` skill: a 16px floor for text, 44px for anything you can hit,
motion at or under 300ms, a bounded z-index scale, a visible focus ring, a
reduced-motion escape, and no physical button named anywhere except the one
table that knows what the player is holding.
