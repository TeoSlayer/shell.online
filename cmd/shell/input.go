package main

import (
	"bufio"
	"io"
)

// terminalLines hands the terminal's input out one line at a time.
//
// One goroutine owns the reader and everything that wants a line takes it from
// the same channel. Two readers on one terminal is how the answer to a
// question ends up somewhere else: `shell auth --no-browser` waits for a
// pasted callback URL, the remote-start question waits for a y or an n, and
// whichever happened to be blocked in a read would take whatever was typed.
//
// The channel is unbuffered, so a line the reader has already taken off the
// terminal waits in the goroutine until something asks for it rather than
// being dropped.
func terminalLines(input io.Reader) <-chan string {
	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(input)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	return lines
}

// wantsPasteReader decides whether this login should read the terminal.
//
// --no-browser always does. It is the flag for a machine whose browser is
// somewhere else, so a pasted callback is the only way that login can finish,
// and there is no reason to require a terminal for it: standard input can
// perfectly well be a pipe feeding the callback in, and the terminal check
// also asks about standard error, so redirecting a log turned the paste off.
//
// Without that flag there is nothing to paste, and the only thing that wants a
// line is a question that is only ever asked at a terminal. So a scripted
// login reads nobody's standard input.
func wantsPasteReader(noBrowser, interactive bool) bool {
	return noBrowser || interactive
}
