package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

// allVtExtensions returns a VtExtensions with every extension enabled.
func allVtExtensions() VtExtensions {
	t := true
	return VtExtensions{
		KittyKeyboard:            true,
		ColorSchemeQuery:         &t,
		Win32InputMode:           true,
		KittySgrBoldFaintControl: &t,
	}
}

// newTestInputHandler creates an InputHandler with all VtExtensions enabled.
func newTestInputHandler(cols, rows int) *InputHandler {
	return newTestInputHandlerWithVtExt(cols, rows, allVtExtensions())
}

// newTestInputHandlerWithVtExt creates an InputHandler with the given VtExtensions.
func newTestInputHandlerWithVtExt(cols, rows int, ext VtExtensions) *InputHandler {
	opts := DefaultOptions()
	opts.Cols = cols
	opts.Rows = rows
	opts.Scrollback = 1000
	opts.VtExtensions = ext
	optsSvc := NewOptionsService(&opts)
	bufSvc := NewBufferService(optsSvc)
	charSvc := NewCharsetService()
	coreSvc := NewCoreService(optsSvc)
	oscLinkSvc := NewOscLinkService(bufSvc)
	uniSvc := NewUnicodeService()
	return NewInputHandler(bufSvc, charSvc, coreSvc, optsSvc, oscLinkSvc, uniSvc)
}

