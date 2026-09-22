# Documentation sources

`content.json` is the versioned website documentation. Tagged copies are loaded
for historical releases, so its `version` must match `package.json`.

The build renders every public documentation route as complete HTML from
`web/documentation.html` and `shared/documentation-view.ts`. Reading, navigation
and selecting commands work without JavaScript. The lightweight docs entry adds
search, clipboard buttons and archived-version loading without the terminal app.

Route behavior and task-based navigation live in `shared/documentation.ts`;
browser controls live in `web/documentation.ts`. Keep each guide outcome-first:
what to do, what to expect, what to try when it fails, then technical reference.
Search stays in the browser and never sends queries to analytics. Copy events
use the fixed `docs_command` target, never command text. Historical card content
remains compatible; archived routes use a neutral shell until their content loads.

Historical pages may attach Mermaid flowcharts through their `diagrams` array. Keep both the
wide `desktop` source and the compact `mobile` source semantically equivalent;
the documentation renderer switches at 720px and loads Mermaid only when a page
contains a diagram.

For the browser gate, run Vite locally and then `node scripts/test-docs-browser.mjs`.
`DOCS_TEST_URL` can select another loopback preview. The gate checks all guides,
mobile sizing, section links, search and copy behavior. Screenshots stay outside
the repository. A diagram is optional; do not add one just to fill space.

Repository guides that are not tied to a release live here too:

- `self-hosting.md`
- `third-party-notices.md`
- `MCP.md`
- `session-content.md` (passive pulse and owner-encrypted excerpts, v0.22.0+)
- `analytics.md` (public-page events, attribution and measurement limits)
