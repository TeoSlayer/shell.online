package xterm

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

func newTestTerminal(cols, rows int) *Terminal {
	t := true
	return New(WithCols(cols), WithRows(rows), WithScrollback(1000), WithVtExtensions(VtExtensions{
		KittyKeyboard:            true,
		ColorSchemeQuery:         &t,
		Win32InputMode:           true,
		KittySgrBoldFaintControl: &t,
	}))
}

func TestWithMouseEventsRequireAlt(t *testing.T) {
	t.Parallel()

	term := New(WithMouseEventsRequireAlt(true))
	if !term.optionsService.Options.MouseEventsRequireAlt {
		t.Errorf("MouseEventsRequireAlt = %v, want true", term.optionsService.Options.MouseEventsRequireAlt)
	}
}

func TestTerminalBasicTextOutput(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Line0 string
		Full  string
		CurX  int
		CurY  int
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			"hello_world",
			"Hello, World!",
			Expectation{"Hello, World!", "Hello, World!", 13, 0},
		},
		{
			"two_lines",
			"Line1\r\nLine2",
			Expectation{"Line1", "Line1\nLine2", 5, 1},
		},
		{
			"empty_terminal",
			"",
			Expectation{"", "", 0, 0},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			term := newTestTerminal(80, 24)
			term.WriteString(tc.Input)
			got := Expectation{
				Line0: term.GetLine(0),
				Full:  term.String(),
				CurX:  term.CursorX(),
				CurY:  term.CursorY(),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestTerminalCursorMovement(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		X int
		Y int
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{"cup_1_1", "\x1b[1;1H", Expectation{0, 0}},
		{"cup_5_10", "\x1b[5;10H", Expectation{9, 4}},
		{"cuf", "ABC\x1b[5C", Expectation{8, 0}},
		{"cub", "ABCDEF\x1b[3D", Expectation{3, 0}},
		{"cuu", "\x1b[5;1HABC\x1b[2A", Expectation{3, 2}},
		{"cud", "ABC\x1b[3B", Expectation{3, 3}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			term := newTestTerminal(80, 24)
			term.WriteString(tc.Input)
			got := Expectation{X: term.CursorX(), Y: term.CursorY()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestTerminalLineWrapping(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(10, 5)
	// Write 25 chars — should wrap across 3 lines on a 10-col terminal.
	term.WriteString("ABCDEFGHIJKLMNOPQRSTUVWXY")
	type Expectation struct {
		Line0 string
		Line1 string
		Line2 string
		CurX  int
		CurY  int
	}
	want := Expectation{
		Line0: "ABCDEFGHIJ",
		Line1: "KLMNOPQRST",
		Line2: "UVWXY",
		CurX:  5,
		CurY:  2,
	}
	got := Expectation{
		Line0: term.GetLine(0),
		Line1: term.GetLine(1),
		Line2: term.GetLine(2),
		CurX:  term.CursorX(),
		CurY:  term.CursorY(),
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalScrolling(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(20, 5)
	// Write 8 lines into a 5-row terminal — first 3 should scroll into scrollback.
	for i := range 8 {
		term.WriteString(fmt.Sprintf("Line%d\r\n", i))
	}
	type Expectation struct {
		ViewLine0 string
		ViewLine1 string
		ViewLine2 string
		YBase     int
	}
	want := Expectation{
		ViewLine0: "Line4",
		ViewLine1: "Line5",
		ViewLine2: "Line6",
		YBase:     4,
	}
	got := Expectation{
		ViewLine0: term.GetLine(0),
		ViewLine1: term.GetLine(1),
		ViewLine2: term.GetLine(2),
		YBase:     term.Buffer().YBase,
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalWindowsPtyBackendOnlyResizeKeepsScrollback(t *testing.T) {
	t.Parallel()

	term := New(
		WithCols(5),
		WithRows(2),
		WithScrollback(10),
		WithWindowsPty(WindowsPty{Backend: "winpty"}),
	)
	term.WriteString("one\ntwo\nthree")

	beforeYBase := term.Buffer().YBase
	beforeY := term.Buffer().Y
	beforeLen := term.Buffer().Lines.Length()
	if beforeYBase == 0 {
		t.Fatalf("setup YBase = 0, want scrollback before resize")
	}

	term.Resize(5, 3)

	got := struct {
		YBase     int
		Y         int
		LineCount int
	}{
		YBase:     term.Buffer().YBase,
		Y:         term.Buffer().Y,
		LineCount: term.Buffer().Lines.Length(),
	}
	want := struct {
		YBase     int
		Y         int
		LineCount int
	}{
		YBase:     beforeYBase,
		Y:         beforeY,
		LineCount: beforeLen + 1,
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalColorsSGR(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars   string
		IsBold  bool
		FgColor int
		BgColor int
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			"bold_red_fg",
			"\x1b[1;31mX",
			Expectation{"X", true, 1, -1},
		},
		{
			"green_bg",
			"\x1b[42mY",
			Expectation{"Y", false, -1, 2},
		},
		{
			"256_color_fg",
			"\x1b[38;5;200mZ",
			Expectation{"Z", false, 200, -1},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			term := newTestTerminal(80, 24)
			term.WriteString(tc.Input)
			buf := term.Buffer()
			line := buf.Lines.Get(buf.YBase)
			cell := NewCellData()
			line.LoadCell(0, cell)
			fgColor := -1
			if !cell.IsFgDefault() {
				fgColor = cell.GetFgColor()
			}
			bgColor := -1
			if !cell.IsBgDefault() {
				bgColor = cell.GetBgColor()
			}
			got := Expectation{
				Chars:   cell.GetChars(),
				IsBold:  cell.IsBold() != 0,
				FgColor: fgColor,
				BgColor: bgColor,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestTerminalErase(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Line0 string
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			"erase_to_end_of_line",
			"ABCDEF\x1b[1;4H\x1b[K",
			Expectation{"ABC"},
		},
		{
			"erase_to_start_of_line",
			"ABCDEF\x1b[1;4H\x1b[1K",
			Expectation{"    EF"},
		},
		{
			"erase_entire_line",
			"ABCDEF\x1b[1;4H\x1b[2K",
			Expectation{""},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			term := newTestTerminal(80, 24)
			term.WriteString(tc.Input)
			got := Expectation{Line0: term.GetLine(0)}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestTerminalAltScreen(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	// Write to normal buffer.
	term.WriteString("NormalText")
	// Switch to alt screen (DECSET 1049). This saves cursor and clears alt.
	term.WriteString("\x1b[?1049h")
	// Move to beginning and write to alt buffer.
	term.WriteString("\x1b[H")
	term.WriteString("AltText")

	type Expectation struct {
		AltLine0    string
		NormalLine0 string
	}
	altLine := term.GetLine(0)

	// Switch back to normal screen (DECRST 1049).
	term.WriteString("\x1b[?1049l")
	normalLine := term.GetLine(0)

	got := Expectation{AltLine0: altLine, NormalLine0: normalLine}
	want := Expectation{AltLine0: "AltText", NormalLine0: "NormalText"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalResize(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("Hello")

	term.Resize(40, 10)

	type Expectation struct {
		Cols  int
		Rows  int
		Line0 string
	}
	want := Expectation{Cols: 40, Rows: 10, Line0: "Hello"}
	got := Expectation{
		Cols:  term.Cols(),
		Rows:  term.Rows(),
		Line0: term.GetLine(0),
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalIOWriter(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	n, err := fmt.Fprintf(term, "count=%d", 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	type Expectation struct {
		N     int
		Line0 string
	}
	want := Expectation{N: 8, Line0: "count=42"}
	got := Expectation{N: n, Line0: term.GetLine(0)}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalReset(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("Some text\r\nMore text")
	term.Reset()

	type Expectation struct {
		Line0 string
		CurX  int
		CurY  int
	}
	want := Expectation{Line0: "", CurX: 0, CurY: 0}
	got := Expectation{
		Line0: term.GetLine(0),
		CurX:  term.CursorX(),
		CurY:  term.CursorY(),
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalTitleChange(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var title string
	term.OnTitleChange(func(s string) { title = s })
	// OSC 2 ; <title> ST
	term.WriteString("\x1b]2;My Terminal\x1b\\")
	if title != "My Terminal" {
		t.Errorf("title = %q, want %q", title, "My Terminal")
	}
}

func TestTerminalIconNameChange(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var iconName string
	term.OnIconNameChange(func(s string) { iconName = s })

	// OSC 1 ; <name> BEL
	term.WriteString("\x1b]1;my-icon\x07")
	if iconName != "my-icon" {
		t.Errorf("iconName = %q, want %q", iconName, "my-icon")
	}
	if term.IconName() != "my-icon" {
		t.Errorf("IconName() = %q, want %q", term.IconName(), "my-icon")
	}
}

func TestTerminalOSC0_SetsTitleAndIconName(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var title, iconName string
	term.OnTitleChange(func(s string) { title = s })
	term.OnIconNameChange(func(s string) { iconName = s })

	// OSC 0 should set both.
	term.WriteString("\x1b]0;both\x07")
	if title != "both" {
		t.Errorf("title = %q, want %q", title, "both")
	}
	if iconName != "both" {
		t.Errorf("iconName = %q, want %q", iconName, "both")
	}
}

func TestTerminalBell(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	bellCount := 0
	term.OnBell(func() { bellCount++ })
	term.WriteString("\x07\x07")
	if bellCount != 2 {
		t.Errorf("bellCount = %d, want 2", bellCount)
	}
}

func TestTerminalDeviceAttributes(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var responses []string
	term.OnData(func(s string) { responses = append(responses, s) })
	// DA1: CSI c
	term.WriteString("\x1b[c")
	if len(responses) == 0 {
		t.Fatal("expected DA1 response, got none")
	}
	// DA1 response should start with ESC [ ? and end with c.
	resp := responses[0]
	if !strings.HasPrefix(resp, "\x1b[?") || !strings.HasSuffix(resp, "c") {
		t.Errorf("unexpected DA1 response: %q", resp)
	}
}

func TestTerminalGetLineOutOfRange(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("Hello")
	if got := term.GetLine(-1); got != "" {
		t.Errorf("GetLine(-1) = %q, want empty", got)
	}
	if got := term.GetLine(24); got != "" {
		t.Errorf("GetLine(24) = %q, want empty", got)
	}
}

func TestTerminalStringTrimsTrailingBlankLines(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("OnlyLine")
	s := term.String()
	if strings.Contains(s, "\n") {
		t.Errorf("String() should not contain newlines for single-line content, got %q", s)
	}
	if s != "OnlyLine" {
		t.Errorf("String() = %q, want %q", s, "OnlyLine")
	}
}

func TestTerminalLineFeedEvent(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	lfCount := 0
	term.OnLineFeed(func() { lfCount++ })
	term.WriteString("A\nB\nC")
	if lfCount != 2 {
		t.Errorf("linefeed count = %d, want 2", lfCount)
	}
}

func TestTerminalLegacyConPTYLineFeedWrapping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		Name        string
		WindowsPty  WindowsPty
		Input       string
		WantWrapped bool
	}{
		{
			Name:        "content in last cell marks line wrapped",
			WindowsPty:  WindowsPty{Backend: "conpty", BuildNo: 19000},
			Input:       "abcde\r\n",
			WantWrapped: true,
		},
		{
			Name:        "whitespace in last cell does not mark line wrapped",
			WindowsPty:  WindowsPty{Backend: "conpty", BuildNo: 19000},
			Input:       "abcd \r\n",
			WantWrapped: false,
		},
		{
			Name:        "null last cell does not mark line wrapped",
			WindowsPty:  WindowsPty{Backend: "conpty", BuildNo: 19000},
			Input:       "abcd\r\n",
			WantWrapped: false,
		},
		{
			Name:        "modern conpty build does not enable heuristic",
			WindowsPty:  WindowsPty{Backend: "conpty", BuildNo: 21376},
			Input:       "abcde\r\n",
			WantWrapped: false,
		},
		{
			Name:        "missing build number does not enable heuristic",
			WindowsPty:  WindowsPty{Backend: "conpty"},
			Input:       "abcde\r\n",
			WantWrapped: false,
		},
		{
			Name:        "build number only does not enable heuristic",
			WindowsPty:  WindowsPty{BuildNo: 19000},
			Input:       "abcde\r\n",
			WantWrapped: false,
		},
		{
			Name:        "non-conpty backend does not enable heuristic",
			WindowsPty:  WindowsPty{Backend: "winpty", BuildNo: 19000},
			Input:       "abcde\r\n",
			WantWrapped: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			term := New(WithCols(5), WithRows(3), WithWindowsPty(tc.WindowsPty))
			term.WriteString(tc.Input)

			buf := term.Buffer()
			line := buf.Lines.Get(buf.YBase + buf.Y)
			if line == nil {
				t.Fatal("current line is nil")
			}
			if line.IsWrapped != tc.WantWrapped {
				t.Errorf("IsWrapped = %v, want %v", line.IsWrapped, tc.WantWrapped)
			}
		})
	}
}

func TestTerminalLegacyConPTYWrappingTracksOptionChanges(t *testing.T) {
	t.Parallel()

	term := New(WithCols(5), WithRows(3))
	term.optionsService.SetOption("windowsPty", WindowsPty{Backend: "conpty", BuildNo: 19000})
	term.WriteString("abcde\r\n")

	buf := term.Buffer()
	line := buf.Lines.Get(buf.YBase + buf.Y)
	if line == nil || !line.IsWrapped {
		t.Fatal("enabling legacy ConPTY mode did not enable wrapping heuristic")
	}

	line.IsWrapped = false
	term.WriteString("\x1b[1;1H")
	if !line.IsWrapped {
		t.Fatal("CUP did not update wrapped state in legacy ConPTY mode")
	}

	term.optionsService.SetOption("windowsPty", WindowsPty{Backend: "conpty", BuildNo: 21376})
	line.IsWrapped = false
	term.WriteString("\x1b[1;1H")
	if line.IsWrapped {
		t.Fatal("CUP updated wrapped state after legacy ConPTY mode was disabled")
	}
}

func TestTerminalResizeClampMinimum(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.Resize(0, 0)
	if term.Cols() != MinimumCols {
		t.Errorf("Cols() = %d, want %d", term.Cols(), MinimumCols)
	}
	if term.Rows() != MinimumRows {
		t.Errorf("Rows() = %d, want %d", term.Rows(), MinimumRows)
	}
}

func TestTerminalResizeNoop(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	resizeCount := 0
	term.OnResizeEmitter.Event(func(BufferResizeEvent) { resizeCount++ })
	term.Resize(80, 24) // same dimensions — should be a no-op
	if resizeCount != 0 {
		t.Errorf("resize event fired %d times for no-op resize", resizeCount)
	}
}

func TestTerminalWriteBytes(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	n, err := term.Write([]byte("bytes"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 5 {
		t.Errorf("Write returned n=%d, want 5", n)
	}
	if got := term.GetLine(0); got != "bytes" {
		t.Errorf("GetLine(0) = %q, want %q", got, "bytes")
	}
}

func TestTerminalDefaultDimensions(t *testing.T) {
	t.Parallel()
	term := New() // no options — should use defaults (80x24)
	if term.Cols() != 80 {
		t.Errorf("Cols() = %d, want 80", term.Cols())
	}
	if term.Rows() != 24 {
		t.Errorf("Rows() = %d, want 24", term.Rows())
	}
}

func TestTerminalDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("Hello")
	term.Dispose() // should not panic
	term.Dispose() // should be idempotent
}

func TestTerminalWriteStringAfterDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("before")
	term.Dispose()

	term.WriteString("after")

	if got := term.GetLine(0); got != "before" {
		t.Errorf("GetLine(0) = %q after WriteString on disposed terminal, want %q", got, "before")
	}
}

func TestTerminalWriteAfterDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("before")
	term.Dispose()

	n, err := term.Write([]byte("after"))

	if err != nil {
		t.Fatalf("Write returned unexpected error: %v", err)
	}
	if n != len("after") {
		t.Errorf("Write returned n=%d, want %d", n, len("after"))
	}
	if got := term.GetLine(0); got != "before" {
		t.Errorf("GetLine(0) = %q after Write on disposed terminal, want %q", got, "before")
	}
}

func TestTerminalEraseDisplay(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("Line0\r\nLine1\r\nLine2")
	// ED 2 — erase entire display
	term.WriteString("\x1b[2J")
	for y := range 3 {
		if got := term.GetLine(y); got != "" {
			t.Errorf("GetLine(%d) = %q after ED2, want empty", y, got)
		}
	}
}

func TestTerminalCursorSaveRestore(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("\x1b[5;10H") // move to row 5, col 10
	term.WriteString("\x1b7")      // save cursor (DECSC)
	term.WriteString("\x1b[1;1H")  // move to 1,1
	term.WriteString("\x1b8")      // restore cursor (DECRC)
	type Expectation struct {
		X int
		Y int
	}
	want := Expectation{X: 9, Y: 4}
	got := Expectation{X: term.CursorX(), Y: term.CursorY()}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTerminalScrollRegion(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(20, 5)
	// Set scroll region to rows 2-4 (1-indexed: DECSTBM)
	term.WriteString("\x1b[2;4r")
	// Move to row 4 and write lines to trigger scrolling within region
	term.WriteString("\x1b[2;1H")
	term.WriteString("R2\r\nR3\r\nR4\r\nR5")
	// Row 1 (index 0) should be untouched
	if got := term.GetLine(0); got != "" {
		t.Errorf("GetLine(0) = %q, want empty (outside scroll region)", got)
	}
}

func TestTerminalOnRender(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var renders []RowRange
	term.OnRender(func(r RowRange) { renders = append(renders, r) })
	term.WriteString("Hello")
	if len(renders) == 0 {
		t.Fatal("expected OnRender to fire, got no events")
	}
	// The render event should cover row 0 (where "Hello" was written).
	found := false
	for _, r := range renders {
		if r.Start <= 0 && r.End >= 0 {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected render event covering row 0, got %v", renders)
	}
}

func TestTerminalOnRenderDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	d := term.OnRender(func(RowRange) { count++ })
	term.WriteString("A")
	if count == 0 {
		t.Fatal("expected OnRender to fire")
	}
	first := count
	d.Dispose()
	term.WriteString("B")
	if count != first {
		t.Errorf("OnRender fired after Dispose: count went from %d to %d", first, count)
	}
}

func TestTerminalRegisterApcHandler(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var received string
	// Register handler for APC identifier 'G' (0x47) — used by Kitty graphics protocol.
	term.RegisterApcHandler(FunctionIdentifier{Final: 'G'}, func(data string) bool {
		received = data
		return true
	})
	// Send APC G <payload> ST: ESC _ G <payload> ESC backslash
	term.WriteString("\x1b_Ghello-apc\x1b\\")
	if received != "hello-apc" {
		t.Errorf("APC handler received %q, want %q", received, "hello-apc")
	}
}

func TestTerminalRegisterApcHandlerDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	callCount := 0
	d := term.RegisterApcHandler(FunctionIdentifier{Final: 'G'}, func(data string) bool {
		callCount++
		return true
	})
	term.WriteString("\x1b_Gfirst\x1b\\")
	if callCount != 1 {
		t.Fatalf("expected 1 call, got %d", callCount)
	}
	d.Dispose()
	term.WriteString("\x1b_Gsecond\x1b\\")
	if callCount != 1 {
		t.Errorf("APC handler called after Dispose: count = %d, want 1", callCount)
	}
}

func TestTerminalOnCursorMove(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	moveCount := 0
	term.OnCursorMove(func() { moveCount++ })
	// CUP (cursor position) triggers a cursor move event.
	term.WriteString("\x1b[5;10H")
	if moveCount == 0 {
		t.Error("expected OnCursorMove to fire, got 0 events")
	}
}

func TestTerminalOnCursorMoveDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	d := term.OnCursorMove(func() { count++ })
	term.WriteString("\x1b[2;1H")
	if count == 0 {
		t.Fatal("expected OnCursorMove to fire")
	}
	first := count
	d.Dispose()
	term.WriteString("\x1b[3;1H")
	if count != first {
		t.Errorf("OnCursorMove fired after Dispose: count went from %d to %d", first, count)
	}
}

func TestTerminalOnResize(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var events []BufferResizeEvent
	term.OnResize(func(e BufferResizeEvent) { events = append(events, e) })
	term.Resize(40, 10)
	if len(events) == 0 {
		t.Fatal("expected OnResize to fire, got no events")
	}
	got := events[len(events)-1]
	if got.Cols != 40 || got.Rows != 10 {
		t.Errorf("OnResize event = {Cols:%d, Rows:%d}, want {Cols:40, Rows:10}", got.Cols, got.Rows)
	}
}

func TestTerminalOnResizeDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	d := term.OnResize(func(BufferResizeEvent) { count++ })
	term.Resize(40, 10)
	if count == 0 {
		t.Fatal("expected OnResize to fire")
	}
	first := count
	d.Dispose()
	term.Resize(60, 20)
	if count != first {
		t.Errorf("OnResize fired after Dispose: count went from %d to %d", first, count)
	}
}

func TestTerminalOnScroll(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(20, 5)
	var scrollPositions []int
	term.OnScroll(func(pos int) { scrollPositions = append(scrollPositions, pos) })
	// Write enough lines to trigger scrolling in a 5-row terminal.
	for i := range 8 {
		term.WriteString(fmt.Sprintf("Line%d\r\n", i))
	}
	if len(scrollPositions) == 0 {
		t.Fatal("expected OnScroll to fire, got no events")
	}
}

func TestTerminalOnScrollDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(20, 5)
	count := 0
	d := term.OnScroll(func(int) { count++ })
	// Trigger scrolling.
	for i := range 8 {
		term.WriteString(fmt.Sprintf("Line%d\r\n", i))
	}
	if count == 0 {
		t.Fatal("expected OnScroll to fire")
	}
	first := count
	d.Dispose()
	// Write more to trigger additional scrolling.
	for i := range 5 {
		term.WriteString(fmt.Sprintf("More%d\r\n", i))
	}
	if count != first {
		t.Errorf("OnScroll fired after Dispose: count went from %d to %d", first, count)
	}
}

func TestTerminalTabStops(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	term.WriteString("A\tB")
	line := term.GetLine(0)
	// Default tab stop is 8, so 'A' at 0, tab to 8, 'B' at 8.
	if !strings.Contains(line, "A") || !strings.Contains(line, "B") {
		t.Errorf("GetLine(0) = %q, expected A and B with tab spacing", line)
	}
	if term.CursorX() != 9 {
		t.Errorf("CursorX() = %d, want 9 (after tab + B)", term.CursorX())
	}
}

func TestTerminalRegisterCsiHandler(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)

	var called bool
	var gotParams []int32
	d := term.RegisterCsiHandler(FunctionIdentifier{Final: 'Z'}, func(params *Params) bool {
		called = true
		gotParams = make([]int32, params.Length)
		copy(gotParams, params.Params[:params.Length])
		return true
	})

	// Send CSI 1;2 Z
	term.WriteString("\x1b[1;2Z")
	if !called {
		t.Fatal("CSI handler was not called")
	}
	if len(gotParams) < 2 || gotParams[0] != 1 || gotParams[1] != 2 {
		t.Fatalf("got params %v, want [1 2]", gotParams)
	}

	// Dispose and verify handler no longer fires.
	called = false
	d.Dispose()
	term.WriteString("\x1b[1;2Z")
	if called {
		t.Fatal("CSI handler was called after Dispose")
	}
}

func TestTerminalRegisterCsiHandlerWindowOptionGate(t *testing.T) {
	t.Parallel()

	t.Run("blocked when window option not permitted", func(t *testing.T) {
		t.Parallel()
		// Default WindowOptions has all fields false — handler should be blocked.
		term := New(WithCols(80), WithRows(24))

		var called bool
		term.RegisterCsiHandler(FunctionIdentifier{Final: 't'}, func(params *Params) bool {
			called = true
			return true
		})

		// Send CSI 18 t (getWinSizeChars)
		term.WriteString("\x1b[18t")
		if called {
			t.Fatal("CSI t handler was called despite window option not being permitted")
		}
	})

	t.Run("allowed when window option is permitted", func(t *testing.T) {
		t.Parallel()
		term := New(WithCols(80), WithRows(24), WithWindowOptions(WindowOptions{
			GetWinSizeChars: true,
		}))

		var called bool
		var gotParam int32
		term.RegisterCsiHandler(FunctionIdentifier{Final: 't'}, func(params *Params) bool {
			called = true
			if params.Length > 0 {
				gotParam = params.Params[0]
			}
			return true
		})

		// Send CSI 18 t (getWinSizeChars — permitted)
		term.WriteString("\x1b[18t")
		if !called {
			t.Fatal("CSI t handler was not called despite window option being permitted")
		}
		if gotParam != 18 {
			t.Fatalf("got param %d, want 18", gotParam)
		}
	})

	t.Run("only matching sub-command is allowed", func(t *testing.T) {
		t.Parallel()
		term := New(WithCols(80), WithRows(24), WithWindowOptions(WindowOptions{
			GetWinSizeChars: true, // permits param 18
		}))

		var called bool
		term.RegisterCsiHandler(FunctionIdentifier{Final: 't'}, func(params *Params) bool {
			called = true
			return true
		})

		// Send CSI 14 t (getWinSizePixels — NOT permitted)
		term.WriteString("\x1b[14t")
		if called {
			t.Fatal("CSI t handler was called for a non-permitted sub-command")
		}
	})

	t.Run("non-t CSI handler is not gated", func(t *testing.T) {
		t.Parallel()
		term := New(WithCols(80), WithRows(24))

		var called bool
		term.RegisterCsiHandler(FunctionIdentifier{Final: 'Z'}, func(params *Params) bool {
			called = true
			return true
		})

		term.WriteString("\x1b[18Z")
		if !called {
			t.Fatal("non-t CSI handler should not be gated by window options")
		}
	})

	t.Run("CSI t with prefix is not gated", func(t *testing.T) {
		t.Parallel()
		term := New(WithCols(80), WithRows(24))

		var called bool
		term.RegisterCsiHandler(FunctionIdentifier{Prefix: '>', Final: 't'}, func(params *Params) bool {
			called = true
			return true
		})

		// Send CSI > 18 t
		term.WriteString("\x1b[>18t")
		if !called {
			t.Fatal("CSI > t handler should not be gated by window options")
		}
	})
}

func TestTerminalRegisterEscHandler(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)

	var called bool
	d := term.RegisterEscHandler(FunctionIdentifier{Intermediates: "#", Final: '9'}, func() bool {
		called = true
		return true
	})

	// Send ESC # 9
	term.WriteString("\x1b#9")
	if !called {
		t.Fatal("ESC handler was not called")
	}

	// Dispose and verify handler no longer fires.
	called = false
	d.Dispose()
	term.WriteString("\x1b#9")
	if called {
		t.Fatal("ESC handler was called after Dispose")
	}
}

func TestTerminalRegisterDcsHandler(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)

	var gotData string
	d := term.RegisterDcsHandler(FunctionIdentifier{Final: 'z'}, NewDcsStringHandler(func(data string, params *Params) bool {
		gotData = data
		return true
	}))

	// Send DCS z <payload> ST (DCS = ESC P, ST = ESC \)
	term.WriteString("\x1bPz" + "hello" + "\x1b\\")
	if gotData != "hello" {
		t.Fatalf("DCS handler got data %q, want %q", gotData, "hello")
	}

	// Dispose and verify handler no longer fires.
	gotData = ""
	d.Dispose()
	term.WriteString("\x1bPz" + "world" + "\x1b\\")
	if gotData != "" {
		t.Fatalf("DCS handler got data %q after Dispose, want empty", gotData)
	}
}

func TestTerminalRegisterOscHandler(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)

	var gotData string
	// Use a high OSC number unlikely to conflict with built-in handlers.
	d := term.RegisterOscHandler(9999, NewOscStringHandler(func(data string) bool {
		gotData = data
		return true
	}))

	// Send OSC 9999 ; payload BEL
	term.WriteString("\x1b]9999;test-payload\x07")
	if gotData != "test-payload" {
		t.Fatalf("OSC handler got data %q, want %q", gotData, "test-payload")
	}

	// Dispose and verify handler no longer fires.
	gotData = ""
	d.Dispose()
	term.WriteString("\x1b]9999;after-dispose\x07")
	if gotData != "" {
		t.Fatalf("OSC handler got data %q after Dispose, want empty", gotData)
	}
}

// fillScrollback writes enough lines to the terminal to create scrollback content.
func fillScrollback(term *Terminal, lineCount int) {
	for i := range lineCount {
		term.WriteString(fmt.Sprintf("line %d\r\n", i))
	}
}

func TestTerminalScrollLines(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YDisp int
		YBase int
	}

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	yBase := term.Buffer().YBase

	// Scroll up 3 lines
	term.ScrollLines(-3)

	got := Expectation{
		YDisp: term.Buffer().YDisp,
		YBase: term.Buffer().YBase,
	}
	expected := Expectation{
		YDisp: yBase - 3,
		YBase: yBase,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestTerminalScrollLinesDown(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	// Scroll up then back down
	term.ScrollLines(-5)
	term.ScrollLines(5)

	if term.Buffer().YDisp != term.Buffer().YBase {
		t.Errorf("YDisp = %d, want %d (YBase)", term.Buffer().YDisp, term.Buffer().YBase)
	}
}

func TestTerminalScrollPages(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 30)

	yBase := term.Buffer().YBase

	// Scroll up 2 pages (2 * 5 rows = 10 lines)
	term.ScrollPages(-2)

	expected := yBase - 10
	if term.Buffer().YDisp != expected {
		t.Errorf("YDisp = %d, want %d", term.Buffer().YDisp, expected)
	}
}

func TestTerminalScrollToTop(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	term.ScrollToTop()

	if term.Buffer().YDisp != 0 {
		t.Errorf("YDisp = %d, want 0", term.Buffer().YDisp)
	}
}

func TestTerminalScrollToBottom(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	// Scroll to top first, then back to bottom
	term.ScrollToTop()
	term.ScrollToBottom()

	if term.Buffer().YDisp != term.Buffer().YBase {
		t.Errorf("YDisp = %d, want %d (YBase)", term.Buffer().YDisp, term.Buffer().YBase)
	}
}

func TestTerminalScrollToLine(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	term.ScrollToLine(5)

	if term.Buffer().YDisp != 5 {
		t.Errorf("YDisp = %d, want 5", term.Buffer().YDisp)
	}
}

func TestTerminalScrollToLineClamps(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	// Scroll to a line beyond YBase — should clamp to YBase
	term.ScrollToLine(9999)

	if term.Buffer().YDisp != term.Buffer().YBase {
		t.Errorf("YDisp = %d, want %d (YBase)", term.Buffer().YDisp, term.Buffer().YBase)
	}
}

func TestTerminalScrollNoScrollback(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	// No scrollback content — scrolling should be a no-op
	term.ScrollLines(-5)

	if term.Buffer().YDisp != 0 {
		t.Errorf("YDisp = %d, want 0", term.Buffer().YDisp)
	}
}

func TestTerminalClear(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Y     int
		YBase int
		YDisp int
	}

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	// Scroll up to simulate user scrolling
	term.ScrollToTop()

	term.Clear()

	got := Expectation{
		Y:     term.Buffer().Y,
		YBase: term.Buffer().YBase,
		YDisp: term.Buffer().YDisp,
	}
	expected := Expectation{
		Y:     0,
		YBase: 0,
		YDisp: 0,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestTerminalClearMovesCurrentLineToTop(t *testing.T) {
	t.Parallel()

	term := New(WithCols(10), WithRows(5), WithScrollback(100))
	for i := 0; i < 10; i++ {
		term.WriteString(fmt.Sprintf("line%d\r\n", i))
	}
	term.WriteString("current")

	term.Clear()

	buf := term.Buffer()
	if buf.Y != 0 {
		t.Errorf("Y = %d, want 0", buf.Y)
	}

	line0 := buf.Lines.Get(0)
	if line0 == nil {
		t.Fatal("line 0 is nil")
	}
	text := line0.TranslateToString(true, 0, -1)
	if text != "current" {
		t.Errorf("line 0 text = %q, want %q", text, "current")
	}

	// Remaining viewport rows should be blank.
	for i := 1; i < 5; i++ {
		line := buf.Lines.Get(i)
		if line == nil {
			t.Fatalf("line %d is nil", i)
		}
		trimmed := line.GetTrimmedLength()
		if trimmed != 0 {
			t.Errorf("line %d trimmed length = %d, want 0", i, trimmed)
		}
	}

	// Buffer length should equal the number of rows (no scrollback).
	if buf.Lines.Length() != 5 {
		t.Errorf("buffer length = %d, want 5", buf.Lines.Length())
	}
}

func TestTerminalClearAtCursorHome(t *testing.T) {
	t.Parallel()

	term := New(WithCols(10), WithRows(3), WithScrollback(10))

	// Write three lines, then home the cursor without scrolling so that
	// YBase == 0 && Y == 0 while rows below the cursor still hold content.
	term.WriteString("line0\r\nline1\r\nline2\x1b[H")

	buf := term.Buffer()
	if buf.YBase != 0 || buf.Y != 0 {
		t.Fatalf("precondition: YBase=%d Y=%d, want 0/0", buf.YBase, buf.Y)
	}

	term.Clear()

	buf = term.Buffer()
	for row := 1; row < 3; row++ {
		line := buf.Lines.Get(row)
		if line == nil {
			t.Fatalf("line %d is nil", row)
		}
		got := strings.TrimRight(line.TranslateToString(true, 0, -1), " ")
		if got != "" {
			t.Errorf("row %d = %q, want empty after Clear()", row, got)
		}
	}
}

func TestTerminalClearEmptyTerminal(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	// Clear on empty terminal should be a no-op (no panic)
	term.Clear()

	if term.Buffer().YBase != 0 {
		t.Errorf("YBase = %d, want 0", term.Buffer().YBase)
	}
}

func TestTerminalClearDisposesMarkerAtCursorHome(t *testing.T) {
	t.Parallel()

	term := New(WithCols(10), WithRows(3), WithScrollback(10))
	marker := term.RegisterMarker(0)
	if marker == nil {
		t.Fatal("RegisterMarker returned nil")
	}

	term.Clear()

	if !marker.IsDisposed {
		t.Error("marker should be disposed after Clear()")
	}
	if got := len(term.Buffer().Markers); got != 0 {
		t.Errorf("markers after Clear = %d, want 0", got)
	}
}

func TestTerminalClearFiresScrollEvent(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	scrollFired := false
	term.OnScroll(func(int) { scrollFired = true })

	term.Clear()

	if !scrollFired {
		t.Error("expected OnScroll to fire after Clear()")
	}
}

func TestTerminalClearDisposesMarkers(t *testing.T) {
	t.Parallel()

	term := New(WithCols(80), WithRows(24), WithScrollback(100))
	for i := 0; i < 30; i++ {
		term.WriteString("line\r\n")
	}
	m := term.AddMarker(0)
	if m == nil {
		t.Fatal("AddMarker returned nil")
	}

	buf := term.Buffer()
	if len(buf.Markers) != 1 {
		t.Fatalf("markers before Clear = %d, want 1", len(buf.Markers))
	}

	term.Clear()

	if !m.IsDisposed {
		t.Error("marker should be disposed after Clear()")
	}
	if len(buf.Markers) != 0 {
		t.Errorf("markers after Clear = %d, want 0", len(buf.Markers))
	}
}

func TestTerminalAddMarker(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 24)
	term.WriteString("hello\r\nworld\r\n")

	// Cursor is at row 2 (0-based), add marker at cursor position
	marker := term.AddMarker(0)
	if marker == nil {
		t.Fatal("AddMarker returned nil")
	}

	expectedLine := term.Buffer().YBase + term.CursorY()
	if marker.Line != expectedLine {
		t.Errorf("marker.Line = %d, want %d", marker.Line, expectedLine)
	}
}

func TestTerminalRegisterMarker(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 24)
	term.WriteString("hello\r\nworld\r\n")

	marker := term.RegisterMarker(0)
	if marker == nil {
		t.Fatal("RegisterMarker returned nil")
	}

	expectedLine := term.Buffer().YBase + term.CursorY()
	if marker.Line != expectedLine {
		t.Errorf("marker.Line = %d, want %d", marker.Line, expectedLine)
	}
}

func TestTerminalAddMarkerDelegatesToRegisterMarker(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 24)
	term.WriteString("line1\r\nline2\r\nline3\r\n")

	marker := term.AddMarker(-1)
	if marker == nil {
		t.Fatal("AddMarker returned nil")
	}

	expectedLine := term.Buffer().YBase + term.CursorY() - 1
	if marker.Line != expectedLine {
		t.Errorf("marker.Line = %d, want %d", marker.Line, expectedLine)
	}
}

func TestTerminalAddMarkerWithOffset(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 24)
	term.WriteString("line1\r\nline2\r\nline3\r\n")

	// Add marker 1 line above cursor
	marker := term.AddMarker(-1)
	if marker == nil {
		t.Fatal("AddMarker returned nil")
	}

	expectedLine := term.Buffer().YBase + term.CursorY() - 1
	if marker.Line != expectedLine {
		t.Errorf("marker.Line = %d, want %d", marker.Line, expectedLine)
	}
}

func TestTerminalScrollLinesFiresEvent(t *testing.T) {
	t.Parallel()

	term := newTestTerminal(80, 5)
	fillScrollback(term, 20)

	scrollEvents := 0
	term.OnScroll(func(int) { scrollEvents++ })

	term.ScrollLines(-3)

	if scrollEvents != 1 {
		t.Errorf("scroll events = %d, want 1", scrollEvents)
	}
}

func TestTerminalOnColor(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var got []ColorEvent
	term.OnColor(func(events []ColorEvent) { got = events })

	// OSC 4 ; 1 ; #ff0000 BEL — set indexed color 1 to red.
	term.WriteString("\x1b]4;1;#ff0000\x07")

	if len(got) == 0 {
		t.Fatal("expected OnColor to fire, got no events")
	}
	if got[0].Type != ColorRequestSet {
		t.Errorf("ColorEvent.Type = %v, want ColorRequestSet", got[0].Type)
	}
	if got[0].Index != 1 {
		t.Errorf("ColorEvent.Index = %d, want 1", got[0].Index)
	}
	if got[0].Color == nil || *got[0].Color != (ColorRGB{0xff, 0x00, 0x00}) {
		t.Errorf("ColorEvent.Color = %v, want &{255 0 0}", got[0].Color)
	}
}

func TestTerminalOnColorDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	d := term.OnColor(func([]ColorEvent) { count++ })

	term.WriteString("\x1b]4;1;#ff0000\x07")
	if count == 0 {
		t.Fatal("expected OnColor to fire")
	}
	first := count
	d.Dispose()
	term.WriteString("\x1b]4;2;#00ff00\x07")
	if count != first {
		t.Errorf("OnColor fired after Dispose: count went from %d to %d", first, count)
	}
}

func TestTerminalOnA11yTab(t *testing.T) {
	t.Parallel()
	term := New(WithCols(80), WithRows(24), WithScrollback(1000), WithScreenReaderMode(true))
	var tabWidths []int
	term.OnA11yTab(func(n int) { tabWidths = append(tabWidths, n) })

	// Tab character triggers OnA11yTab when ScreenReaderMode is enabled.
	term.WriteString("\t")

	if len(tabWidths) == 0 {
		t.Fatal("expected OnA11yTab to fire, got no events")
	}
	if tabWidths[0] != 8 {
		t.Errorf("OnA11yTab width = %d, want 8 (default tab stop)", tabWidths[0])
	}
}

func TestTerminalOnA11yTabDispose(t *testing.T) {
	t.Parallel()
	term := New(WithCols(80), WithRows(24), WithScrollback(1000), WithScreenReaderMode(true))
	count := 0
	d := term.OnA11yTab(func(int) { count++ })

	term.WriteString("\t")
	if count == 0 {
		t.Fatal("expected OnA11yTab to fire")
	}
	first := count
	d.Dispose()
	term.WriteString("\t")
	if count != first {
		t.Errorf("OnA11yTab fired after Dispose: count went from %d to %d", first, count)
	}
}

func TestTerminalOnA11yChar(t *testing.T) {
	t.Parallel()
	term := New(WithCols(80), WithRows(24), WithScrollback(1000), WithScreenReaderMode(true))
	var chars []string
	term.OnA11yChar(func(ch string) {
		chars = append(chars, ch)
	})

	term.WriteString("ABC")

	if len(chars) != 3 {
		t.Fatalf("expected 3 OnA11yChar events, got %d", len(chars))
	}
	want := []string{"A", "B", "C"}
	for i, w := range want {
		if chars[i] != w {
			t.Errorf("OnA11yChar[%d] = %q, want %q", i, chars[i], w)
		}
	}
}

func TestTerminalOnA11yCharDisabled(t *testing.T) {
	t.Parallel()
	// When ScreenReaderMode is off, OnA11yChar must not fire.
	term := New(WithCols(80), WithRows(24), WithScrollback(1000))
	count := 0
	term.OnA11yChar(func(string) { count++ })

	term.WriteString("ABC")

	if count != 0 {
		t.Errorf("OnA11yChar fired %d times with ScreenReaderMode disabled, want 0", count)
	}
}

func TestTerminalOnA11yCharDispose(t *testing.T) {
	t.Parallel()
	term := New(WithCols(80), WithRows(24), WithScrollback(1000), WithScreenReaderMode(true))
	count := 0
	d := term.OnA11yChar(func(string) { count++ })
	if d == nil {
		t.Fatal("OnA11yChar returned nil Disposable")
	}

	term.WriteString("A")
	if count != 1 {
		t.Fatalf("expected 1 OnA11yChar event, got %d", count)
	}

	d.Dispose()
	term.WriteString("B")
	if count != 1 {
		t.Errorf("OnA11yChar fired after Dispose: count = %d, want 1", count)
	}
}

func TestTerminalOnRequestColorSchemeQuery(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	fired := 0
	term.OnRequestColorSchemeQuery(func() {
		fired++
	})

	// Enable color scheme updates and send DSR 996.
	term.WriteString("\x1b[?2031h")
	term.WriteString("\x1b[?996n")

	if fired != 1 {
		t.Errorf("expected OnRequestColorSchemeQuery to fire once via Terminal, got %d", fired)
	}
}

func TestTerminalOnRequestColorSchemeQueryDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	fired := 0
	d := term.OnRequestColorSchemeQuery(func() {
		fired++
	})

	// Enable color scheme updates and send DSR 996.
	term.WriteString("\x1b[?2031h")
	term.WriteString("\x1b[?996n")
	if fired != 1 {
		t.Fatalf("expected 1 fire before dispose, got %d", fired)
	}

	// Dispose the listener and send again.
	d.Dispose()
	term.WriteString("\x1b[?996n")
	if fired != 1 {
		t.Errorf("expected no additional fires after dispose, got %d", fired)
	}
}

func TestTerminalOnBinary(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	var got []string
	term.OnBinary(func(data string) { got = append(got, data) })

	// Trigger a binary event via the core service (the plumbing path).
	term.coreService.TriggerBinaryEvent("\x1b[2J")

	if len(got) != 1 {
		t.Fatalf("expected 1 OnBinary event, got %d", len(got))
	}
	if got[0] != "\x1b[2J" {
		t.Errorf("OnBinary data = %q, want %q", got[0], "\x1b[2J")
	}
}

func TestTerminalOnBinaryDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	d := term.OnBinary(func(string) { count++ })

	term.coreService.TriggerBinaryEvent("data1")
	if count != 1 {
		t.Fatalf("expected 1 fire before dispose, got %d", count)
	}

	d.Dispose()
	term.coreService.TriggerBinaryEvent("data2")
	if count != 1 {
		t.Errorf("OnBinary fired after Dispose: count = %d, want 1", count)
	}
}

func TestTerminalOnWriteParsed(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	term.OnWriteParsed(func() { count++ })

	term.WriteString("hello")
	if count != 1 {
		t.Fatalf("expected 1 OnWriteParsed after WriteString, got %d", count)
	}

	term.Write([]byte("world"))
	if count != 2 {
		t.Fatalf("expected 2 OnWriteParsed after Write, got %d", count)
	}
}

func TestTerminalOnWriteParsedDispose(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	d := term.OnWriteParsed(func() { count++ })

	term.WriteString("hello")
	if count != 1 {
		t.Fatalf("expected 1 fire before dispose, got %d", count)
	}

	d.Dispose()
	term.WriteString("world")
	if count != 1 {
		t.Errorf("OnWriteParsed fired after Dispose: count = %d, want 1", count)
	}
}

func TestTerminalOnWriteParsedMultipleWrites(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	count := 0
	term.OnWriteParsed(func() { count++ })

	// Each write should fire exactly once.
	for i := range 5 {
		term.WriteString(fmt.Sprintf("line %d\r\n", i))
	}
	if count != 5 {
		t.Errorf("expected 5 OnWriteParsed fires, got %d", count)
	}
}