func TestCursorPosition(t *testing.T) {
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
		{"move_to_1_1", "\x1b[1;1H", Expectation{0, 0}},
		{"move_to_5_10", "\x1b[5;10H", Expectation{9, 4}},
		{"default_is_1_1", "\x1b[H", Expectation{0, 0}},
		{"clamp_to_bounds", "\x1b[999;999H", Expectation{79, 23}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			buf := h.activeBuffer()
			got := Expectation{X: buf.X, Y: buf.Y}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestCursorMovement(t *testing.T) {
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
		{"CUU_up_1", "\x1b[5;5H\x1b[A", Expectation{4, 3}},
		{"CUU_up_3", "\x1b[5;5H\x1b[3A", Expectation{4, 1}},
		{"CUU_clamp_top", "\x1b[2;5H\x1b[99A", Expectation{4, 0}},
		{"CUD_down_1", "\x1b[5;5H\x1b[B", Expectation{4, 5}},
		{"CUD_down_3", "\x1b[5;5H\x1b[3B", Expectation{4, 7}},
		{"CUD_clamp_bottom", "\x1b[5;5H\x1b[99B", Expectation{4, 23}},
		{"CUF_forward_1", "\x1b[5;5H\x1b[C", Expectation{5, 4}},
		{"CUF_forward_5", "\x1b[5;5H\x1b[5C", Expectation{9, 4}},
		{"CUF_clamp_right", "\x1b[5;5H\x1b[999C", Expectation{79, 4}},
		{"CUB_backward_1", "\x1b[5;5H\x1b[D", Expectation{3, 4}},
		{"CUB_backward_3", "\x1b[5;5H\x1b[3D", Expectation{1, 4}},
		{"CUB_clamp_left", "\x1b[5;5H\x1b[999D", Expectation{0, 4}},
		{"CNL_next_line", "\x1b[5;5H\x1b[E", Expectation{0, 5}},
		{"CPL_preceding_line", "\x1b[5;5H\x1b[F", Expectation{0, 3}},
		{"CHA_column", "\x1b[5;5H\x1b[10G", Expectation{9, 4}},
		{"VPA_row", "\x1b[5;5H\x1b[10d", Expectation{4, 9}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			buf := h.activeBuffer()
			got := Expectation{X: buf.X, Y: buf.Y}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestEraseInDisplay(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LineContent string
		Err         string
	}
	tests := []struct {
		Name     string
		Setup    string // write some content first
		Erase    string // erase sequence
		CheckRow int    // which row to check
		Expected Expectation
	}{
		{
			Name:     "ED_0_erase_below",
			Setup:    "AAAA\x1b[2;1HBBBB\x1b[3;1HCCCC",
			Erase:    "\x1b[2;3H\x1b[0J", // cursor at row 2, col 3, erase below
			CheckRow: 2,                  // row 3 (0-indexed) should be blank
			Expected: Expectation{LineContent: ""},
		},
		{
			Name:     "ED_1_erase_above",
			Setup:    "AAAA\x1b[2;1HBBBB\x1b[3;1HCCCC",
			Erase:    "\x1b[2;3H\x1b[1J", // erase above
			CheckRow: 0,                  // row 1 should be blank
			Expected: Expectation{LineContent: ""},
		},
		{
			Name:     "ED_2_erase_all",
			Setup:    "AAAA\x1b[2;1HBBBB",
			Erase:    "\x1b[2J",
			CheckRow: 0,
			Expected: Expectation{LineContent: ""},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Setup)
			h.ParseString(tc.Erase)
			buf := h.activeBuffer()
			line := buf.Lines.Get(buf.YBase + tc.CheckRow)
			var got Expectation
			if line != nil {
				got.LineContent = line.TranslateToString(true, 0, -1)
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestEraseInDisplayScrollbackResetsUserScrolling(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(10, 5)
	for range 20 {
		h.ParseString("old\r\n")
	}
	h.bufferService.ScrollLines(-5, false)
	if !h.bufferService.IsUserScrolling {
		t.Fatal("expected user scrolling before ED3")
	}

	h.ParseString("\x1b[3J")
	if h.bufferService.IsUserScrolling {
		t.Fatal("expected ED3 on the normal buffer to reset user scrolling")
	}

	for range 20 {
		h.ParseString("new\r\n")
	}
	buf := h.activeBuffer()
	if buf.YDisp != buf.YBase {
		t.Fatalf("YDisp=%d YBase=%d, want viewport to follow bottom", buf.YDisp, buf.YBase)
	}
}

func TestEraseInDisplayScrollbackOnAltPreservesUserScrolling(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(10, 5)
	for range 20 {
		h.ParseString("old\r\n")
	}
	h.bufferService.ScrollLines(-5, false)
	if !h.bufferService.IsUserScrolling {
		t.Fatal("expected user scrolling before activating the alternate buffer")
	}

	h.ParseString("\x1b[?1049h\x1b[3J")
	if !h.bufferService.IsUserScrolling {
		t.Fatal("expected ED3 on the alternate buffer to preserve normal-buffer user scrolling")
	}
}

func TestEraseInLine(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LineContent string
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			Name:     "EL_0_erase_right",
			Input:    "ABCDEFGH\x1b[1;4H\x1b[0K",
			Expected: Expectation{LineContent: "ABC"},
		},
		{
			Name:     "EL_1_erase_left",
			Input:    "ABCDEFGH\x1b[1;4H\x1b[1K",
			Expected: Expectation{LineContent: "    EFGH"},
		},
		{
			Name:     "EL_2_erase_all",
			Input:    "ABCDEFGH\x1b[1;4H\x1b[2K",
			Expected: Expectation{LineContent: ""},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			buf := h.activeBuffer()
			line := buf.Lines.Get(buf.YBase)
			var got Expectation
			if line != nil {
				got.LineContent = line.TranslateToString(true, 0, -1)
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

// TestEraseInLineBCE verifies that EL (Erase in Line) fills erased cells with the
// current background color (Back Color Erase).
func TestEraseInLineBCE(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	// Set green background (SGR 42), write text, move cursor back, erase right.
	h.ParseString("\x1b[42mABCDEFGH\x1b[1;4H\x1b[0K")

	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase)
	if line == nil {
		t.Fatal("expected line")
	}
	// Cells 0-2 ("ABC") should have green bg from when they were written.
	// Cells 3+ should have green bg from BCE (erase inherits current bg).
	cell := NewCellData()
	for col := 3; col < 8; col++ {
		line.LoadCell(col, cell)
		if !cell.IsBgPalette() || cell.GetBgColor() != 2 {
			t.Errorf("cell[%d]: expected green bg (palette 2), got bgMode=0x%x bgColor=%d",
				col, cell.GetBgColorMode(), cell.GetBgColor())
		}
	}
}

// TestEraseInDisplayBCE verifies that ED (Erase in Display) fills erased cells with
// the current background color.
func TestEraseInDisplayBCE(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	// Set red background, write content, then erase display.
	h.ParseString("\x1b[41mHello\x1b[2J")

	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase)
	if line == nil {
		t.Fatal("expected line")
	}
	cell := NewCellData()
	line.LoadCell(0, cell)
	if !cell.IsBgPalette() || cell.GetBgColor() != 1 {
		t.Errorf("cell[0]: expected red bg (palette 1), got bgMode=0x%x bgColor=%d",
			cell.GetBgColorMode(), cell.GetBgColor())
	}
}

func TestInsertDeleteChars(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LineContent string
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			Name:     "ICH_insert_2",
			Input:    "ABCDEF\x1b[1;3H\x1b[2@",
			Expected: Expectation{LineContent: "AB  CDEF"},
		},
		{
			Name:     "DCH_delete_2",
			Input:    "ABCDEF\x1b[1;3H\x1b[2P",
			Expected: Expectation{LineContent: "ABEF"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			buf := h.activeBuffer()
			line := buf.Lines.Get(buf.YBase)
			var got Expectation
			if line != nil {
				got.LineContent = line.TranslateToString(true, 0, -1)
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestInsertDeleteLines(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Row0 string
		Row1 string
		Row2 string
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			Name:     "IL_insert_1",
			Input:    "AAA\x1b[2;1HBBB\x1b[3;1HCCC\x1b[2;1H\x1b[1L",
			Expected: Expectation{Row0: "AAA", Row1: "", Row2: "BBB"},
		},
		{
			Name:     "DL_delete_1",
			Input:    "AAA\x1b[2;1HBBB\x1b[3;1HCCC\x1b[2;1H\x1b[1M",
			Expected: Expectation{Row0: "AAA", Row1: "CCC", Row2: ""},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			buf := h.activeBuffer()
			getRow := func(y int) string {
				line := buf.Lines.Get(buf.YBase + y)
				if line == nil {
					return ""
				}
				return line.TranslateToString(true, 0, -1)
			}
			got := Expectation{Row0: getRow(0), Row1: getRow(1), Row2: getRow(2)}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestScrollUpDown(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Row0 string
		Row1 string
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			Name:     "SU_scroll_up_1",
			Input:    "AAA\x1b[2;1HBBB\x1b[1S",
			Expected: Expectation{Row0: "BBB", Row1: ""},
		},
		{
			Name:     "SD_scroll_down_1",
			Input:    "AAA\x1b[2;1HBBB\x1b[1T",
			Expected: Expectation{Row0: "", Row1: "AAA"},
		},
		{
			Name:     "SD_scroll_down_caret_alias",
			Input:    "AAA\x1b[2;1HBBB\x1b[1^",
			Expected: Expectation{Row0: "", Row1: "AAA"},
		},
		{
			Name:     "SD_scroll_down_caret_2",
			Input:    "AAA\x1b[2;1HBBB\x1b[2^",
			Expected: Expectation{Row0: "", Row1: ""},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			buf := h.activeBuffer()
			getRow := func(y int) string {
				line := buf.Lines.Get(buf.YBase + y)
				if line == nil {
					return ""
				}
				return line.TranslateToString(true, 0, -1)
			}
			got := Expectation{Row0: getRow(0), Row1: getRow(1)}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSetScrollRegion(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ScrollTop    int
		ScrollBottom int
		X            int
		Y            int
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			Name:     "set_5_to_10",
			Input:    "\x1b[5;10r",
			Expected: Expectation{ScrollTop: 4, ScrollBottom: 9, X: 0, Y: 0},
		},
		{
			Name:     "default_full_screen",
			Input:    "\x1b[r",
			Expected: Expectation{ScrollTop: 0, ScrollBottom: 23, X: 0, Y: 0},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			buf := h.activeBuffer()
			got := Expectation{
				ScrollTop:    buf.ScrollTop,
				ScrollBottom: buf.ScrollBottom,
				X:            buf.X,
				Y:            buf.Y,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSoftReset(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ScrollTop    int
		ScrollBottom int
		Origin       bool
		InsertMode   bool
	}
	h := newTestInputHandler(80, 24)
	// Set some modes
	h.ParseString("\x1b[5;10r") // set scroll region
	h.ParseString("\x1b[?6h")   // origin mode
	h.ParseString("\x1b[4h")    // insert mode
	h.ParseString("\x1b[!p")    // soft reset
	buf := h.activeBuffer()
	got := Expectation{
		ScrollTop:    buf.ScrollTop,
		ScrollBottom: buf.ScrollBottom,
		Origin:       h.coreService.DecPrivateModes.Origin,
		InsertMode:   h.coreService.Modes.InsertMode,
	}
	expected := Expectation{
		ScrollTop:    0,
		ScrollBottom: 23,
		Origin:       false,
		InsertMode:   false,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestSetResetMode(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		InsertMode            bool
		ApplicationCursorKeys bool
		Wraparound            bool
		BracketedPasteMode    bool
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			Name:     "set_insert_mode",
			Input:    "\x1b[4h",
			Expected: Expectation{InsertMode: true, Wraparound: true},
		},
		{
			Name:     "reset_insert_mode",
			Input:    "\x1b[4h\x1b[4l",
			Expected: Expectation{InsertMode: false, Wraparound: true},
		},
		{
			Name:     "DECSET_application_cursor_keys",
			Input:    "\x1b[?1h",
			Expected: Expectation{ApplicationCursorKeys: true, Wraparound: true},
		},
		{
			Name:     "DECRST_application_cursor_keys",
			Input:    "\x1b[?1h\x1b[?1l",
			Expected: Expectation{ApplicationCursorKeys: false, Wraparound: true},
		},
		{
			Name:     "DECSET_wraparound",
			Input:    "\x1b[?7h",
			Expected: Expectation{Wraparound: true},
		},
		{
			Name:     "DECRST_wraparound",
			Input:    "\x1b[?7l",
			Expected: Expectation{Wraparound: false},
		},
		{
			Name:     "DECSET_bracketed_paste",
			Input:    "\x1b[?2004h",
			Expected: Expectation{BracketedPasteMode: true, Wraparound: true},
		},
		{
			Name:     "DECRST_bracketed_paste",
			Input:    "\x1b[?2004h\x1b[?2004l",
			Expected: Expectation{BracketedPasteMode: false, Wraparound: true},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			got := Expectation{
				InsertMode:            h.coreService.Modes.InsertMode,
				ApplicationCursorKeys: h.coreService.DecPrivateModes.ApplicationCursorKeys,
				Wraparound:            h.coreService.DecPrivateModes.Wraparound,
				BracketedPasteMode:    h.coreService.DecPrivateModes.BracketedPasteMode,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestAltScreenBuffer(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		IsAlt bool
		Row0  string
	}
	h := newTestInputHandler(80, 24)
	h.ParseString("HELLO")
	// Switch to alt buffer (DECSET 1049) — saves cursor then switches
	h.ParseString("\x1b[?1049h")
	isAlt := h.bufferService.Buffer() == h.bufferService.Buffers.Alt()
	// Move to home position and write
	h.ParseString("\x1b[H" + "ALT")
	altRow := h.activeBuffer().Lines.Get(h.activeBuffer().YBase).TranslateToString(true, 0, -1)
	got := Expectation{IsAlt: isAlt, Row0: altRow}
	expected := Expectation{IsAlt: true, Row0: "ALT"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("alt screen mismatch (-want +got):\n%s", diff)
	}

	// Switch back (DECRST 1049)
	h.ParseString("\x1b[?1049l")
	isNormal := h.bufferService.Buffer() == h.bufferService.Buffers.Normal()
	normalRow := h.activeBuffer().Lines.Get(h.activeBuffer().YBase).TranslateToString(true, 0, -1)
	got2 := Expectation{IsAlt: !isNormal, Row0: normalRow}
	expected2 := Expectation{IsAlt: false, Row0: "HELLO"}
	if diff := cmp.Diff(expected2, got2); diff != "" {
		t.Errorf("normal screen mismatch (-want +got):\n%s", diff)
	}
}

func TestDeviceStatus(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Response string
	}
	h := newTestInputHandler(80, 24)
	var response string
	h.coreService.OnDataEmitter.Event(func(data string) {
		response = data
	})
	// Move cursor to row 5, col 10 then query
	h.ParseString("\x1b[5;10H\x1b[6n")
	got := Expectation{Response: response}
	expected := Expectation{Response: "\x1b[5;10R"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

// newTestInputHandlerWithTermName creates an InputHandler with a custom TermName.
func newTestInputHandlerWithTermName(cols, rows int, termName string) *InputHandler {
	opts := DefaultOptions()
	opts.Cols = cols
	opts.Rows = rows
	opts.Scrollback = 1000
	opts.TermName = termName
	opts.VtExtensions = allVtExtensions()
	optsSvc := NewOptionsService(&opts)
	bufSvc := NewBufferService(optsSvc)
	charSvc := NewCharsetService()
	coreSvc := NewCoreService(optsSvc)
	oscLinkSvc := NewOscLinkService(bufSvc)
	uniSvc := NewUnicodeService()
	return NewInputHandler(bufSvc, charSvc, coreSvc, optsSvc, oscLinkSvc, uniSvc)
}

func TestDeviceAttributes(t *testing.T) {
	t.Parallel()

	t.Run("DA1", func(t *testing.T) {
		t.Parallel()
		tests := []struct {
			Name     string
			TermName string
			Input    string
			Expected string
		}{
			{"xterm_default", "xterm", "\x1b[c", "\x1b[?1;2c"},
			{"xterm-256color", "xterm-256color", "\x1b[c", "\x1b[?1;2c"},
			{"rxvt-unicode", "rxvt-unicode", "\x1b[c", "\x1b[?1;2c"},
			{"screen", "screen", "\x1b[c", "\x1b[?1;2c"},
			{"screen-256color", "screen-256color", "\x1b[c", "\x1b[?1;2c"},
			{"linux", "linux", "\x1b[c", "\x1b[?6c"},
			{"non_zero_param_no_response", "xterm", "\x1b[1c", ""},
		}
		for _, tc := range tests {
			t.Run(tc.Name, func(t *testing.T) {
				t.Parallel()
				h := newTestInputHandlerWithTermName(80, 24, tc.TermName)
				var response string
				h.coreService.OnDataEmitter.Event(func(data string) {
					response = data
				})
				h.ParseString(tc.Input)
				if diff := cmp.Diff(tc.Expected, response); diff != "" {
					t.Errorf("mismatch (-want +got):\n%s", diff)
				}
			})
		}
	})

	t.Run("DA2", func(t *testing.T) {
		t.Parallel()
		tests := []struct {
			Name     string
			TermName string
			Input    string
			Expected string
		}{
			{"xterm_default", "xterm", "\x1b[>c", "\x1b[>0;276;0c"},
			{"xterm-256color", "xterm-256color", "\x1b[>c", "\x1b[>0;276;0c"},
			{"screen", "screen", "\x1b[>c", "\x1b[>83;40003;0c"},
			{"rxvt-unicode", "rxvt-unicode", "\x1b[>c", "\x1b[>85;95;0c"},
			{"linux", "linux", "\x1b[>c", "0c"},
			{"non_zero_param_no_response", "xterm", "\x1b[>1c", ""},
		}
		for _, tc := range tests {
			t.Run(tc.Name, func(t *testing.T) {
				t.Parallel()
				h := newTestInputHandlerWithTermName(80, 24, tc.TermName)
				var response string
				h.coreService.OnDataEmitter.Event(func(data string) {
					response = data
				})
				h.ParseString(tc.Input)
				if diff := cmp.Diff(tc.Expected, response); diff != "" {
					t.Errorf("mismatch (-want +got):\n%s", diff)
				}
			})
		}
	})
}

func TestXtVersion(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Response string
	}

	t.Run("default param responds with DCS version", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1b[>q")
		got := Expectation{Response: response}
		expected := Expectation{Response: "\x1bP>|xterm-go(0.1.0)\x1b\\"}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("non-zero param produces no response", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1b[>1q")
		got := Expectation{Response: response}
		expected := Expectation{Response: ""}
		if diff := cmp.Diff(expected, got); diff != "" {
			t.Errorf("mismatch (-want +got):\n%s", diff)
		}
	})
}

func TestEraseChars(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LineContent string
	}
	h := newTestInputHandler(80, 24)
	h.ParseString("ABCDEFGH")
	h.ParseString("\x1b[1;3H\x1b[3X") // erase 3 chars at col 3
	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase)
	got := Expectation{LineContent: line.TranslateToString(true, 0, -1)}
	expected := Expectation{LineContent: "AB   FGH"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestTabClear(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		TabsEmpty bool
	}
	h := newTestInputHandler(80, 24)
	// Clear all tabs
	h.ParseString("\x1b[3g")
	buf := h.activeBuffer()
	got := Expectation{TabsEmpty: len(buf.Tabs) == 0}
	expected := Expectation{TabsEmpty: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestCursorHideShow(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Hidden bool
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{"hide_cursor", "\x1b[?25l", Expectation{Hidden: true}},
		{"show_cursor", "\x1b[?25l\x1b[?25h", Expectation{Hidden: false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			got := Expectation{Hidden: h.coreService.IsCursorHidden}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSetCursorStyle(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Style *CursorStyle
	}
	block := CursorStyleBlock
	underline := CursorStyleUnderline
	bar := CursorStyleBar
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{"block", "\x1b[2 q", Expectation{Style: &block}},
		{"underline", "\x1b[4 q", Expectation{Style: &underline}},
		{"bar", "\x1b[6 q", Expectation{Style: &bar}},
		{"reset", "\x1b[2 q\x1b[0 q", Expectation{Style: nil}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			got := Expectation{Style: h.coreService.DecPrivateModes.CursorStyle}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSelectProtected(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Protected bool
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{"set_protected", "\x1b[1\"q", Expectation{Protected: true}},
		{"clear_protected", "\x1b[1\"q\x1b[2\"q", Expectation{Protected: false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			got := Expectation{Protected: h.curAttrData.Bg&BgFlagProtected != 0}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestSetResetModeColorSchemeAndWin32(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ColorSchemeUpdates bool
		Win32InputMode     bool
	}
	tests := []struct {
		Name     string
		Input    string
		Expected Expectation
	}{
		{
			Name:     "DECSET_color_scheme_updates",
			Input:    "\x1b[?2031h",
			Expected: Expectation{ColorSchemeUpdates: true},
		},
		{
			Name:     "DECRST_color_scheme_updates",
			Input:    "\x1b[?2031h\x1b[?2031l",
			Expected: Expectation{ColorSchemeUpdates: false},
		},
		{
			Name:     "DECSET_win32_input_mode",
			Input:    "\x1b[?9001h",
			Expected: Expectation{Win32InputMode: true},
		},
		{
			Name:     "DECRST_win32_input_mode",
			Input:    "\x1b[?9001h\x1b[?9001l",
			Expected: Expectation{Win32InputMode: false},
		},
		{
			Name:     "DECSET_both_modes",
			Input:    "\x1b[?2031h\x1b[?9001h",
			Expected: Expectation{ColorSchemeUpdates: true, Win32InputMode: true},
		},
		{
			Name:     "DECRST_both_modes",
			Input:    "\x1b[?2031h\x1b[?9001h\x1b[?2031l\x1b[?9001l",
			Expected: Expectation{ColorSchemeUpdates: false, Win32InputMode: false},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			got := Expectation{
				ColorSchemeUpdates: h.coreService.DecPrivateModes.ColorSchemeUpdates,
				Win32InputMode:     h.coreService.DecPrivateModes.Win32InputMode,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestKittyKeyboardFlagSwapOnAltBuffer(t *testing.T) {
	t.Parallel()

	type KKState struct {
		Flags     int
		MainFlags int
		AltFlags  int
	}

	tests := []struct {
		Name     string
		Setup    func(h *InputHandler)
		Input    string
		Expected KKState
	}{
		{
			Name: "DECSET_1049_saves_main_flags_restores_alt",
			Setup: func(h *InputHandler) {
				h.coreService.KittyKeyboard.Flags = 5
				h.coreService.KittyKeyboard.AltFlags = 2
			},
			Input:    "\x1b[?1049h",
			Expected: KKState{Flags: 2, MainFlags: 5, AltFlags: 2},
		},
		{
			Name: "DECSET_47_saves_main_flags_restores_alt",
			Setup: func(h *InputHandler) {
				h.coreService.KittyKeyboard.Flags = 3
				h.coreService.KittyKeyboard.AltFlags = 1
			},
			Input:    "\x1b[?47h",
			Expected: KKState{Flags: 1, MainFlags: 3, AltFlags: 1},
		},
		{
			Name: "DECSET_1047_saves_main_flags_restores_alt",
			Setup: func(h *InputHandler) {
				h.coreService.KittyKeyboard.Flags = 7
				h.coreService.KittyKeyboard.AltFlags = 0
			},
			Input:    "\x1b[?1047h",
			Expected: KKState{Flags: 0, MainFlags: 7, AltFlags: 0},
		},
		{
			Name: "DECRST_1049_saves_alt_flags_restores_main",
			Setup: func(h *InputHandler) {
				// First switch to alt buffer
				h.coreService.KittyKeyboard.Flags = 5
				h.ParseString("\x1b[?1049h")
				// Now set flags as if app changed them on alt screen
				h.coreService.KittyKeyboard.Flags = 9
			},
			Input:    "\x1b[?1049l",
			Expected: KKState{Flags: 5, MainFlags: 5, AltFlags: 9},
		},
		{
			Name: "DECRST_47_saves_alt_flags_restores_main",
			Setup: func(h *InputHandler) {
				h.coreService.KittyKeyboard.Flags = 4
				h.ParseString("\x1b[?47h")
				h.coreService.KittyKeyboard.Flags = 6
			},
			Input:    "\x1b[?47l",
			Expected: KKState{Flags: 4, MainFlags: 4, AltFlags: 6},
		},
		{
			Name: "DECRST_1047_saves_alt_flags_restores_main",
			Setup: func(h *InputHandler) {
				h.coreService.KittyKeyboard.Flags = 8
				h.ParseString("\x1b[?1047h")
				h.coreService.KittyKeyboard.Flags = 3
			},
			Input:    "\x1b[?1047l",
			Expected: KKState{Flags: 8, MainFlags: 8, AltFlags: 3},
		},
		{
			Name: "round_trip_preserves_flags",
			Setup: func(h *InputHandler) {
				h.coreService.KittyKeyboard.Flags = 10
				h.coreService.KittyKeyboard.AltFlags = 20
			},
			Input:    "\x1b[?1049h\x1b[?1049l",
			Expected: KKState{Flags: 10, MainFlags: 10, AltFlags: 20},
		},
	}

	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			if tc.Setup != nil {
				tc.Setup(h)
			}
			h.ParseString(tc.Input)
			kk := h.coreService.KittyKeyboard
			got := KKState{Flags: kk.Flags, MainFlags: kk.MainFlags, AltFlags: kk.AltFlags}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestKittyKeyboardStackSwapOnAltBuffer(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)

	// Set up main stack
	h.coreService.KittyKeyboard.Flags = 1
	h.coreService.KittyKeyboard.MainStack = nil
	h.coreService.KittyKeyboard.AltStack = []int{10, 20}

	// Switch to alt buffer — main stack saved, alt stack restored
	h.ParseString("\x1b[?1049h")
	kk := h.coreService.KittyKeyboard
	if len(kk.AltStack) != 0 {
		t.Errorf("expected AltStack to be swapped out (len 0), got len %d", len(kk.AltStack))
	}
	if len(kk.MainStack) != 2 || kk.MainStack[0] != 10 || kk.MainStack[1] != 20 {
		t.Errorf("expected MainStack [10 20], got %v", kk.MainStack)
	}

	// Switch back to normal buffer — stacks swap back
	h.ParseString("\x1b[?1049l")
	kk = h.coreService.KittyKeyboard
	if len(kk.MainStack) != 0 {
		t.Errorf("expected MainStack to be swapped back (len 0), got len %d", len(kk.MainStack))
	}
	if len(kk.AltStack) != 2 || kk.AltStack[0] != 10 || kk.AltStack[1] != 20 {
		t.Errorf("expected AltStack [10 20], got %v", kk.AltStack)
	}
}

func TestKittyKeyboardSet(t *testing.T) {
	t.Parallel()
	tests := []struct {
		Name     string
		Input    string
		Expected int
	}{
		{"default_mode_OR", "\x1b[=3u", 3},
		{"explicit_mode_1_OR", "\x1b[=5;1u", 5},
		{"mode_1_OR_accumulates", "\x1b[=1u\x1b[=2u", 3},
		{"mode_2_clear", "\x1b[=7u\x1b[=2;2u", 5},
		{"mode_3_assign", "\x1b[=7u\x1b[=3;3u", 3},
		{"default_flags_zero", "\x1b[=u", 0},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			h.ParseString(tc.Input)
			got := h.coreService.KittyKeyboard.Flags
			if got != tc.Expected {
				t.Errorf("expected flags %d, got %d", tc.Expected, got)
			}
		})
	}
}

func TestKittyKeyboardQuery(t *testing.T) {
	t.Parallel()
	tests := []struct {
		Name     string
		Setup    string
		Expected string
	}{
		{"default_zero", "", "\x1b[?0u"},
		{"after_set", "\x1b[=5u", "\x1b[?5u"},
		{"after_assign_27", "\x1b[=27;3u", "\x1b[?27u"},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			var response string
			h.coreService.OnDataEmitter.Event(func(data string) {
				response = data
			})
			if tc.Setup != "" {
				h.ParseString(tc.Setup)
			}
			h.ParseString("\x1b[?u")
			if response != tc.Expected {
				t.Errorf("expected response %q, got %q", tc.Expected, response)
			}
		})
	}
}

func TestKittyKeyboardPush(t *testing.T) {
	t.Parallel()

	t.Run("push_saves_and_sets", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		// Set flags to 5, then push with new flags 3
		h.ParseString("\x1b[=5;3u")
		h.ParseString("\x1b[>3u")
		kk := h.coreService.KittyKeyboard
		if kk.Flags != 3 {
			t.Errorf("expected flags 3, got %d", kk.Flags)
		}
		if len(kk.MainStack) != 1 || kk.MainStack[0] != 5 {
			t.Errorf("expected MainStack [5], got %v", kk.MainStack)
		}
	})

	t.Run("push_default_zero", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[=7;3u")
		h.ParseString("\x1b[>u")
		kk := h.coreService.KittyKeyboard
		if kk.Flags != 0 {
			t.Errorf("expected flags 0, got %d", kk.Flags)
		}
		if len(kk.MainStack) != 1 || kk.MainStack[0] != 7 {
			t.Errorf("expected MainStack [7], got %v", kk.MainStack)
		}
	})

	t.Run("push_multiple", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[=1;3u")
		h.ParseString("\x1b[>2u")
		h.ParseString("\x1b[>3u")
		kk := h.coreService.KittyKeyboard
		if kk.Flags != 3 {
			t.Errorf("expected flags 3, got %d", kk.Flags)
		}
		if len(kk.MainStack) != 2 || kk.MainStack[0] != 1 || kk.MainStack[1] != 2 {
			t.Errorf("expected MainStack [1 2], got %v", kk.MainStack)
		}
	})

	t.Run("push_max_stack_depth", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		// Push 10 entries (max)
		for i := 0; i < 10; i++ {
			h.ParseString("\x1b[>1u")
		}
		kk := h.coreService.KittyKeyboard
		if len(kk.MainStack) != 10 {
			t.Errorf("expected MainStack len 10, got %d", len(kk.MainStack))
		}
		// 11th push should not grow the stack
		h.ParseString("\x1b[>99u")
		kk = h.coreService.KittyKeyboard
		if len(kk.MainStack) != 10 {
			t.Errorf("expected MainStack len 10 after overflow, got %d", len(kk.MainStack))
		}
		// But flags should still be updated
		if kk.Flags != 99 {
			t.Errorf("expected flags 99 after overflow push, got %d", kk.Flags)
		}
	})
}

func TestKittyKeyboardPop(t *testing.T) {
	t.Parallel()

	t.Run("pop_restores_flags", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[=5;3u")
		h.ParseString("\x1b[>3u")
		h.ParseString("\x1b[<u")
		kk := h.coreService.KittyKeyboard
		if kk.Flags != 5 {
			t.Errorf("expected flags 5, got %d", kk.Flags)
		}
		if len(kk.MainStack) != 0 {
			t.Errorf("expected empty MainStack, got %v", kk.MainStack)
		}
	})

	t.Run("pop_empty_stack_sets_zero", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[=5;3u")
		h.ParseString("\x1b[<u")
		kk := h.coreService.KittyKeyboard
		if kk.Flags != 0 {
			t.Errorf("expected flags 0, got %d", kk.Flags)
		}
	})

	t.Run("pop_multiple", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[=1;3u")
		h.ParseString("\x1b[>2u")
		h.ParseString("\x1b[>3u")
		// Pop 2 entries
		h.ParseString("\x1b[<2u")
		kk := h.coreService.KittyKeyboard
		if kk.Flags != 1 {
			t.Errorf("expected flags 1, got %d", kk.Flags)
		}
		if len(kk.MainStack) != 0 {
			t.Errorf("expected empty MainStack, got %v", kk.MainStack)
		}
	})

	t.Run("pop_more_than_stack_size", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		h.ParseString("\x1b[=1;3u")
		h.ParseString("\x1b[>2u")
		// Pop 5 but only 1 on stack
		h.ParseString("\x1b[<5u")
		kk := h.coreService.KittyKeyboard
		if kk.Flags != 0 {
			t.Errorf("expected flags 0, got %d", kk.Flags)
		}
		if len(kk.MainStack) != 0 {
			t.Errorf("expected empty MainStack, got %v", kk.MainStack)
		}
	})
}

func TestRequestModePrivate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		Name     string
		Setup    string
		Query    string
		Expected string
	}{
		{"cursor_visible_default", "", "\x1b[?25$p", "\x1b[?25;1$y"},
		{"cursor_hidden", "\x1b[?25l", "\x1b[?25$p", "\x1b[?25;2$y"},
		{"app_cursor_keys_default", "", "\x1b[?1$p", "\x1b[?1;2$y"},
		{"app_cursor_keys_set", "\x1b[?1h", "\x1b[?1$p", "\x1b[?1;1$y"},
		{"wraparound_default", "", "\x1b[?7$p", "\x1b[?7;1$y"},
		{"wraparound_reset", "\x1b[?7l", "\x1b[?7$p", "\x1b[?7;2$y"},
		{"bracketed_paste_default", "", "\x1b[?2004$p", "\x1b[?2004;2$y"},
		{"bracketed_paste_set", "\x1b[?2004h", "\x1b[?2004$p", "\x1b[?2004;1$y"},
		{"origin_default", "", "\x1b[?6$p", "\x1b[?6;2$y"},
		{"send_focus_default", "", "\x1b[?1004$p", "\x1b[?1004;2$y"},
		{"send_focus_set", "\x1b[?1004h", "\x1b[?1004$p", "\x1b[?1004;1$y"},
		{"sync_output_default", "", "\x1b[?2026$p", "\x1b[?2026;2$y"},
		{"sync_output_set", "\x1b[?2026h", "\x1b[?2026$p", "\x1b[?2026;1$y"},
		{"unrecognized_mode", "", "\x1b[?9999$p", "\x1b[?9999;0$y"},
		{"alt_buffer_default", "", "\x1b[?47$p", "\x1b[?47;2$y"},
		{"alt_buffer_set", "\x1b[?1049h", "\x1b[?1049$p", "\x1b[?1049;1$y"},
		{"reverse_wraparound_set", "\x1b[?45h", "\x1b[?45$p", "\x1b[?45;1$y"},
		{"mouse_tracking_x10", "\x1b[?9h", "\x1b[?9$p", "\x1b[?9;1$y"},
		{"mouse_tracking_vt200", "\x1b[?1000h", "\x1b[?1000$p", "\x1b[?1000;1$y"},
		{"mouse_encoding_sgr", "\x1b[?1006h", "\x1b[?1006$p", "\x1b[?1006;1$y"},
		{"color_scheme_updates_set", "\x1b[?2031h", "\x1b[?2031$p", "\x1b[?2031;1$y"},
		{"win32_input_set", "\x1b[?9001h", "\x1b[?9001$p", "\x1b[?9001;1$y"},
		// Permanently set/reset modes (issue #27)
		{"DECARM_permanently_set", "", "\x1b[?8$p", "\x1b[?8;3$y"},
		{"DECBKM_permanently_reset", "", "\x1b[?67$p", "\x1b[?67;4$y"},
		{"UTF8_mouse_permanently_reset", "", "\x1b[?1005$p", "\x1b[?1005;4$y"},
		{"urxvt_mouse_permanently_reset", "", "\x1b[?1015$p", "\x1b[?1015;4$y"},
		// Dynamic mode reports (issue #28)
		{"cursor_blink_default_reset", "", "\x1b[?12$p", "\x1b[?12;2$y"},
		{"save_cursor_always_set", "", "\x1b[?1048$p", "\x1b[?1048;1$y"},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			var response string
			h.coreService.OnDataEmitter.Event(func(data string) {
				response = data
			})
			if tc.Setup != "" {
				h.ParseString(tc.Setup)
			}
			h.ParseString(tc.Query)
			if response != tc.Expected {
				t.Errorf("expected response %q, got %q", tc.Expected, response)
			}
		})
	}
}

func TestRequestModeANSI(t *testing.T) {
	t.Parallel()
	tests := []struct {
		Name     string
		Setup    string
		Query    string
		Expected string
	}{
		{"insert_mode_default", "", "\x1b[4$p", "\x1b[4;2$y"},
		{"insert_mode_set", "\x1b[4h", "\x1b[4$p", "\x1b[4;1$y"},
		{"convert_eol_default", "", "\x1b[20$p", "\x1b[20;2$y"},
		// Permanently set/reset modes (issue #27)
		{"KAM_permanently_reset", "", "\x1b[2$p", "\x1b[2;4$y"},
		{"SRM_permanently_set", "", "\x1b[12$p", "\x1b[12;3$y"},
		{"unrecognized_ansi_mode", "", "\x1b[99$p", "\x1b[99;0$y"},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			h := newTestInputHandler(80, 24)
			var response string
			h.coreService.OnDataEmitter.Event(func(data string) {
				response = data
			})
			if tc.Setup != "" {
				h.ParseString(tc.Setup)
			}
			h.ParseString(tc.Query)
			if response != tc.Expected {
				t.Errorf("expected response %q, got %q", tc.Expected, response)
			}
		})
	}
}

func TestRequestModeCursorBlinkEnabled(t *testing.T) {
	t.Parallel()
	// CursorBlink enabled should report SET (Pm=1) for mode 12.
	opts := DefaultOptions()
	opts.Cols = 80
	opts.Rows = 24
	opts.Scrollback = 1000
	opts.CursorBlink = true
	optsSvc := NewOptionsService(&opts)
	bufSvc := NewBufferService(optsSvc)
	charSvc := NewCharsetService()
	coreSvc := NewCoreService(optsSvc)
	oscLinkSvc := NewOscLinkService(bufSvc)
	uniSvc := NewUnicodeService()
	h := NewInputHandler(bufSvc, charSvc, coreSvc, optsSvc, oscLinkSvc, uniSvc)

	var response string
	h.coreService.OnDataEmitter.Event(func(data string) {
		response = data
	})
	h.ParseString("\x1b[?12$p")
	expected := "\x1b[?12;1$y"
	if response != expected {
		t.Errorf("expected response %q, got %q", expected, response)
	}
}

func TestWindowOptionsReportSize(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	var response string
	h.coreService.OnDataEmitter.Event(func(data string) {
		response = data
	})
	h.ParseString("\x1b[18t")
	expected := "\x1b[8;24;80t"
	if response != expected {
		t.Errorf("expected response %q, got %q", expected, response)
	}
}

func TestWindowOptionsReportSizeCustom(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(132, 50)
	var response string
	h.coreService.OnDataEmitter.Event(func(data string) {
		response = data
	})
	h.ParseString("\x1b[18t")
	expected := "\x1b[8;50;132t"
	if response != expected {
		t.Errorf("expected response %q, got %q", expected, response)
	}
}

func TestWindowOptionsPushPopTitle(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	var lastTitle string
	h.OnTitleChangeEmitter.Event(func(title string) {
		lastTitle = title
	})

	h.ParseString("\x1b]2;first\x1b\\")
	if lastTitle != "first" {
		t.Fatalf("expected title %q, got %q", "first", lastTitle)
	}

	h.ParseString("\x1b[22;2t")

	h.ParseString("\x1b]2;second\x1b\\")
	if lastTitle != "second" {
		t.Fatalf("expected title %q, got %q", "second", lastTitle)
	}

	h.ParseString("\x1b[23;2t")
	if lastTitle != "first" {
		t.Errorf("expected title %q after pop, got %q", "first", lastTitle)
	}
}

func TestWindowOptionsPushPopTitleMultiple(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	var lastTitle string
	h.OnTitleChangeEmitter.Event(func(title string) {
		lastTitle = title
	})

	h.ParseString("\x1b]2;alpha\x1b\\")
	h.ParseString("\x1b[22;2t")
	h.ParseString("\x1b]2;beta\x1b\\")
	h.ParseString("\x1b[22;2t")
	h.ParseString("\x1b]2;gamma\x1b\\")
	h.ParseString("\x1b[22;2t")
	h.ParseString("\x1b]2;delta\x1b\\")

	h.ParseString("\x1b[23;2t")
	if lastTitle != "gamma" {
		t.Errorf("expected %q, got %q", "gamma", lastTitle)
	}
	h.ParseString("\x1b[23;2t")
	if lastTitle != "beta" {
		t.Errorf("expected %q, got %q", "beta", lastTitle)
	}
	h.ParseString("\x1b[23;2t")
	if lastTitle != "alpha" {
		t.Errorf("expected %q, got %q", "alpha", lastTitle)
	}
}

func TestWindowOptionsPopEmptyStack(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	titleChanges := 0
	h.OnTitleChangeEmitter.Event(func(title string) {
		titleChanges++
	})

	h.ParseString("\x1b]2;initial\x1b\\")
	titleChanges = 0

	h.ParseString("\x1b[23;2t")
	if titleChanges != 0 {
		t.Errorf("expected no title change on empty stack pop, got %d changes", titleChanges)
	}
}

func TestWindowOptionsPushPopBoth(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	var lastTitle string
	h.OnTitleChangeEmitter.Event(func(title string) {
		lastTitle = title
	})

	h.ParseString("\x1b]2;both-test\x1b\\")
	h.ParseString("\x1b[22;0t")
	h.ParseString("\x1b]2;replaced\x1b\\")

	h.ParseString("\x1b[23;0t")
	if lastTitle != "both-test" {
		t.Errorf("expected %q, got %q", "both-test", lastTitle)
	}
}

func TestWindowOptionsUnknownSubcommand(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	var response string
	h.coreService.OnDataEmitter.Event(func(data string) {
		response = data
	})
	h.ParseString("\x1b[99t")
	if response != "" {
		t.Errorf("expected no response for unknown subcommand, got %q", response)
	}
}

func TestWindowOptionsPushPopIconName(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	var lastIconName string
	h.OnIconNameChangeEmitter.Event(func(name string) {
		lastIconName = name
	})

	// Set icon name via OSC 1.
	h.ParseString("\x1b]1;first-icon\x07")
	if lastIconName != "first-icon" {
		t.Fatalf("expected icon name %q, got %q", "first-icon", lastIconName)
	}

	// Push icon name only (CSI 22;1t).
	h.ParseString("\x1b[22;1t")

	// Change icon name.
	h.ParseString("\x1b]1;second-icon\x07")
	if lastIconName != "second-icon" {
		t.Fatalf("expected icon name %q, got %q", "second-icon", lastIconName)
	}

	// Pop icon name only (CSI 23;1t).
	h.ParseString("\x1b[23;1t")
	if lastIconName != "first-icon" {
		t.Errorf("expected icon name %q after pop, got %q", "first-icon", lastIconName)
	}
}

func TestWindowOptionsPushPopIconNameIndependentOfTitle(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	var lastTitle, lastIconName string
	h.OnTitleChangeEmitter.Event(func(s string) { lastTitle = s })
	h.OnIconNameChangeEmitter.Event(func(s string) { lastIconName = s })

	// Set different title and icon name.
	h.ParseString("\x1b]2;my-title\x1b\\")
	h.ParseString("\x1b]1;my-icon\x07")

	// Push both (CSI 22;0t).
	h.ParseString("\x1b[22;0t")

	// Change both.
	h.ParseString("\x1b]2;new-title\x1b\\")
	h.ParseString("\x1b]1;new-icon\x07")

	// Pop both (CSI 23;0t).
	h.ParseString("\x1b[23;0t")
	if lastTitle != "my-title" {
		t.Errorf("expected title %q, got %q", "my-title", lastTitle)
	}
	if lastIconName != "my-icon" {
		t.Errorf("expected icon name %q, got %q", "my-icon", lastIconName)
	}
}

func TestWindowOptionsPopIconNameEmptyStack(t *testing.T) {
	t.Parallel()
	h := newTestInputHandler(80, 24)
	iconNameChanges := 0
	h.OnIconNameChangeEmitter.Event(func(string) {
		iconNameChanges++
	})

	// Set initial icon name.
	h.ParseString("\x1b]1;initial\x07")
	iconNameChanges = 0

	// Pop from empty stack — should not fire event.
	h.ParseString("\x1b[23;1t")
	if iconNameChanges != 0 {
		t.Errorf("expected no icon name change on empty stack pop, got %d changes", iconNameChanges)
	}
}

func TestDSR996ColorSchemeQuery(t *testing.T) {
	t.Parallel()

	t.Run("fires_when_color_scheme_updates_enabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		fired := 0
		h.OnRequestColorSchemeQueryEmitter.Event(func(struct{}) {
			fired++
		})

		// Enable color scheme updates (DECSET 2031).
		h.ParseString("\x1b[?2031h")
		// Send DSR 996.
		h.ParseString("\x1b[?996n")

		if fired != 1 {
			t.Errorf("expected OnRequestColorSchemeQuery to fire once, got %d", fired)
		}
	})

	t.Run("does_not_fire_when_color_scheme_updates_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		fired := 0
		h.OnRequestColorSchemeQueryEmitter.Event(func(struct{}) {
			fired++
		})

		// Do NOT enable color scheme updates — send DSR 996 directly.
		h.ParseString("\x1b[?996n")

		if fired != 0 {
			t.Errorf("expected OnRequestColorSchemeQuery not to fire, got %d", fired)
		}
	})

	t.Run("does_not_fire_after_color_scheme_updates_reset", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		fired := 0
		h.OnRequestColorSchemeQueryEmitter.Event(func(struct{}) {
			fired++
		})

		// Enable then disable color scheme updates.
		h.ParseString("\x1b[?2031h")
		h.ParseString("\x1b[?2031l")
		// Send DSR 996.
		h.ParseString("\x1b[?996n")

		if fired != 0 {
			t.Errorf("expected OnRequestColorSchemeQuery not to fire after reset, got %d", fired)
		}
	})

	t.Run("dsr6_still_works", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		var response string
		h.coreService.OnDataEmitter.Event(func(s string) {
			response = s
		})

		// Move cursor to row 5, col 10.
		h.ParseString("\x1b[5;10H")
		// Send DSR 6 (cursor position report).
		h.ParseString("\x1b[?6n")

		expected := "\x1b[?5;10R"
		if response != expected {
			t.Errorf("DSR 6 response = %q, want %q", response, expected)
		}
	})
}

func TestWindowOptionsTitleStackLimit(t *testing.T) {
	t.Parallel()

	t.Run("title_stack_capped_at_10", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		// Set and push 15 titles.
		for i := 0; i < 15; i++ {
			h.ParseString("\x1b]2;title\x07")
			h.ParseString("\x1b[22;2t") // push title
		}

		// Pop all — should get at most 10.
		popCount := 0
		for i := 0; i < 15; i++ {
			fired := false
			d := h.OnTitleChangeEmitter.Event(func(s string) { fired = true })
			h.ParseString("\x1b[23;2t") // pop title
			if fired {
				popCount++
			}
			d.Dispose()
		}
		if popCount != titleStackLimit {
			t.Errorf("popped %d titles, want exactly %d", popCount, titleStackLimit)
		}
	})

	t.Run("icon_name_stack_capped_at_10", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		// Set and push 15 icon names.
		for i := 0; i < 15; i++ {
			h.ParseString("\x1b]1;icon\x07")
			h.ParseString("\x1b[22;1t") // push icon name
		}

		// Pop all — should get at most 10.
		popCount := 0
		for i := 0; i < 15; i++ {
			fired := false
			d := h.OnIconNameChangeEmitter.Event(func(s string) { fired = true })
			h.ParseString("\x1b[23;1t") // pop icon name
			if fired {
				popCount++
			}
			d.Dispose()
		}
		if popCount != titleStackLimit {
			t.Errorf("popped %d icon names, want exactly %d", popCount, titleStackLimit)
		}
	})

	t.Run("both_stacks_capped_at_10", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		// Push 12 entries for both title and icon name (ps2=0).
		for i := 0; i < 12; i++ {
			h.ParseString("\x1b]0;both\x07") // OSC 0 sets both
			h.ParseString("\x1b[22;0t")       // push both
		}

		titlePops := 0
		iconPops := 0
		for i := 0; i < 12; i++ {
			tFired := false
			iFired := false
			dt := h.OnTitleChangeEmitter.Event(func(s string) { tFired = true })
			di := h.OnIconNameChangeEmitter.Event(func(s string) { iFired = true })
			h.ParseString("\x1b[23;0t") // pop both
			if tFired {
				titlePops++
			}
			if iFired {
				iconPops++
			}
			dt.Dispose()
			di.Dispose()
		}
		if titlePops != titleStackLimit {
			t.Errorf("title pops = %d, want %d", titlePops, titleStackLimit)
		}
		if iconPops != titleStackLimit {
			t.Errorf("icon pops = %d, want %d", iconPops, titleStackLimit)
		}
	})

	t.Run("stack_preserves_most_recent_entries", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		// Push 12 titles with distinct values; the first 2 should be evicted.
		for i := 0; i < 12; i++ {
			h.ParseString("\x1b]2;t" + string(rune('A'+i)) + "\x07")
			h.ParseString("\x1b[22;2t")
		}

		// Pop returns from top of stack (most recent push first).
		// Pushed: tA tB tC tD tE tF tG tH tI tJ tK tL
		// After trim: tC tD tE tF tG tH tI tJ tK tL (oldest 2 evicted)
		// Pop order: tL, tK, tJ, ...
		var got string
		d := h.OnTitleChangeEmitter.Event(func(s string) { got = s })
		h.ParseString("\x1b[23;2t")
		d.Dispose()

		expected := "tL"
		if got != expected {
			t.Errorf("first pop = %q, want %q", got, expected)
		}
	})
}

func TestWindowOptionsCSI14t(t *testing.T) {
	t.Parallel()

	t.Run("fires_GetWinSizePixels", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		var got WindowsOptionsReportType
		fired := false
		d := h.OnRequestWindowsOptionsReportEmitter.Event(func(rt WindowsOptionsReportType) {
			fired = true
			got = rt
		})
		defer d.Dispose()

		h.ParseString("\x1b[14t")
		if !fired {
			t.Fatal("OnRequestWindowsOptionsReport not fired for CSI 14 t")
		}
		if got != GetWinSizePixels {
			t.Errorf("report type = %d, want GetWinSizePixels (%d)", got, GetWinSizePixels)
		}
	})

	t.Run("ps2_not_2_fires_GetWinSizePixels", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		fired := false
		d := h.OnRequestWindowsOptionsReportEmitter.Event(func(rt WindowsOptionsReportType) {
			fired = true
		})
		defer d.Dispose()

		h.ParseString("\x1b[14;1t")
		if !fired {
			t.Fatal("OnRequestWindowsOptionsReport not fired for CSI 14;1 t")
		}
	})

	t.Run("ps2_eq_2_does_not_fire", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		fired := false
		d := h.OnRequestWindowsOptionsReportEmitter.Event(func(rt WindowsOptionsReportType) {
			fired = true
		})
		defer d.Dispose()

		h.ParseString("\x1b[14;2t")
		if fired {
			t.Error("OnRequestWindowsOptionsReport should not fire for CSI 14;2 t")
		}
	})
}

func TestWindowOptionsCSI16t(t *testing.T) {
	t.Parallel()

	t.Run("fires_GetCellSizePixels", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)

		var got WindowsOptionsReportType
		fired := false
		d := h.OnRequestWindowsOptionsReportEmitter.Event(func(rt WindowsOptionsReportType) {
			fired = true
			got = rt
		})
		defer d.Dispose()

		h.ParseString("\x1b[16t")
		if !fired {
			t.Fatal("OnRequestWindowsOptionsReport not fired for CSI 16 t")
		}
		if got != GetCellSizePixels {
			t.Errorf("report type = %d, want GetCellSizePixels (%d)", got, GetCellSizePixels)
		}
	})
}

func TestWindowOptionsReportTerminalLevel(t *testing.T) {
	t.Parallel()

	t.Run("CSI_14t_forwarded_to_terminal", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()

		var got WindowsOptionsReportType
		fired := false
		d := term.OnRequestWindowsOptionsReport(func(rt WindowsOptionsReportType) {
			fired = true
			got = rt
		})
		defer d.Dispose()

		term.WriteString("\x1b[14t")
		if !fired {
			t.Fatal("Terminal.OnRequestWindowsOptionsReport not fired for CSI 14 t")
		}
		if got != GetWinSizePixels {
			t.Errorf("report type = %d, want GetWinSizePixels (%d)", got, GetWinSizePixels)
		}
	})

	t.Run("CSI_16t_forwarded_to_terminal", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()

		var got WindowsOptionsReportType
		fired := false
		d := term.OnRequestWindowsOptionsReport(func(rt WindowsOptionsReportType) {
			fired = true
			got = rt
		})
		defer d.Dispose()

		term.WriteString("\x1b[16t")
		if !fired {
			t.Fatal("Terminal.OnRequestWindowsOptionsReport not fired for CSI 16 t")
		}
		if got != GetCellSizePixels {
			t.Errorf("report type = %d, want GetCellSizePixels (%d)", got, GetCellSizePixels)
		}
	})
}

