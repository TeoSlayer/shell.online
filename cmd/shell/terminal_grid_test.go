package main

import (
	"encoding/json"
	"testing"
)

type countingResizer struct {
	calls []terminalGrid
}

func (resizer *countingResizer) Resize(cols, rows int) error {
	resizer.calls = append(resizer.calls, terminalGrid{Cols: uint16(cols), Rows: uint16(rows)})
	return nil
}

type countingEmulator struct {
	calls []terminalGrid
}

func (emulator *countingEmulator) ResizeTerminal(cols, rows int) {
	emulator.calls = append(emulator.calls, terminalGrid{Cols: uint16(cols), Rows: uint16(rows)})
}

type gridHarness struct {
	controller *gridController
	process    *countingResizer
	emulator   *countingEmulator
	announced  []terminalGrid
}

func newGridHarness(initial terminalGrid, local bool) *gridHarness {
	harness := &gridHarness{process: &countingResizer{}, emulator: &countingEmulator{}}
	harness.controller = newGridController(initial, local, harness.process, harness.emulator, func(grid terminalGrid) {
		harness.announced = append(harness.announced, grid)
	})
	// These tests are about resizing, against a relay that takes grids.
	harness.controller.RelayTakesGrid()
	harness.announced = nil
	return harness
}

func (harness *gridHarness) expect(t *testing.T, want ...terminalGrid) {
	t.Helper()
	for name, got := range map[string][]terminalGrid{
		"PTY":      harness.process.calls,
		"emulator": harness.emulator.calls,
		"announce": harness.announced,
	} {
		if len(got) != len(want) {
			t.Fatalf("%s resizes = %v, want %v", name, got, want)
		}
		for index := range want {
			if got[index] != want[index] {
				t.Fatalf("%s resizes = %v, want %v", name, got, want)
			}
		}
	}
}

func TestGridControllerRepeatedSizesResizeNothing(t *testing.T) {
	harness := newGridHarness(terminalGrid{Cols: 100, Rows: 30}, true)

	// The size it opened at, again and again: a SIGWINCH storm with no change.
	for range 5 {
		harness.controller.SetLocal(100, 30)
	}
	harness.expect(t)

	harness.controller.SetLocal(140, 40)
	harness.controller.SetLocal(140, 40)
	harness.controller.SetLocal(140, 40)
	harness.expect(t, terminalGrid{Cols: 140, Rows: 40})

	if current := harness.controller.Current(); current != (terminalGrid{Cols: 140, Rows: 40}) {
		t.Fatalf("current = %v", current)
	}
}

func TestGridControllerKeepsBrowserRequestsWithinTheLocalTerminal(t *testing.T) {
	harness := newGridHarness(terminalGrid{Cols: 120, Rows: 36}, true)

	// A phone asks for its own size: smaller on both axes, granted.
	harness.controller.Request(45, 30)
	// A monitor asks for more than the laptop terminal can show: clamped.
	harness.controller.Request(200, 60)
	// The same request again changes nothing.
	harness.controller.Request(200, 60)
	harness.expect(t, terminalGrid{Cols: 45, Rows: 30}, terminalGrid{Cols: 120, Rows: 36})
}

func TestGridControllerDetachKeepsTheGridAndLiftsTheLimit(t *testing.T) {
	harness := newGridHarness(terminalGrid{Cols: 120, Rows: 36}, false)

	harness.controller.SetLocal(80, 24)
	harness.controller.ClearLocal()
	harness.expect(t, terminalGrid{Cols: 80, Rows: 24})

	// No terminal limits the browser now.
	harness.controller.Request(200, 60)
	harness.expect(t, terminalGrid{Cols: 80, Rows: 24}, terminalGrid{Cols: 200, Rows: 60})
}

func TestGridControllerRefusesOutOfRangeRequestsAndClampsLocalSizes(t *testing.T) {
	harness := newGridHarness(defaultTerminalGrid(), false)

	for _, request := range [][2]int{{9, 30}, {501, 30}, {80, 3}, {80, 301}, {0, 0}, {-5, 20}} {
		if harness.controller.Request(request[0], request[1]) {
			t.Fatalf("request %v was accepted", request)
		}
	}
	harness.expect(t)

	// A real terminal is never refused, only pulled into range.
	harness.controller.SetLocal(4, 1000)
	harness.expect(t, terminalGrid{Cols: 10, Rows: 300})
}

