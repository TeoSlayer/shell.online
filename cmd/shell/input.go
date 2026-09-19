package main

import (
	"bufio"
	"io"
)

// terminalLines hands the terminal's input out one line at a time.
//
// One goroutine owns the reader and everything that wants a line takes it from
// the same channel. Two readers on one terminal is how the answer to a
// question ends up somewhere else: `shell login --no-browser` waits for a
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
