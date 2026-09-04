module shell.online

// Go 1.27 has a MIPS64 epoll alignment regression (go.dev/issue/80978).
// Keep release builds on the supported 1.26 line until the runtime fix ships.
go 1.26.8

require (
	github.com/Microsoft/go-winio v0.6.2
	github.com/aymanbagabas/go-pty v0.2.3
	github.com/coder/websocket v1.8.15
	github.com/creack/pty v1.1.24
	golang.org/x/sys v0.47.0
	golang.org/x/term v0.45.0
)

require (
	github.com/u-root/u-root v0.16.0 // indirect
	golang.org/x/crypto v0.52.0 // indirect
)
