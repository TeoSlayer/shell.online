// Turns Kenney's Fantasy UI Borders into the tinted 9-slice frames the game uses.
//
// The frames in public/game/ui/ are Kenney's Fantasy UI Borders pack, which is
// CC0 and may be used commercially. They ship as white line art on transparency
// and the keep is brass on warm stone, so each one is recoloured on the way in.
//
//   1. Download https://kenney.nl/assets/fantasy-ui-borders
//   2. node scripts/import-fantasy-ui.mjs <unzipped-pack-dir>
//
// Recolouring costs three bytes and a checksum, which is the whole reason this
// script is short: every file in the pack is a 1-bit paletted PNG whose palette
// is exactly two entries, transparent and white. Changing the ink means
// rewriting the second PLTE entry and fixing that chunk's CRC. Nothing is
// inflated, no pixels are touched, and the output is byte-for-byte the same
// image in a different colour.
//
// Provenance and licence are recorded in docs/third-party-notices.md.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/import-fantasy-ui.mjs <unzipped kenney_fantasy-ui-borders dir>");
  process.exit(1);
}

const out = "public/game/ui";

/**
 * The frames the interface actually uses, and what each one is for.
 *
 * Two, not ninety-six. A pack this size is an invitation to give every panel
 * its own frame, and an interface where nothing is framed the same way twice
 * reads as a sampler rather than a place. One frame means "over the map", the
 * other means "the game has stopped", and that is the whole vocabulary.
 */
const FRAMES = [
  {
    to: "frame-panel.png",
    from: ["PNG", "Default", "Border", "panel-border-014.png"],
    // A double rule with corner ticks: everything laid over the map.
    ink: "#e8b44a",
  },
  {
    to: "frame-heavy.png",
    from: ["PNG", "Double", "Border", "panel-border-014.png"],
    // Cut corners, doubled again: anything that has stopped the game to ask.
    ink: "#e8b44a",
  },
];

/** PNG's CRC-32, which every chunk carries and every editor must recompute. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Walks the chunk list, which is the only structure this script needs. */
function* chunks(png) {
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    yield { at, length, type: png.toString("ascii", at + 4, at + 8) };
    at += 12 + length;
  }
}

/**
 * Repaints the ink of a two-entry paletted PNG.
 *
 * Entry 0 is the transparent one -- tRNS says so -- and entry 1 is the line
 * art. Only entry 1 moves, so the transparency survives untouched and so does
 * every pixel; this is a palette swap in the original sense of the phrase.
 */
function repaint(png, hex) {
  const plte = [...chunks(png)].find((chunk) => chunk.type === "PLTE");
  if (!plte) throw new Error("not a paletted PNG: no PLTE chunk");
  if (plte.length !== 6) throw new Error(`expected a two-colour palette, found ${plte.length / 3}`);

  const copy = Buffer.from(png);
  const ink = plte.at + 8 + 3;
  copy[ink] = Number.parseInt(hex.slice(1, 3), 16);
  copy[ink + 1] = Number.parseInt(hex.slice(3, 5), 16);
  copy[ink + 2] = Number.parseInt(hex.slice(5, 7), 16);

  /* The CRC covers the type and the data, and not the length before them. */
  copy.writeUInt32BE(crc32(copy.subarray(plte.at + 4, plte.at + 8 + plte.length)), plte.at + 8 + plte.length);
  return copy;
}

await mkdir(out, { recursive: true });

for (const frame of FRAMES) {
  const png = await readFile(join(source, ...frame.from));
  await writeFile(join(out, frame.to), repaint(png, frame.ink));
  console.log(`${frame.to}  ${frame.ink}  from ${frame.from.join("/")}`);
}

console.log(`\n${FRAMES.length} frames written to ${out}`);
