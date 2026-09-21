// Package xterm is a pure-Go headless terminal emulator ported from xterm.js.
//
// It processes VT/ANSI escape sequences and maintains terminal buffer state
// without requiring a browser, DOM, or any rendering. This enables server-side
// terminal state tracking, screen content extraction, and headless terminal testing.
//
// The implementation follows the VT500 specification and is a direct port of
// the headless subset of https://github.com/xtermjs/xterm.js (MIT license).
package xterm
