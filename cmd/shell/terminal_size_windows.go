//go:build windows

package main

import (
	"os"
	"time"

	"golang.org/x/term"
)

// terminalSizePollInterval is how often a Windows console is measured. It
// has no SIGWINCH, and a resize there is rare enough that a quarter second
// is not felt.
const terminalSizePollInterval = 250 * time.Millisecond

// watchTerminalSize calls onResize with the console's size whenever it
// changes, until the returned stop is called.
func watchTerminalSize(file *os.File, onResize func(cols, rows int)) (stop func()) {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(terminalSizePollInterval)
		defer ticker.Stop()
		lastCols, lastRows, _ := term.GetSize(int(file.Fd()))
		for {
			select {
			case <-ticker.C:
				cols, rows, err := term.GetSize(int(file.Fd()))
				if err != nil || cols <= 0 || rows <= 0 || (cols == lastCols && rows == lastRows) {
					continue
				}
				lastCols, lastRows = cols, rows
				onResize(cols, rows)
			case <-done:
				return
			}
		}
	}()
	return func() { close(done) }
}
