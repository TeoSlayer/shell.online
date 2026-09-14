# Documentation sources

`content.json` is the versioned website documentation. Tagged copies are loaded
for historical releases, so its `version` must match `package.json`.

The build renders every public documentation route from `web/documentation.html`.
Route behavior and navigation live in `shared/documentation.ts`; browser rendering
lives in `web/documentation.ts`.

Pages may attach Mermaid flowcharts through their `diagrams` array. Keep both the
wide `desktop` source and the compact `mobile` source semantically equivalent;
the documentation renderer switches at 720px and loads Mermaid only when a page
contains a diagram.

Repository guides that are not tied to a release live here too:

- `self-hosting.md`
- `third-party-notices.md`
