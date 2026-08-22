//go:build windows

package main

import (
	"fmt"
	"io"
)

func launchBackgroundProcess(_ []string, _ bool, _ io.Writer, stderr io.Writer) int {
	fmt.Fprintln(stderr, "shell: background sessions are not available on Windows")
	return 1
}
