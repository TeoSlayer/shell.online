//go:build windows

package main

import (
	"context"
	"fmt"
	"io"

	"shell.online/internal/api"
)

func runSharedProcess(
	_ context.Context,
	_ api.Session,
	_ []string,
	_ []string,
	_ io.Writer,
	_ io.Writer,
	_ func(),
	_ localSessionControl,
) (int, error) {
	return 1, fmt.Errorf("Windows ConPTY support is not available yet")
}