// --- OnRequestSendFocus (DECSET 1004) tests ---

func TestOnRequestSendFocus(t *testing.T) {
	t.Parallel()

	t.Run("fires_when_focus_reporting_enabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		fired := 0
		h.OnRequestSendFocusEmitter.Event(func(struct{}) {
			fired++
		})

		// Enable focus reporting (DECSET 1004).
		h.ParseString("\x1b[?1004h")

		if fired != 1 {
			t.Errorf("expected OnRequestSendFocus to fire once, got %d", fired)
		}
	})

	t.Run("does_not_fire_when_focus_reporting_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		fired := 0
		h.OnRequestSendFocusEmitter.Event(func(struct{}) {
			fired++
		})

		// Disable focus reporting (DECRST 1004) without enabling first.
		h.ParseString("\x1b[?1004l")

		if fired != 0 {
			t.Errorf("expected OnRequestSendFocus not to fire, got %d", fired)
		}
	})

	t.Run("fires_each_time_focus_reporting_enabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandler(80, 24)
		fired := 0
		h.OnRequestSendFocusEmitter.Event(func(struct{}) {
			fired++
		})

		// Enable, disable, enable again.
		h.ParseString("\x1b[?1004h")
		h.ParseString("\x1b[?1004l")
		h.ParseString("\x1b[?1004h")

		if fired != 2 {
			t.Errorf("expected OnRequestSendFocus to fire twice, got %d", fired)
		}
	})
}

