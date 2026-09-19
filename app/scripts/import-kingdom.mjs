// Brings the medieval art pack into public/game/kingdom/.
//
//   node scripts/import-kingdom.mjs <assets-dir>
//
// The pack is not vendored whole. It is roughly two hundred files, most of a
// gigabyte of it in three-thousand-pixel renders, and the game uses about a
// dozen; copying the rest would put art nobody loads into a chunk somebody
// downloads. This script records exactly which files were taken and what was
// done to them, so the choice can be revisited without anybody having to guess.
//
// Provenance is recorded in docs/third-party-notices.md. The pack arrived with
// no licence file, so it is recorded there as supplied by the repository owner
// -- which is a statement about where it came from, not a licence.
//
// The castle over the Keep is not here either, and is no longer imported at
// all. It was this pack's Castle.png, which is rendered square to the camera --
// wrong for a diamond grid, and unfixable: a shear lays a picture's horizontals
// onto one of the map's axes, and the second shear needed for the other axis
// leans every tower, because a shear cannot rotate a three-dimensional render.
// The Keep is built out of Kenney's own castle pieces instead, which were drawn
// isometric to begin with. See `pixi/scene.ts`.
//
// The grass round its foot does come from outside, and is flattened to pixel
// art the same way: see `scripts/import-grass.py`.
//
// The flags are downscaled with `sips`, which is macOS-only. That is a real
// limitation and the reason the downscaled results are committed rather than
// generated at build time: a build that only works on one operating system is
// worse than a script that only re-runs on one.
import { mkdir, copyFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/import-kingdom.mjs <assets-dir>");
  process.exit(1);
}

const out = "public/game/kingdom";

/**
 * The banners that stand at a hero's camp.
 *
 * Downscaled hard. They ship at three thousand pixels for print; on the map a
 * camp banner is about sixty pixels tall, so anything past a few hundred is
 * bytes nobody sees.
 */
const FLAGS = [
  ["flag-medieval-realistic_01/flag-medieval-realistic_04/flag-medieval-realistic_04.png", "banner-a.png"],
  ["flag-medieval-realistic_01/flag-medieval-realistic_05/flag-medieval-realistic_05.png", "banner-b.png"],
  ["flag-medieval-realistic_01/flag-medieval-realistic_06/flag-medieval-realistic_06.png", "banner-c.png"],
  ["flag-medieval-realistic_01/flag-medieval-realistic_07/flag-medieval-realistic_07.png", "banner-d.png"],
];

/** How wide a banner is kept. See the note above. */
const BANNER_WIDTH = 360;

/**
 * Conifers for the border wood.
 *
 * Only the conifers. The set is called "palm tree and pine forest" and most of
 * it is palms, which would be a strange thing to find at the edge of a map of
 * keeps and barrows. The flat silhouette is the one that reads at a distance,
 * which is the only distance any of these are seen from.
 */
const TREES = [
  ["green-nature-palm-tree-and-pine-forest-2026-02-24-00-33-38-utc/SVG/palmtreeart-16.svg", "pine-dark.svg"],
  ["green-nature-palm-tree-and-pine-forest-2026-02-24-00-33-38-utc/SVG/palmtreeart-05.svg", "pine-tall.svg"],
  ["green-nature-palm-tree-and-pine-forest-2026-02-24-00-33-38-utc/SVG/palmtreeart-08.svg", "pine-broad.svg"],
  /*
   * Two more, and not silhouettes.
   *
   * The three above are a flat near-black shape, which reads at a distance but
   * gives a wood made only of them no depth at all -- at dusk the whole edge of
   * the map went to one black band. These two are drawn in sage, so the
   * treeline has something in it besides its own outline.
   */
  ["green-nature-palm-tree-and-pine-forest-2026-02-24-00-33-38-utc/SVG/palmtreeart-06.svg", "pine-light-a.svg"],
  ["green-nature-palm-tree-and-pine-forest-2026-02-24-00-33-38-utc/SVG/palmtreeart-07.svg", "pine-light-b.svg"],
];

/**
 * The marks the interface uses, in place of the typographic glyphs it had.
 *
 * One per thing that needed naming, and no more. A hundred and twenty icons is
 * an invitation to decorate, and an interface where every line has a picture
 * beside it is one where none of the pictures mean anything.
 */
const ICONS = [
  ["medieval-icons/Filled/SVG/Filled 2_Medieval Castle.svg", "castle.svg"],
  ["medieval-icons/Filled/SVG/Filled 2_Medieval Shield.svg", "shield.svg"],
  ["medieval-icons/Filled/SVG/Filled 2_Medieval Tower.svg", "tower.svg"],
  ["medieval-icons/Filled/SVG/Filled 2_Medieval Torch.svg", "torch.svg"],
  ["medieval-icons/Filled/SVG/Filled 2_Medieval Cart Wagon.svg", "wagon.svg"],
  ["medieval-icons/Filled/SVG/Filled 2_Medieval Goblet.svg", "goblet.svg"],
  ["medieval-icons/Filled/SVG/Filled 2_Old Maps.svg", "map.svg"],
  ["medieval-icons/Filled/SVG/Filled 2_Medieval Lance.svg", "lance.svg"],
];

/**
 * The rendered pieces, which are landmarks rather than icons.
 *
 * Grey and gold, which is what makes them usable: the flat banners in this pack
 * are red on gold and cannot be tinted to anybody's colours without going
 * muddy, and `banner` here is grey, so it takes a hero's colour cleanly. That
 * is the whole reason it is in this list.
 *
 * They ship at three thousand pixels. The castle is a building on the map and
 * gets the most; the rest are smaller things and get less.
 */
const RENDERS = [
  ["medieval-kingdom-3d-icons/Siege Weapon.png", "siege.png", 340],
  ["medieval-kingdom-3d-icons/Banner.png", "hero-banner.png", 300],
];

await mkdir(out, { recursive: true });

let taken = 0;

for (const [from, to] of [...TREES, ...ICONS]) {
  try {
    await copyFile(join(source, from), join(out, to));
    taken += 1;
    console.log(`${to}  <-  ${from}`);
  } catch {
    console.warn(`missing, skipped: ${from}`);
  }
}

for (const [from, to] of FLAGS) {
  const input = join(source, from);
  try {
    await stat(input);
  } catch {
    console.warn(`missing, skipped: ${from}`);
    continue;
  }
  try {
    await run("sips", ["--resampleWidth", String(BANNER_WIDTH), input, "--out", join(out, to)]);
    taken += 1;
    console.log(`${to}  <-  ${from}  (resampled to ${BANNER_WIDTH}px)`);
  } catch (error) {
    console.warn(`sips failed for ${from}: ${error instanceof Error ? error.message : error}`);
  }
}

for (const [from, to, width] of RENDERS) {
  const input = join(source, from);
  try {
    await stat(input);
  } catch {
    console.warn(`missing, skipped: ${from}`);
    continue;
  }
  try {
    await run("sips", ["--resampleWidth", String(width), input, "--out", join(out, to)]);
    taken += 1;
    console.log(`${to}  <-  ${from}  (resampled to ${width}px)`);
  } catch (error) {
    console.warn(`sips failed for ${from}: ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`\n${taken} files written to ${out}`);
