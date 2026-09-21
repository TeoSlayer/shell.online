# xterm-go

A pure-Go headless terminal emulator ported from [xterm.js](https://github.com/xtermjs/xterm.js).

It processes VT/ANSI escape sequences and maintains terminal buffer state without requiring a browser, DOM, or any rendering. This enables server-side terminal state tracking, screen content extraction, and headless terminal testing.

The implementation follows the VT500 specification and is a direct port of the headless subset of xterm.js (MIT license).

## Install

```
go get github.com/gitpod-io/xterm-go
```

## Usage

```go
package main

import (
	"fmt"

	xterm "github.com/gitpod-io/xterm-go"
)

func main() {
	term := xterm.New(xterm.WithCols(80), xterm.WithRows(24))
	defer term.Dispose()

	term.WriteString("Hello, world!\r\n")
	term.WriteString("\x1b[1;31mRed bold text\x1b[0m\r\n")

	fmt.Println(term.String())
	fmt.Printf("Cursor: (%d, %d)\n", term.CursorX(), term.CursorY())
}
```

## Features

- Full VT500 escape sequence parsing (CSI, OSC, DCS, APC)
- Normal and alternate screen buffers with scrollback
- Text attributes: bold, italic, underline, strikethrough, blink, inverse, dim, overline
- 16-color, 256-color, and 24-bit RGB color support
- Terminal resize with reflow
- Serialize addon for terminal state snapshots
- Conformance tests against xterm.js golden data

## API

### Terminal

```go
// Create a terminal with options.
term := xterm.New(
    xterm.WithCols(80),
    xterm.WithRows(24),
    xterm.WithScrollback(1000),
)

// Write data (implements io.Writer).
term.Write([]byte("\x1b[2J"))
term.WriteString("text")

// Read state.
term.Cols()              // terminal width
term.Rows()              // terminal height
term.CursorX()           // cursor column
term.CursorY()           // cursor row
term.GetLine(y)          // text content of line y
term.String()            // full screen content
term.Buffer()            // active buffer
term.NormalBuffer()      // normal screen buffer
term.AltBuffer()         // alternate screen buffer
term.IsAltBufferActive() // whether alt buffer is active

// Resize.
term.Resize(cols, rows)

// Events.
term.OnData(func(s string) { })       // terminal response data (DA, DSR)
term.OnBell(func() { })               // BEL character
term.OnTitleChange(func(s string) { }) // OSC title change
term.OnLineFeed(func() { })            // line feed

// Cleanup.
term.Dispose()
```

### SerializeAddon

Produces compact escape-sequence snapshots of terminal state for reconnection:

```go
addon := xterm.NewSerializeAddon(term)
snapshot := addon.Serialize(nil) // []byte of escape sequences
```

## Conformance

Cross-implementation tests verify the Go port produces identical behavior to xterm.js. See [`conformance/README.md`](conformance/README.md).

```bash
go test -run TestConformance -v
```

## License

MIT — see [LICENSE](LICENSE).

The original xterm.js is also MIT licensed: https://github.com/xtermjs/xterm.js/blob/master/LICENSE
