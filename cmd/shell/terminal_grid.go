package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"golang.org/x/term"
)

// The range a session grid may take, shared with the relay and the browser
// (shared/terminal-grid.ts) and with the binary Resize frame.
const (
	minTerminalCols = 10
	maxTerminalCols = 500
	minTerminalRows = 4
	maxTerminalRows = 300

	// The grid a session opens at when nothing better is known: no terminal
	// started it, and no browser said how large it is.
	defaultTerminalCols = 120
	defaultTerminalRows = 36

	// terminalGridEnvironment carries a starting grid, "COLSxROWS", from
	// whatever launched this process when it has no terminal of its own: a
	// `--background` launch from a terminal, or a browser-started session.
	terminalGridEnvironment = "SHELL_ONLINE_TERMINAL_GRID"
)

type terminalGrid struct {
	Cols uint16
	Rows uint16
}

func defaultTerminalGrid() terminalGrid {
	return terminalGrid{Cols: defaultTerminalCols, Rows: defaultTerminalRows}
}

func (grid terminalGrid) String() string {
	return fmt.Sprintf("%dx%d", grid.Cols, grid.Rows)
}

func validTerminalGrid(cols, rows int) bool {
	return cols >= minTerminalCols && cols <= maxTerminalCols &&
		rows >= minTerminalRows && rows <= maxTerminalRows
}

// clampTerminalGrid pulls any real terminal's size into range, so a tiny or
// huge window still yields a grid every other layer accepts.
func clampTerminalGrid(cols, rows int) terminalGrid {
	return terminalGrid{
		Cols: uint16(min(maxTerminalCols, max(minTerminalCols, cols))),
		Rows: uint16(min(maxTerminalRows, max(minTerminalRows, rows))),
	}
}

func parseTerminalGrid(value string) (terminalGrid, bool) {
	colsText, rowsText, found := strings.Cut(strings.TrimSpace(value), "x")
	if !found {
		return terminalGrid{}, false
	}
	cols, colsErr := strconv.Atoi(colsText)
	rows, rowsErr := strconv.Atoi(rowsText)
	if colsErr != nil || rowsErr != nil || !validTerminalGrid(cols, rows) {
		return terminalGrid{}, false
	}
	return terminalGrid{Cols: uint16(cols), Rows: uint16(rows)}, true
}

// terminalFileGrid is the size of a terminal device, or false when the file
// is not one.
func terminalFileGrid(file *os.File) (terminalGrid, bool) {
	if file == nil || !term.IsTerminal(int(file.Fd())) {
		return terminalGrid{}, false
	}
	cols, rows, err := term.GetSize(int(file.Fd()))
	if err != nil || cols <= 0 || rows <= 0 {
		return terminalGrid{}, false
	}
	return clampTerminalGrid(cols, rows), true
}

// launchingTerminalGrid is the size of the terminal this command was typed
// into, whichever standard stream is attached to it.
func launchingTerminalGrid() (terminalGrid, bool) {
	for _, file := range []*os.File{os.Stdout, os.Stderr, os.Stdin} {
		if grid, ok := terminalFileGrid(file); ok {
			return grid, true
		}
	}
	return terminalGrid{}, false
}

// initialTerminalGrid decides the grid a PTY opens at. A terminal showing the
// session wins and becomes its local limit; then a size handed down by the
// launcher; then the default.
func initialTerminalGrid(stdout any) (grid terminalGrid, local bool) {
	if file, ok := stdout.(*os.File); ok {
		if size, isTerminal := terminalFileGrid(file); isTerminal {
			return size, true
		}
	}
	if size, ok := parseTerminalGrid(os.Getenv(terminalGridEnvironment)); ok {
		return size, false
	}
	return defaultTerminalGrid(), false
}

// gridResizer is what a grid change has to reach: the PTY and the emulator
// that keeps the replay snapshot. Both are resized together, or the snapshot
// describes a screen of a different shape from the one the process draws.
type gridResizer interface {
	Resize(cols, rows int) error
}

type gridEmulator interface {
	ResizeTerminal(cols, rows int)
}

