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

# How wide a tuft is kept, in pixels. Drawn at about a tile, so anything past a
# couple of hundred is bytes nobody sees.
WIDE = 220

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
    tuft = tuft.resize((WIDE, max(1, round(height * scale))), Image.LANCZOS)
    tuft.save(out / to)
    print(f"{to}  <-  {name}  ({tuft.width}x{tuft.height})")
