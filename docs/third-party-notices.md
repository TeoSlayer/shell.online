# Third-party notices

shell.online includes the following redistributable components. Their licenses apply to those components; the rest of the repository is licensed under MIT.

## xterm.js and @xterm/addon-fit — MIT

Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Refstream.js — MIT

Copyright (c) 2026 Calin Teodor. The MIT license above applies. The vendored
browser build is v0.1.0-alpha.5; its complete license and provenance are in
[`web/vendor/refstream/v0.1.0-alpha.5/`](../web/vendor/refstream/v0.1.0-alpha.5/).

## ws — MIT

Copyright (c) 2011 Einar Otto Stangvik; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors. The MIT license above applies.

## Uncut Sans — SIL Open Font License 1.1

The bundled font is Copyright (c) 2022 Kasper Nordkvist. “Uncut Sans” is a trademark of Kasper Nordkvist. Its full license is included at [`public/fonts/OFL-Uncut-Sans.txt`](../public/fonts/OFL-Uncut-Sans.txt).

## Kenney game assets — Creative Commons Zero (CC0 1.0)

The game skin's artwork is by Kenney Vleugels (https://kenney.nl), released
into the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Kenney's licence
states these assets may be used in personal and commercial projects, and that
credit is appreciated but not required. It is given here anyway.

| What | Pack | Source |
|---|---|---|
| Structures, units, terrain and environment | RTS Pack: Medieval | https://kenney.nl/assets/medieval-rts |
| Particle textures for the game's effects | Particle Pack | https://kenney.nl/assets/particle-pack |
| The 9-slice frames around the game's panels | Fantasy UI Borders | https://kenney.nl/assets/fantasy-ui-borders |

The vendored files are `app/public/game/medieval-rts.png` (Kenney's own
spritesheet, unmodified) and `app/public/game/fx-*.png` (selected particle
textures, unmodified). `app/public/game/medieval-rts.json` is generated from
Kenney's spritesheet XML by `app/scripts/import-kenney.mjs`, which records how
to regenerate it against a newer release of the pack.

`app/public/game/ui/frame-*.png` are two borders from the Fantasy UI Borders
pack, recoloured from white to brass. Every pixel is Kenney's: the files are
paletted, and `app/scripts/import-fantasy-ui.mjs` rewrites the one palette
entry that is not transparent. That script also records which borders were
taken, so the choice can be revisited against a newer release.

## PixiJS — MIT

Copyright (c) 2013-2023 Mathew Groves, Chad Engler. The MIT license above
applies. Used by the game skin only, and only in its lazily-loaded chunk.
