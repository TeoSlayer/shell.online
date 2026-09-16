/*
 * Renders every sprite in the game to one HTML page, big enough to see.
 *
 * Authoring pixel art as text has one real weakness: you cannot look at it.
 * The atlas test will tell you a row is the wrong width, but it has no opinion
 * about whether the watchtower looks like a watchtower. This closes that gap
 * without a build step or an image pipeline -- each sprite becomes a grid of
 * divs, magnified, next to its name and size.
 *
 *   npx tsx scripts/sprite-sheet.ts [outfile]
 *
 * It writes a standalone file with no assets and no script, so it can be
 * opened straight from disk.
 */
import { writeFile } from "node:fs/promises";
import { PALETTES } from "../src/game/assets/palette";
import { slotOf, type Sprite } from "../src/game/assets/sprite";
import { STRUCTURES } from "../src/game/assets/structures";
import { TERRAIN } from "../src/game/assets/terrain";

const SCALE = 6;

function renderSprite(name: string, sprite: Sprite): string {
  const palette = PALETTES[sprite.palette];
  const cells: string[] = [];
  for (let y = 0; y < sprite.h; y += 1) {
    const row = sprite.rows[y] ?? "";
    for (let x = 0; x < sprite.w; x += 1) {
      const slot = slotOf(row[x] ?? ".");
      const colour = slot < 0 ? "transparent" : palette[slot];
      cells.push(`<i style="background:${colour}"></i>`);
    }
  }
  return `
    <figure>
      <div class="art" style="
        grid-template-columns: repeat(${sprite.w}, ${SCALE}px);
        grid-template-rows: repeat(${sprite.h}, ${SCALE}px);
      ">${cells.join("")}</div>
      <figcaption>${name}<span>${sprite.w}×${sprite.h} · ${sprite.palette}</span></figcaption>
    </figure>`;
}

function section(title: string, sprites: [string, Sprite][]): string {
  return `<section><h2>${title}</h2><div class="row">${sprites
    .map(([name, sprite]) => renderSprite(name, sprite))
    .join("")}</div></section>`;
}

const terrain: [string, Sprite][] = Object.entries(TERRAIN);
const structures: [string, Sprite][] = Object.entries(STRUCTURES).flatMap(([name, art]) =>
  art.tiers.map((sprite, index): [string, Sprite] => [`${name} ${"I".repeat(index + 1)}`, sprite]),
);

const html = `<!doctype html>
<meta charset="utf-8">
<title>Shell Keep — sprite sheet</title>
<style>
  body { margin: 0; padding: 32px; background: #0d1009; color: #f3f1e9;
         font: 14px ui-monospace, monospace; }
  h1 { font-size: 22px; letter-spacing: .18em; text-transform: uppercase; color: #c8ff4d; }
  h2 { font-size: 15px; letter-spacing: .12em; text-transform: uppercase; color: #8d9382;
       border-bottom: 2px solid #343a2e; padding-bottom: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-end; }
  figure { margin: 0; }
  /* The checker shows through transparent pixels, so a hole is visible as one. */
  .art { display: grid; background-image:
      linear-gradient(45deg, #1d201b 25%, transparent 25%),
      linear-gradient(-45deg, #1d201b 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #1d201b 75%),
      linear-gradient(-45deg, transparent 75%, #1d201b 75%);
    background-size: 12px 12px;
    background-position: 0 0, 0 6px, 6px -6px, -6px 0; }
  .art i { display: block; }
  figcaption { margin-top: 10px; color: #c3c8b4; }
  figcaption span { display: block; color: #6f7862; font-size: 12px; }
</style>
<h1>Shell Keep — sprite sheet</h1>
${section("Terrain", terrain)}
${section("Structures", structures)}
`;

const out = process.argv[2] ?? "sprite-sheet.html";
await writeFile(out, html, "utf8");
console.log(`sprite-sheet: wrote ${out}`);
