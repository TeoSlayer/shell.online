package xterm

// Tests ported from xterm.js src/common/InputHandler.test.ts plus
// combining character tests for the shouldJoin fix.
//
// Tests that overlap with inputhandler_csi_test.go, inputhandler_sgr_test.go,
// or inputhandler_esc_test.go live in those files. This file contains only
// tests unique to InputHandler.test.ts that are not covered elsewhere.

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type cellInfo struct {
	Chars    string
	Width    int
	Combined bool
}

func getCellInfo(term *Terminal, row, col int) cellInfo {
	buf := term.bufferService.Buffer()
	line := buf.Lines.Get(buf.YBase + row)
	if line == nil {
		return cellInfo{}
	}
	cd := NewCellData()
	line.LoadCell(col, cd)
	return cellInfo{
		Chars:    cd.GetChars(),
		Width:    cd.GetWidth(),
		Combined: cd.IsCombined() != 0,
	}
}

func getViewportLines(term *Terminal, n int) []string {
	lines := make([]string, n)
	for i := range n {
		lines[i] = term.GetLine(i)
	}
	return lines
}

func getAllViewportLines(term *Terminal) []string {
	return getViewportLines(term, term.Rows())
}

func testCellFg(term *Terminal, row, col int) (color int, mode uint32) {
	buf := term.bufferService.Buffer()
	line := buf.Lines.Get(buf.YBase + row)
	if line == nil {
		return 0, 0
	}
	cd := NewCellData()
	line.LoadCell(col, cd)
	return cd.GetFgColor(), cd.GetFgColorMode()
}

func cellAttrs(term *Terminal, row, col int) map[string]bool {
	buf := term.bufferService.Buffer()
	line := buf.Lines.Get(buf.YBase + row)
	if line == nil {
		return nil
	}
	cd := NewCellData()
	line.LoadCell(col, cd)
	return map[string]bool{
		"bold":          cd.IsBold() != 0,
		"dim":           cd.IsDim() != 0,
		"italic":        cd.IsItalic() != 0,
		"underline":     cd.IsUnderline() != 0,
		"blink":         cd.IsBlink() != 0,
		"inverse":       cd.IsInverse() != 0,
		"invisible":     cd.IsInvisible() != 0,
		"strikethrough": cd.IsStrikethrough() != 0,
		"overline":      cd.IsOverline() != 0,
	}
}

// ---------------------------------------------------------------------------
// SL / SR / DECIC / DECDC
// ---------------------------------------------------------------------------

func TestSLScrollLeft(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(5, 6)
	defer term.Dispose()
	for range 6 {
		term.WriteString("12345")
	}
	term.WriteString("\x1b[ @")
	want := []string{"2345", "2345", "2345", "2345", "2345", "2345"}
	if diff := cmp.Diff(want, getAllViewportLines(term)); diff != "" {
		t.Errorf("SL 1 (-want +got):\n%s", diff)
	}
}

func TestSLScrollLeft2(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(5, 6)
	defer term.Dispose()
	for range 6 {
		term.WriteString("12345")
	}
	term.WriteString("\x1b[2 @")
	want := []string{"345", "345", "345", "345", "345", "345"}
	if diff := cmp.Diff(want, getAllViewportLines(term)); diff != "" {
		t.Errorf("SL 2 (-want +got):\n%s", diff)
	}
}

func TestSRScrollRight(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(5, 6)
	defer term.Dispose()
	for range 6 {
		term.WriteString("12345")
	}
	term.WriteString("\x1b[ A")
	want := []string{" 1234", " 1234", " 1234", " 1234", " 1234", " 1234"}
	if diff := cmp.Diff(want, getAllViewportLines(term)); diff != "" {
		t.Errorf("SR 1 (-want +got):\n%s", diff)
	}
}

func TestSRScrollRight2(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(5, 6)
	defer term.Dispose()
	for range 6 {
		term.WriteString("12345")
	}
	term.WriteString("\x1b[2 A")
	want := []string{"  123", "  123", "  123", "  123", "  123", "  123"}
	if diff := cmp.Diff(want, getAllViewportLines(term)); diff != "" {
		t.Errorf("SR 2 (-want +got):\n%s", diff)
	}
}