func TestParseTerminalGrid(t *testing.T) {
	for value, want := range map[string]terminalGrid{
		"120x36":  {Cols: 120, Rows: 36},
		" 45x30 ": {Cols: 45, Rows: 30},
		"500x300": {Cols: 500, Rows: 300},
		"10x4":    {Cols: 10, Rows: 4},
	} {
		got, ok := parseTerminalGrid(value)
		if !ok || got != want {
			t.Fatalf("parseTerminalGrid(%q) = %v, %v; want %v", value, got, ok, want)
		}
	}
	for _, value := range []string{"", "120", "x36", "120x", "9x36", "120x301", "abcxdef", "120X36", "12.5x36"} {
		if got, ok := parseTerminalGrid(value); ok {
			t.Fatalf("parseTerminalGrid(%q) = %v, want refusal", value, got)
		}
	}
}

func TestInitialTerminalGridFallsBackToTheLauncherThenTheDefault(t *testing.T) {
	t.Setenv(terminalGridEnvironment, "90x28")
	if grid, local := initialTerminalGrid(nil); grid != (terminalGrid{Cols: 90, Rows: 28}) || local {
		t.Fatalf("initial grid = %v (local %v), want 90x28 from the launcher", grid, local)
	}
	t.Setenv(terminalGridEnvironment, "nonsense")
	if grid, local := initialTerminalGrid(nil); grid != defaultTerminalGrid() || local {
		t.Fatalf("initial grid = %v (local %v), want the default", grid, local)
	}
}

func TestTerminalGridMessage(t *testing.T) {
	var decoded map[string]any
	if err := json.Unmarshal(terminalGridMessage(terminalGrid{Cols: 132, Rows: 43}), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["type"] != "terminal_grid" || decoded["cols"] != float64(132) || decoded["rows"] != float64(43) || len(decoded) != 3 {
		t.Fatalf("terminal_grid message = %v", decoded)
	}
}

// A relay from before hosts owned their grids may still choose the wider
// desktop grid for this host, which advertises 160x48 alongside "dynamic".
// It arrives as a request and is honoured like any other size in range.
func TestGridControllerTakesTheWideDesktopGridFromAnOlderRelay(t *testing.T) {
	process := &countingResizer{}
	controller := newGridController(terminalGrid{Cols: 120, Rows: 36}, false, process, nil, nil)
	if !controller.Request(160, 48) {
		t.Fatal("160x48 was refused")
	}
	if got := controller.Current(); got != (terminalGrid{Cols: 160, Rows: 48}) {
		t.Fatalf("grid = %v, want 160x48", got)
	}
}

// A relay that predates terminal_grid closes a host over any control message
// it does not know. So nothing is announced until the relay says it takes a
// grid, the grid as it is then goes first, and every new socket starts over.
func TestGridControllerAnnouncesOnlyToARelayThatTakesGrids(t *testing.T) {
	var announced []terminalGrid
	process := &countingResizer{}
	controller := newGridController(terminalGrid{Cols: 120, Rows: 36}, true, process, nil, func(grid terminalGrid) {
		announced = append(announced, grid)
	})
	controller.SetLocal(100, 30)
	if len(announced) != 0 {
		t.Fatalf("announced %v before the relay said it takes a grid", announced)
	}
	if len(process.calls) != 1 {
		t.Fatalf("the PTY must still follow the terminal: resizes = %v", process.calls)
	}

	controller.RelayTakesGrid()
	controller.RelayTakesGrid()
	if want := []terminalGrid{{Cols: 100, Rows: 30}}; len(announced) != 1 || announced[0] != want[0] {
		t.Fatalf("announced = %v, want %v once", announced, want)
	}
	controller.SetLocal(90, 25)
	if len(announced) != 2 || announced[1] != (terminalGrid{Cols: 90, Rows: 25}) {
		t.Fatalf("announced = %v, want the change too", announced)
	}

	// A reconnect: the relay on the new socket has not said anything yet.
	controller.NewSocket()
	controller.SetLocal(80, 24)
	if len(announced) != 2 {
		t.Fatalf("announced %v on a socket whose relay has not said it takes grids", announced)
	}
	controller.RelayTakesGrid()
	if len(announced) != 3 || announced[2] != (terminalGrid{Cols: 80, Rows: 24}) {
		t.Fatalf("announced = %v, want the current grid after the relay said so", announced)
	}
}
