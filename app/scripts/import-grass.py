#!/usr/bin/env python3
"""Brings a few grass tufts into public/game/kingdom/.

    python3 scripts/import-grass.py <downloads-dir>

Six out of fourteen, and the choice is the point. The wide low ones read as a
band of grass when they are set side by side, which is what is wanted round the
foot of the castle; the tall ones with flowers on them are single clumps and are
used sparingly among them so the band is not the same tuft repeated.

They ship at two thousand pixels for print and are drawn here about sixty wide,
so they are trimmed to their own bounds and resized hard -- the same reason the
banners in import-kingdom.mjs are downscaled and the results committed.

Pillow only, and not a dependency of the application: this regenerates committed
assets and is run by hand when the source art changes.
"""

import sys
from pathlib import Path

from PIL import Image

if len(sys.argv) < 2:
    sys.exit("usage: python3 scripts/import-grass.py <downloads-dir>")

source = Path(sys.argv[1]) / "Green Grass Illustrations Set"
out = Path("public/game/kingdom")

# The wide low bands first, then two taller clumps for the ones that stand out
# of the band. Named by what they are rather than by the number they shipped
# under, because "Green Grass Illustration 12" tells nobody anything.
TAKE = [
    ("Green Grass Illustration 11.png", "grass-band-a.png"),
    ("Green Grass Illustration 12.png", "grass-band-b.png"),
    ("Green Grass Illustration 13.png", "grass-band-c.png"),
    ("Green Grass Illustration 14.png", "grass-band-d.png"),
    ("Green Grass Illustration 4.png", "grass-tuft-a.png"),
    ("Green Grass Illustration 6.png", "grass-tuft-b.png"),
]

# How wide a tuft is kept, in pixels.
#
# Small, because these are pixel art by the time they are committed and the
# width *is* the pixel size. At forty across, drawn at about a tile and a half,
# a blade of grass is two or three screen pixels wide -- the same grain as
# Kenney's sprites beside it.
WIDE = 40
# How many colours survive. The set is painted with soft gradients down every
# blade; left alone next to flat sprites it reads as a photograph someone has
# dropped onto a cartoon, and the palette is most of that. Ten is enough for a
# light side, a dark side and a stem.
COLOURS = 10
# Anything less opaque than this is cut away rather than feathered: a soft edge
# on a sprite scaled up is a halo.
ALPHA_CUT = 120

out.mkdir(parents=True, exist_ok=True)
for name, to in TAKE:
    path = source / name
    if not path.exists():
        print(f"missing, skipped: {name}")
        continue
    tuft = Image.open(path).convert("RGBA")
    tuft = tuft.crop(tuft.getbbox())
    width, height = tuft.size
    scale = WIDE / width
    # BOX rather than LANCZOS: averaging the block is what makes a pixel, and a
    # sharpening filter puts ringing on every blade before it is quantised.
    tuft = tuft.resize((WIDE, max(1, round(height * scale))), Image.BOX)

    # Then flattened, the same two steps the castle went through. Resizing alone
    # keeps the gradients and just makes them big soft blocks.
    alpha = tuft.getchannel("A").point(lambda value: 255 if value > ALPHA_CUT else 0)
    flat = tuft.convert("RGB").quantize(
        colors=COLOURS, method=Image.MEDIANCUT, dither=Image.Dither.NONE
    )
    tuft = flat.convert("RGBA")
    tuft.putalpha(alpha)

    tuft.save(out / to)
    print(f"{to}  <-  {name}  ({tuft.width}x{tuft.height}, {COLOURS} colours)")