// gridController is the only thing that resizes a session's PTY.
//
// The grid belongs to whatever terminal is showing the session on this
// machine: the one `shell` runs in, or one attached with `shell attach`. That
// terminal cannot scale what it is given, so while it is present it is also a
// limit. A browser can ask for its own size ("fit the program to my screen"),
// and gets it within that limit. Viewers joining, leaving or resizing their
// windows change nothing here: each draws the grid it is given in its own way.
//
// Every entry point is idempotent. A size equal to the current grid resizes
// nothing and announces nothing, so a repeated SIGWINCH, a reconnecting
// viewer or a replayed request cannot make a program redraw.
type gridController struct {
	mu         sync.Mutex
	current    terminalGrid
	localLimit *terminalGrid
	process    gridResizer
	emulator   gridEmulator
	announce   func(terminalGrid)
	// announcing is whether the relay on the current socket understands
	// terminal_grid. A relay that predates it closes a host over any control
	// message it does not know, so nothing is announced until the relay says
	// it takes one (relay_features), and every new socket starts over. Atomic
	// rather than under mu: it is cleared from the connection's own goroutine,
	// which must never wait on a lock held by a send it has to drain.
	announcing atomic.Bool
}

func newGridController(initial terminalGrid, local bool, process gridResizer, emulator gridEmulator, announce func(terminalGrid)) *gridController {
	controller := &gridController{current: initial, process: process, emulator: emulator, announce: announce}
	if local {
		limit := initial
		controller.localLimit = &limit
	}
	return controller
}

// Current is the grid the PTY is at now.
func (controller *gridController) Current() terminalGrid {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.current
}

// SetLocal records the size of the local terminal showing the session and
// follows it.
func (controller *gridController) SetLocal(cols, rows int) {
	grid := clampTerminalGrid(cols, rows)
	controller.mu.Lock()
	defer controller.mu.Unlock()
	controller.localLimit = &grid
	controller.applyLocked(grid)
}

// ClearLocal forgets the local terminal once it stops showing the session.
// The grid stays where it is: nobody asked for a different one.
func (controller *gridController) ClearLocal() {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	controller.localLimit = nil
}

// Request applies a browser's explicit request for its own grid, within the
// local terminal's size when there is one. Out-of-range requests are refused.
// A legacy relay's terminal_size goes through here too: a terminal that
// cannot scale its text is never handed a grid larger than itself.
func (controller *gridController) Request(cols, rows int) bool {
	if !validTerminalGrid(cols, rows) {
		return false
	}
	grid := terminalGrid{Cols: uint16(cols), Rows: uint16(rows)}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if limit := controller.localLimit; limit != nil {
		grid.Cols = min(grid.Cols, limit.Cols)
		grid.Rows = min(grid.Rows, limit.Rows)
	}
	controller.applyLocked(grid)
	return true
}

func (controller *gridController) applyLocked(grid terminalGrid) {
	if grid == controller.current {
		return
	}
	if controller.emulator != nil {
		controller.emulator.ResizeTerminal(int(grid.Cols), int(grid.Rows))
	}
	if controller.process != nil {
		_ = controller.process.Resize(int(grid.Cols), int(grid.Rows))
	}
	controller.current = grid
	if controller.announce != nil && controller.announcing.Load() {
		controller.announce(grid)
	}
}

// RelayTakesGrid is called when the relay says it understands terminal_grid:
// from now on every change is announced, starting with the grid as it is.
func (controller *gridController) RelayTakesGrid() {
	if controller.announcing.Swap(true) {
		return
	}
	current := controller.Current()
	if controller.announce != nil {
		controller.announce(current)
	}
}

// NewSocket forgets what the last relay understood. Called first on every
// socket, so a reconnect that reaches an older relay announces nothing.
func (controller *gridController) NewSocket() {
	controller.announcing.Store(false)
}

// terminalGridMessage is the host's announcement of its grid to the relay.
func terminalGridMessage(grid terminalGrid) []byte {
	message, _ := json.Marshal(struct {
		Type string `json:"type"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}{Type: "terminal_grid", Cols: grid.Cols, Rows: grid.Rows})
	return message
}
