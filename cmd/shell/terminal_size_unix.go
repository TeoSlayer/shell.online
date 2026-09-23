//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/term"
)

// watchTerminalSize calls onResize with the terminal's size every time the
// window changes, until the returned stop is called. Repeats are harmless:
// the grid controller ignores a size it already has.
func watchTerminalSize(file *os.File, onResize func(cols, rows int)) (stop func()) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGWINCH)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-signals:
				if cols, rows, err := term.GetSize(int(file.Fd())); err == nil && cols > 0 && rows > 0 {
					onResize(cols, rows)
				}
			case <-done:
				return
			}
		}
	}()
	return func() {
		signal.Stop(signals)
		close(done)
	}
}