func TestDECICInsertColumns(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(5, 6)
	defer term.Dispose()
	for range 6 {
		term.WriteString("12345")
	}
	term.WriteString("\x1b[3;3H\x1b['}")
	want := []string{"12 34", "12 34", "12 34", "12 34", "12 34", "12 34"}
	if diff := cmp.Diff(want, getAllViewportLines(term)); diff != "" {
		t.Errorf("DECIC 1 (-want +got):\n%s", diff)
	}
}

func TestDECDCDeleteColumns(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(5, 6)
	defer term.Dispose()
	for range 6 {
		term.WriteString("12345")
	}
	term.WriteString("\x1b[3;3H\x1b['~")
	want := []string{"1245", "1245", "1245", "1245", "1245", "1245"}
	if diff := cmp.Diff(want, getAllViewportLines(term)); diff != "" {
		t.Errorf("DECDC 1 (-want +got):\n%s", diff)
	}
}

// ---------------------------------------------------------------------------
// Print regressions
// ---------------------------------------------------------------------------

func TestPrintNoInfiniteLoop(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	defer term.Dispose()
	term.WriteString("\u200B")
}

func TestPrintWideCharEarlyWrap(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(5, 5)
	defer term.Dispose()
	term.WriteString("12345\uff65\uff65\uff65")
	got := getViewportLines(term, 3)
	want := []string{"12345", "\uff65\uff65\uff65", ""}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("wide char wrap (-want +got):\n%s", diff)
	}
}

func TestPrintSoftHyphen(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	defer term.Dispose()
	term.WriteString("Soft\u00ADhy\u00ADphen")
	if got := term.GetLine(0); got != "Softhyphen" {
		t.Errorf("got %q, want %q", got, "Softhyphen")
	}
	if term.CursorX() != 10 {
		t.Errorf("cursorX = %d, want 10", term.CursorX())
	}
}

// ---------------------------------------------------------------------------
// SGR color mode transitions
// ---------------------------------------------------------------------------