func TestOnRequestSendFocusTerminalLevel(t *testing.T) {
	t.Parallel()

	t.Run("DECSET_1004_forwarded_to_terminal", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()

		fired := false
		d := term.OnRequestSendFocus(func() {
			fired = true
		})
		defer d.Dispose()

		term.WriteString("\x1b[?1004h")
		if !fired {
			t.Fatal("Terminal.OnRequestSendFocus not fired for DECSET 1004")
		}
	})
}

// --- VtExtensions gating tests ---

func TestVtExtensions_Win32InputModeGating(t *testing.T) {
	t.Parallel()

	t.Run("DECRPM_reports_not_recognized_when_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1b[?9001$p")
		expected := "\x1b[?9001;0$y"
		if response != expected {
			t.Errorf("expected %q, got %q", expected, response)
		}
	})

	t.Run("DECSET_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		h.ParseString("\x1b[?9001h")
		if h.coreService.DecPrivateModes.Win32InputMode {
			t.Error("Win32InputMode should remain false when vtExtensions.Win32InputMode is disabled")
		}
	})

	t.Run("DECRST_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		ext := allVtExtensions()
		h := newTestInputHandlerWithVtExt(80, 24, ext)
		h.ParseString("\x1b[?9001h")
		if !h.coreService.DecPrivateModes.Win32InputMode {
			t.Fatal("precondition: Win32InputMode should be true")
		}
		h.optionsService.Options.VtExtensions.Win32InputMode = false
		h.ParseString("\x1b[?9001l")
		if !h.coreService.DecPrivateModes.Win32InputMode {
			t.Error("Win32InputMode should remain true when vtExtensions.Win32InputMode is disabled")
		}
	})

	t.Run("DECRPM_reports_set_when_enabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, allVtExtensions())
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1b[?9001h")
		h.ParseString("\x1b[?9001$p")
		expected := "\x1b[?9001;1$y"
		if response != expected {
			t.Errorf("expected %q, got %q", expected, response)
		}
	})
}

