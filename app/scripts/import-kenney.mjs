// Turns Kenney's spritesheet XML into the JSON atlas PixiJS reads.
//
// The art in public/game/ is Kenney's Medieval RTS pack, which is CC0 and may
// be used commercially. It ships as one PNG plus an XML atlas in Kenney's own
// format; Pixi wants TexturePacker JSON. Rather than hand-convert once and
// leave a mystery file in the repository, the conversion lives here so the
// next person can re-run it against a newer version of the pack.
//
//   1. Download https://kenney.nl/assets/medieval-rts
//   2. node scripts/import-kenney.mjs <unzipped-pack-dir>
//
// Provenance and licence are recorded in docs/third-party-notices.md.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/import-kenney.mjs <unzipped kenney_medieval-rts dir>");
  process.exit(1);
}

const sheet = join(source, "Spritesheet", "medievalRTS_spritesheet@2");
const out = "public/game";

/** The PNG header carries the dimensions the atlas has to declare. */
async function pngSize(path) {
  const data = await readFile(path);
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

const xml = await readFile(`${sheet}.xml`, "utf8");
const size = await pngSize(`${sheet}.png`);

const frames = {};
const pattern = /<SubTexture name="([^"]+)" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g;
for (const match of xml.matchAll(pattern)) {
  const [, rawName, x, y, w, h] = match;
  /*
   * "medievalStructure_04.png" becomes "Structure_04". The prefix says which
   * pack it came from, which the atlas already knows, and the extension is
   * noise in a texture key.
   */
  const name = rawName.replace(/^medieval/, "").replace(/\.png$/, "");
  const frame = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
  frames[name] = {
    frame,
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: frame.w, h: frame.h },
    sourceSize: { w: frame.w, h: frame.h },
  };
}

await copyFile(`${sheet}.png`, `${out}/medieval-rts.png`);
await writeFile(
  `${out}/medieval-rts.json`,
  `${JSON.stringify(
    {
      frames,
      meta: {
        image: "medieval-rts.png",
        format: "RGBA8888",
        size: { w: size.w, h: size.h },
        scale: "1",
        app: "kenney.nl medieval-rts, CC0",
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`import-kenney: ${Object.keys(frames).length} frames -> ${out}/medieval-rts.json`);
