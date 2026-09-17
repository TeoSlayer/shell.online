#!/usr/bin/env python3
"""Makes public/game/kingdom/castle-8bit.png from the pack's Castle.png.

    python3 scripts/pixelate-castle.py <assets-dir>

The castle over Prompt Keep is the one thing on this map drawn as pixel art,
and it is drawn about eleven times the size of the file, so the file has to be
small and flat rather than merely scaled down.

Two steps, and both are needed. Downscaling alone keeps the render's soft
gradients and turns them into big soft blocks, which reads as a photograph
somebody enlarged rather than as pixel art; quantising to a small flat palette
is the other half of the look. The alpha is cut to a hard edge for the same
reason -- a feathered edge on a sprite scaled eleven times is a halo.

Pillow only, and it is not a dependency of the application: this regenerates a
committed asset and is run by hand when the source art changes. That is the
same arrangement as the banners in import-kingdom.mjs, which need `sips`.
"""

import sys
from pathlib import Path

from PIL import Image

if len(sys.argv) < 2:
    sys.exit("usage: python3 scripts/pixelate-castle.py <assets-dir>")

source = Path(sys.argv[1]) / "medieval-kingdom-3d-icons" / "Castle.png"
out = Path("public/game/kingdom/castle-8bit.png")

# The long edge, in pixels.
#
# This number is not a taste: it sets how big one of the castle's pixels is on
# screen, and that has to match the rest of the map. Kenney's sprites are drawn
# a texture pixel to a world pixel, so at 160 across and a scale of 2 a castle
# block is two world pixels -- near enough the map's own grain that the two read
# as one picture. At 72 and a scale of 11 each block was eleven world pixels and
# the castle looked like it had been pasted in from a different game.
LONG = 160
# How many colours are left. Twenty-eight holds the stone, the roofs and the
# gate at this size without turning the walls into flat grey.
COLOURS = 28
# Anything less opaque than this is cut away rather than feathered.
ALPHA_CUT = 110

castle = Image.open(source).convert("RGBA")

# Trimmed first: the render ships centred in a square with a lot of empty air,
# and pixels spent on transparency are pixels the blocks do not get.
castle = castle.crop(castle.getbbox())

width, height = castle.size
scale = LONG / max(width, height)
small = castle.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.BOX)

alpha = small.getchannel("A").point(lambda value: 255 if value > ALPHA_CUT else 0)
flat = small.convert("RGB").quantize(colors=COLOURS, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
result = flat.convert("RGBA")
result.putalpha(alpha)

out.parent.mkdir(parents=True, exist_ok=True)
result.save(out)
print(f"{out}  <-  {source}  ({result.width}x{result.height}, {COLOURS} colours)")