func TestVtExtensions_ColorSchemeQueryGating(t *testing.T) {
	t.Parallel()

	t.Run("DECRPM_reports_not_recognized_when_disabled", func(t *testing.T) {
		t.Parallel()
		f := false
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{ColorSchemeQuery: &f})
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1b[?2031$p")
		expected := "\x1b[?2031;0$y"
		if response != expected {
			t.Errorf("expected %q, got %q", expected, response)
		}
	})

	t.Run("DECSET_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		f := false
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{ColorSchemeQuery: &f})
		h.ParseString("\x1b[?2031h")
		if h.coreService.DecPrivateModes.ColorSchemeUpdates {
			t.Error("ColorSchemeUpdates should remain false when vtExtensions.ColorSchemeQuery is false")
		}
	})

	t.Run("enabled_by_default_when_nil", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		h.ParseString("\x1b[?2031h")
		if !h.coreService.DecPrivateModes.ColorSchemeUpdates {
			t.Error("ColorSchemeUpdates should be settable when ColorSchemeQuery is nil (default true)")
		}
	})
}

func TestVtExtensions_KittyKeyboardGating(t *testing.T) {
	t.Parallel()

	t.Run("set_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		h.ParseString("\x1b[=3;3u")
		if h.coreService.KittyKeyboard.Flags != 0 {
			t.Errorf("expected flags 0, got %d", h.coreService.KittyKeyboard.Flags)
		}
	})

	t.Run("query_no_response_when_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		var response string
		h.coreService.OnDataEmitter.Event(func(data string) {
			response = data
		})
		h.ParseString("\x1b[?u")
		if response != "" {
			t.Errorf("expected no response, got %q", response)
		}
	})

	t.Run("push_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		h.coreService.KittyKeyboard.Flags = 5
		h.ParseString("\x1b[>3u")
		if len(h.coreService.KittyKeyboard.MainStack) != 0 {
			t.Errorf("expected empty stack, got %v", h.coreService.KittyKeyboard.MainStack)
		}
		if h.coreService.KittyKeyboard.Flags != 5 {
			t.Errorf("expected flags unchanged at 5, got %d", h.coreService.KittyKeyboard.Flags)
		}
	})

	t.Run("pop_ignored_when_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		h.coreService.KittyKeyboard.Flags = 5
		h.coreService.KittyKeyboard.MainStack = []int{3}
		h.ParseString("\x1b[<u")
		if h.coreService.KittyKeyboard.Flags != 5 {
			t.Errorf("expected flags unchanged at 5, got %d", h.coreService.KittyKeyboard.Flags)
		}
		if len(h.coreService.KittyKeyboard.MainStack) != 1 {
			t.Errorf("expected stack unchanged, got %v", h.coreService.KittyKeyboard.MainStack)
		}
	})

	t.Run("alt_buffer_swap_skipped_when_disabled", func(t *testing.T) {
		t.Parallel()
		h := newTestInputHandlerWithVtExt(80, 24, VtExtensions{})
		h.coreService.KittyKeyboard.Flags = 5
		h.coreService.KittyKeyboard.AltFlags = 2
		h.ParseString("\x1b[?1049h")
		if h.coreService.KittyKeyboard.Flags != 5 {
			t.Errorf("expected flags unchanged at 5, got %d", h.coreService.KittyKeyboard.Flags)
		}
		if h.coreService.KittyKeyboard.MainFlags != 0 {
			t.Errorf("expected MainFlags unchanged at 0, got %d", h.coreService.KittyKeyboard.MainFlags)
		}
	})
}