func TestSGRColorModeTransition(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		input    string
		wantFg   int
		wantMode uint32
	}{
		{"rgb_to_256", "\x1b[38;2;100;150;200mA\x1b[38;5;196mB", 196, AttrCMP256},
		{"rgb_to_16", "\x1b[38;2;100;150;200mA\x1b[31mB", 1, AttrCMP16},
		{"16_to_256", "\x1b[31mA\x1b[38;5;196mB", 196, AttrCMP256},
		{"256_to_16", "\x1b[38;5;196mA\x1b[31mB", 1, AttrCMP16},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			term := newTestTerminal(80, 24)
			defer term.Dispose()
			term.WriteString(tc.input)
			fg, mode := testCellFg(term, 0, 1)
			if fg != tc.wantFg || mode != tc.wantMode {
				t.Errorf("fg=%d mode=%d, want fg=%d mode=%d", fg, mode, tc.wantFg, tc.wantMode)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// SGR colon notation (subparams)
// ---------------------------------------------------------------------------

func TestSGRColonRGB(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	defer term.Dispose()
	term.WriteString("\x1b[38:2::50:100:150mA")
	fg, m := testCellFg(term, 0, 0)
	wantRGB := (50 << 16) | (100 << 8) | 150
	if fg != wantRGB || m != AttrCMRGB {
		t.Errorf("fg=0x%06x mode=%d, want 0x%06x mode=%d", fg, m, wantRGB, AttrCMRGB)
	}
}

func TestSGRColon256(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	defer term.Dispose()
	term.WriteString("\x1b[38:5:50mA")
	fg, m := testCellFg(term, 0, 0)
	if fg != 50 || m != AttrCMP256 {
		t.Errorf("fg=%d mode=%d, want 50 mode=%d", fg, m, AttrCMP256)
	}
}

func TestSGRColonWithAttrs(t *testing.T) {
	t.Parallel()
	term := newTestTerminal(80, 24)
	defer term.Dispose()
	term.WriteString("\x1b[1;38:2::50:100:150;4mA")
	a := cellAttrs(term, 0, 0)
	if !a["bold"] {
		t.Error("should be bold")
	}
	if !a["underline"] {
		t.Error("should be underlined")
	}
	fg, m := testCellFg(term, 0, 0)
	wantRGB := (50 << 16) | (100 << 8) | 150
	if fg != wantRGB || m != AttrCMRGB {
		t.Errorf("fg=0x%06x mode=%d, want 0x%06x mode=%d", fg, m, wantRGB, AttrCMRGB)
	}
}

// ---------------------------------------------------------------------------
// Combining characters
// ---------------------------------------------------------------------------

func TestPrintCombiningCharacters(t *testing.T) {
	t.Parallel()

	t.Run("variation_selector_VS15", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()
		term.Write([]byte("\xe2\x9c\x94\xef\xb8\x8e")) // ✔ + U+FE0E
		cell := getCellInfo(term, 0, 0)
		want := cellInfo{Chars: "✔\uFE0E", Width: 1, Combined: true}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("(-want +got):\n%s", diff)
		}
		if term.CursorX() != 1 {
			t.Errorf("cursorX = %d, want 1", term.CursorX())
		}
	})

	t.Run("variation_selector_VS16", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()
		term.Write([]byte("\xe2\x9c\x94\xef\xb8\x8f")) // ✔ + U+FE0F
		cell := getCellInfo(term, 0, 0)
		want := cellInfo{Chars: "✔\uFE0F", Width: 1, Combined: true}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("(-want +got):\n%s", diff)
		}
	})

	t.Run("combining_accent", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()
		term.WriteString("e\u0301")
		cell := getCellInfo(term, 0, 0)
		want := cellInfo{Chars: "e\u0301", Width: 1, Combined: true}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("(-want +got):\n%s", diff)
		}
		if term.CursorX() != 1 {
			t.Errorf("cursorX = %d, want 1", term.CursorX())
		}
	})

	t.Run("multiple_combining_marks", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()
		term.WriteString("a\u0301\u0303")
		cell := getCellInfo(term, 0, 0)
		want := cellInfo{Chars: "a\u0301\u0303", Width: 1, Combined: true}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("(-want +got):\n%s", diff)
		}
		if term.CursorX() != 1 {
			t.Errorf("cursorX = %d, want 1", term.CursorX())
		}
	})

	t.Run("no_join_at_line_start", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()
		term.WriteString("\u0301")
		if term.CursorX() != 1 {
			t.Errorf("cursorX = %d, want 1", term.CursorX())
		}
	})

	t.Run("normal_after_combining", func(t *testing.T) {
		t.Parallel()
		term := newTestTerminal(80, 24)
		defer term.Dispose()
		term.WriteString("e\u0301x")
		cell0 := getCellInfo(term, 0, 0)
		want0 := cellInfo{Chars: "e\u0301", Width: 1, Combined: true}
		if diff := cmp.Diff(want0, cell0); diff != "" {
			t.Errorf("cell 0 (-want +got):\n%s", diff)
		}
		cell1 := getCellInfo(term, 0, 1)
		want1 := cellInfo{Chars: "x", Width: 1, Combined: false}
		if diff := cmp.Diff(want1, cell1); diff != "" {
			t.Errorf("cell 1 (-want +got):\n%s", diff)
		}
		if term.CursorX() != 2 {
			t.Errorf("cursorX = %d, want 2", term.CursorX())
		}
	})
}

// ---------------------------------------------------------------------------
// Print wrap + combining character (issue #41)
// ---------------------------------------------------------------------------

