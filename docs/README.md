# Documentation sources

`content.json` is the versioned website documentation. Tagged copies are loaded
for historical releases, so its `version` must match `package.json`.

The build renders every public documentation route from `web/documentation.html`.
Route behavior and navigation live in `shared/documentation.ts`; browser rendering
lives in `web/documentation.ts`.

Repository guides that are not tied to a release live here too:

- `self-hosting.md`
- `third-party-notices.md`
