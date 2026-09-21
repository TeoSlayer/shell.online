package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

// newTestHandler creates an InputHandler with default 80x24 terminal for testing.
func newTestHandler() *InputHandler {
	opts := NewOptionsService(nil)
	bs := NewBufferService(opts)
	cs := NewCharsetService()
	core := NewCoreService(opts)
	osc := NewOscLinkService(bs)
	uni := NewUnicodeService()

	bs.Buffer().FillViewportRows(nil)

	return NewInputHandler(bs, cs, core, opts, osc, uni)
}

// --- Print handler tests ---

func TestPrint_ASCII(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("Hello")

	type Expectation struct {
		X    int
		Y    int
		Text string
	}
	buf := h.activeBuffer()
	got := Expectation{
		X:    buf.X,
		Y:    buf.Y,
		Text: buf.Lines.Get(buf.YBase+0).TranslateToString(true, 0, -1),
	}
	want := Expectation{X: 5, Y: 0, Text: "Hello"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestPrint_WideChars(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// 世 is a wide character (width 2)
	h.ParseString("世") //nolint:gosmopolitan

	type Expectation struct {
		X     int
		Width int
	}
	buf := h.activeBuffer()
	got := Expectation{
		X:     buf.X,
		Width: buf.Lines.Get(buf.YBase).GetWidth(0),
	}
	want := Expectation{X: 2, Width: 2}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestPrint_Wrapping(t *testing.T) {
	t.Parallel()
	opts := NewOptionsService(&TerminalOptions{Cols: 5, Rows: 5})
	bs := NewBufferService(opts)
	cs := NewCharsetService()
	core := NewCoreService(opts)
	osc := NewOscLinkService(bs)
	uni := NewUnicodeService()
	bs.Buffer().FillViewportRows(nil)

	h := NewInputHandler(bs, cs, core, opts, osc, uni)
	h.ParseString("ABCDEFGH")

	type Expectation struct {
		X         int
		Y         int
		Line0     string
		Line1     string
		IsWrapped bool
	}
	buf := h.activeBuffer()
	got := Expectation{
		X:         buf.X,
		Y:         buf.Y,
		Line0:     buf.Lines.Get(buf.YBase+0).TranslateToString(true, 0, -1),
		Line1:     buf.Lines.Get(buf.YBase+1).TranslateToString(true, 0, -1),
		IsWrapped: buf.Lines.Get(buf.YBase + 1).IsWrapped,
	}
	want := Expectation{X: 3, Y: 1, Line0: "ABCDE", Line1: "FGH", IsWrapped: true}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

// --- C0 control tests ---

func TestC0_LineFeed(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("A\nB")

	type Expectation struct {
		X int
		Y int
	}
	buf := h.activeBuffer()
	got := Expectation{X: buf.X, Y: buf.Y}
	want := Expectation{X: 2, Y: 1}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestC0_CarriageReturn(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("Hello\r")

	type Expectation struct {
		X int
		Y int
	}
	buf := h.activeBuffer()
	got := Expectation{X: buf.X, Y: buf.Y}
	want := Expectation{X: 0, Y: 0}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestC0_CRLF(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("AB\r\nCD")

	type Expectation struct {
		X     int
		Y     int
		Line0 string
		Line1 string
	}
	buf := h.activeBuffer()
	got := Expectation{
		X:     buf.X,
		Y:     buf.Y,
		Line0: buf.Lines.Get(buf.YBase+0).TranslateToString(true, 0, -1),
		Line1: buf.Lines.Get(buf.YBase+1).TranslateToString(true, 0, -1),
	}
	want := Expectation{X: 2, Y: 1, Line0: "AB", Line1: "CD"}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestC0_Backspace(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("AB\b")

	type Expectation struct {
		X int
		Y int
	}
	buf := h.activeBuffer()
	got := Expectation{X: buf.X, Y: buf.Y}
	want := Expectation{X: 1, Y: 0}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestC0_BackspaceAtCol0(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\b")

	buf := h.activeBuffer()
	if buf.X != 0 {
		t.Errorf("expected X=0, got %d", buf.X)
	}
}

func TestC0_Tab(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("\t")

	buf := h.activeBuffer()
	if buf.X != 8 {
		t.Errorf("expected X=8 (default tab stop), got %d", buf.X)
	}
}

func TestC0_TabFromMidColumn(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("AB\t")

	buf := h.activeBuffer()
	if buf.X != 8 {
		t.Errorf("expected X=8, got %d", buf.X)
	}
}

// --- ESC sequence tests ---

func TestESC_SaveRestoreCursor(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("ABCDE")
	// ESC 7 = save cursor
	h.ParseString("\x1b7")
	savedX := h.activeBuffer().X
	savedY := h.activeBuffer().Y

	h.ParseString("\r\nXYZ")
	// ESC 8 = restore cursor
	h.ParseString("\x1b8")

	type Expectation struct {
		SavedX    int
		SavedY    int
		RestoredX int
		RestoredY int
	}
	buf := h.activeBuffer()
	got := Expectation{
		SavedX:    savedX,
		SavedY:    savedY,
		RestoredX: buf.X,
		RestoredY: buf.Y,
	}
	want := Expectation{SavedX: 5, SavedY: 0, RestoredX: 5, RestoredY: 0}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestESC_Index(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// ESC D = Index (move cursor down)
	h.ParseString("A\x1bD")

	type Expectation struct {
		X int
		Y int
	}
	buf := h.activeBuffer()
	got := Expectation{X: buf.X, Y: buf.Y}
	want := Expectation{X: 1, Y: 1}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestESC_IndexScrollsAtBottom(t *testing.T) {
	t.Parallel()
	opts := NewOptionsService(&TerminalOptions{Cols: 10, Rows: 3})
	bs := NewBufferService(opts)
	cs := NewCharsetService()
	core := NewCoreService(opts)
	osc := NewOscLinkService(bs)
	uni := NewUnicodeService()
	bs.Buffer().FillViewportRows(nil)

	h := NewInputHandler(bs, cs, core, opts, osc, uni)

	// Move to last row, then index should scroll
	h.ParseString("\x1bD\x1bD") // two index commands: row 0→1→2
	h.ParseString("\x1bD")      // at row 2 (scrollBottom), should scroll

	buf := h.activeBuffer()
	if buf.Y != 2 {
		t.Errorf("expected Y=2 (bottom), got %d", buf.Y)
	}
}

func TestESC_ReverseIndex(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// Move down, then reverse index
	h.ParseString("\n\n\x1bM")

	type Expectation struct {
		X int
		Y int
	}
	buf := h.activeBuffer()
	got := Expectation{X: buf.X, Y: buf.Y}
	want := Expectation{X: 0, Y: 1}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestESC_ReverseIndexScrollsAtTop(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	// At row 0, reverse index should scroll down (insert blank line at top)
	h.ParseString("TopLine")
	h.ParseString("\r") // back to col 0
	h.ParseString("\x1bM")

	buf := h.activeBuffer()
	// Cursor should still be at row 0
	if buf.Y != 0 {
		t.Errorf("expected Y=0, got %d", buf.Y)
	}
	// The old top line should now be at row 1
	line1 := buf.Lines.Get(buf.YBase+1).TranslateToString(true, 0, -1)
	if line1 != "TopLine" {
		t.Errorf("expected 'TopLine' at row 1, got %q", line1)
	}
}

func TestESC_NextLine(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	h.ParseString("ABC")
	// ESC E = NEL (CR + LF)
	h.ParseString("\x1bE")

	type Expectation struct {
		X int
		Y int
	}
	buf := h.activeBuffer()
	got := Expectation{X: buf.X, Y: buf.Y}
	want := Expectation{X: 0, Y: 1}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("mismatch (-want +got):\n%s", diff)
	}
}

func TestESC_TabSet(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	buf := h.activeBuffer()

	// Move to column 5 and set a tab stop
	h.ParseString("12345")
	h.ParseString("\x1bH") // ESC H = HTS

	if !buf.Tabs[5] {
		t.Error("expected tab stop at column 5")
	}
}

func TestESC_FullReset(t *testing.T) {
	t.Parallel()
	h := newTestHandler()
	var resetFired bool
	h.OnRequestResetEmitter.Event(func(struct{}) {
		resetFired = true
	})

	h.ParseString("Hello\n\n")
	// ESC c = RIS (full reset)
	h.ParseString("\x1bc")

	if !resetFired {
		t.Error("expected OnRequestReset to fire")
	}
}

func TestESC_KeypadModes(t *testing.T) {
	t.Parallel()
	h := newTestHandler()

	// ESC = → application keypad
	h.ParseString("\x1b=")
	if !h.coreService.DecPrivateModes.ApplicationKeypad {
		t.Error("expected application keypad mode")
	}

	// ESC > → numeric keypad
	h.ParseString("\x1b>")
	if h.coreService.DecPrivateModes.ApplicationKeypad {
		t.Error("expected numeric keypad mode")
	}
}

func TestESC_SetgLevel(t *testing.T) {
	t.Parallel()
	h := newTestHandler()

	// ESC n → GL = G2
	h.ParseString("\x1bn")
	if h.charsetService.GLevel != 2 {
		t.Errorf("expected GLevel=2, got %d", h.charsetService.GLevel)
	}

	// ESC o → GL = G3
	h.ParseString("\x1bo")
	if h.charsetService.GLevel != 3 {
		t.Errorf("expected GLevel=3, got %d", h.charsetService.GLevel)
	}
}

func TestESC_SelectDefaultCharset(t *testing.T) {
	t.Parallel()
	h := newTestHandler()

	// Set a non-default charset first
	h.charsetService.SetgCharset(0, CharsetDECSpecialGraphics)
	h.charsetService.SetgLevel(0)

	// ESC % G → select default charset
	h.ParseString("\x1b%G")

	if h.charsetService.GLevel != 0 {
		t.Errorf("expected GLevel=0, got %d", h.charsetService.GLevel)
	}
	if h.charsetService.Charset != nil {
		t.Error("expected nil (default) charset")
	}
}

func TestESC_ScreenAlignmentPattern(t *testing.T) {
	t.Parallel()
	opts := NewOptionsService(&TerminalOptions{Cols: 5, Rows: 3})
	bs := NewBufferService(opts)
	cs := NewCharsetService()
	core := NewCoreService(opts)
	osc := NewOscLinkService(bs)
	uni := NewUnicodeService()
	bs.Buffer().FillViewportRows(nil)

	h := NewInputHandler(bs, cs, core, opts, osc, uni)

	// ESC # 8 = DECALN
	h.ParseString("\x1b#8")

	buf := h.activeBuffer()
	for row := range 3 {
		line := buf.Lines.Get(buf.YBase + row)
		text := line.TranslateToString(true, 0, -1)
		if text != "EEEEE" {
			t.Errorf("row %d: expected 'EEEEE', got %q", row, text)
		}
	}

	// Cursor should be at 0,0
	if buf.X != 0 || buf.Y != 0 {
		t.Errorf("expected cursor at (0,0), got (%d,%d)", buf.X, buf.Y)
	}
}

func TestESC_SelectCharset_DECSpecialGraphics(t *testing.T) {
	t.Parallel()
	h := newTestHandler()

	// ESC ( 0 → designate DEC Special Graphics to G0
	h.ParseString("\x1b(0")

	// Now printing 'q' should produce box-drawing horizontal line (U+2500)
	h.ParseString("q")

	buf := h.activeBuffer()
	line := buf.Lines.Get(buf.YBase)
	cp := line.GetCodePoint(0)
	if cp != 0x2500 {
		t.Errorf("expected codepoint 0x2500 (─), got 0x%X", cp)
	}
}