func TestPrintWrapCombiningCharWidensCell(t *testing.T) {
	t.Parallel()

	t.Run("combining_at_last_column_no_wrap", func(t *testing.T) {
		// A combining mark on the last character of a line should NOT wrap;
		// it should join in-place.
		t.Parallel()
		term := newTestTerminal(5, 5)
		defer term.Dispose()
		// Fill 5 columns: "abcde", then add combining accent to 'e'.
		term.WriteString("abcde\u0301")
		cell := getCellInfo(term, 0, 4)
		want := cellInfo{Chars: "e\u0301", Width: 1, Combined: true}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("last col cell (-want +got):\n%s", diff)
		}
		// Cursor should still be at col 5 (past end), row 0.
		if term.CursorX() != 5 {
			t.Errorf("cursorX = %d, want 5", term.CursorX())
		}
		if term.CursorY() != 0 {
			t.Errorf("cursorY = %d, want 0", term.CursorY())
		}
	})

	t.Run("wide_char_wrap_then_combining", func(t *testing.T) {
		// A wide (width-2) char that wraps to the next line, followed by a
		// combining mark, should show the combined character on the new line.
		t.Parallel()
		term := newTestTerminal(5, 5)
		defer term.Dispose()
		// Fill 4 columns, then write a wide char (U+4E16 '世', width 2).
		// The wide char doesn't fit at col 4 (needs 2 cells), so it wraps.
		term.WriteString("abcd\u4e16\u0301")
		// Row 0 should be "abcd" (wide char wrapped away).
		line0 := term.GetLine(0)
		if line0 != "abcd" {
			t.Errorf("row 0 = %q, want %q", line0, "abcd")
		}
		// Row 1 should have the wide char with combining mark at col 0.
		cell := getCellInfo(term, 1, 0)
		want := cellInfo{Chars: "世\u0301", Width: 2, Combined: true}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("row 1 col 0 (-want +got):\n%s", diff)
		}
	})

	t.Run("oldWidth_combining_joins_in_place", func(t *testing.T) {
		// When cursor is at cols (past end) and a combining mark joins the
		// preceding width-1 char, no wrap should occur (chWidth - oldWidth = 0).
		t.Parallel()
		term := newTestTerminal(5, 5)
		defer term.Dispose()
		term.WriteString("1234A")
		if term.CursorX() != 5 {
			t.Fatalf("setup: cursorX = %d, want 5", term.CursorX())
		}
		term.WriteString("\u0301")
		cell := getCellInfo(term, 0, 4)
		want := cellInfo{Chars: "A\u0301", Width: 1, Combined: true}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("cell at (0,4) (-want +got):\n%s", diff)
		}
		if term.CursorX() != 5 {
			t.Errorf("cursorX = %d, want 5", term.CursorX())
		}
		if term.CursorY() != 0 {
			t.Errorf("cursorY = %d, want 0", term.CursorY())
		}
	})

	t.Run("wrap_sets_bufX_to_oldWidth", func(t *testing.T) {
		// Verify that after a normal (non-combining) wrap, buf.X is set
		// correctly. The fix changes buf.X = 0 to buf.X = oldWidth; for
		// non-combining chars oldWidth is 0, so behavior is identical.
		t.Parallel()
		term := newTestTerminal(5, 5)
		defer term.Dispose()
		term.WriteString("12345X")
		line0 := term.GetLine(0)
		if line0 != "12345" {
			t.Errorf("row 0 = %q, want %q", line0, "12345")
		}
		cell := getCellInfo(term, 1, 0)
		want := cellInfo{Chars: "X", Width: 1, Combined: false}
		if diff := cmp.Diff(want, cell); diff != "" {
			t.Errorf("row 1 col 0 (-want +got):\n%s", diff)
		}
		if term.CursorX() != 1 {
			t.Errorf("cursorX = %d, want 1", term.CursorX())
		}
		if term.CursorY() != 1 {
			t.Errorf("cursorY = %d, want 1", term.CursorY())
		}
		// Verify the second line is marked as wrapped.
		buf := term.bufferService.Buffer()
		wrappedLine := buf.Lines.Get(buf.YBase + 1)
		if wrappedLine == nil {
			t.Fatal("row 1 line is nil")
		}
		if !wrappedLine.IsWrapped {
			t.Error("row 1 should be marked as wrapped")
		}
	})
}
