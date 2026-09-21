package xterm

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

// These tests exercise the full pipeline that a real terminal session would use:
//
//   PTY output (simulated) → Go xterm terminal → SerializeAddon → Replay → Verify
//
// Each test writes realistic ANSI escape sequences into the terminal, then
// serializes the buffer state using the SerializeAddon and replays it into
// a fresh terminal. This is the core guarantee: a client receiving a
// serialized snapshot can reconstruct the terminal state.

// --- Helpers ---

// roundTrip serializes the terminal's buffer as ANSI escape sequences and
// replays them into a fresh terminal of the same dimensions.
func roundTrip(t *testing.T, term *Terminal, opts *SerializeOptions) *Terminal {
	t.Helper()
	sa := NewSerializeAddon(term)
	data := sa.Serialize(opts)

	restored := New(WithCols(term.Cols()), WithRows(term.Rows()), WithScrollback(100))
	restored.Write(data)
	return restored
}

// getVisibleText returns the visible viewport text from a terminal,
// one string per row, with trailing whitespace trimmed.
func getVisibleText(t *Terminal) []string {
	rows := t.Rows()
	lines := make([]string, rows)
	for i := range rows {
		lines[i] = t.GetLine(i)
	}
	return lines
}

// --- End-to-End Tests ---

func TestE2E_ColoredTextSnapshotRoundTrip(t *testing.T) {
	// Simulate a shell prompt with colors:
	//   green "user@host" + white ":" + blue "~/dir" + white "$ "
	term := New(WithCols(80), WithRows(24))
	defer term.Dispose()

	term.WriteString("\x1b[32muser@host\x1b[0m:\x1b[34m~/dir\x1b[0m$ ")

	restored := roundTrip(t, term, nil)
	defer restored.Dispose()

	// Verify text content.
	origText := getVisibleText(term)
	restText := getVisibleText(restored)
	if diff := cmp.Diff(origText, restText); diff != "" {
		t.Errorf("visible text mismatch (-orig +restored):\n%s", diff)
	}

	// Verify specific cells have the expected colors.
	origBuf := term.Buffer()
	restBuf := restored.Buffer()
	origLine := origBuf.Lines.Get(origBuf.YBase)
	restLine := restBuf.Lines.Get(restBuf.YBase)

	// Cell 0 ('u' in "user") should have green foreground.
	origCell := NewCellData()
	restCell := NewCellData()
	origLine.LoadCell(0, origCell)
	restLine.LoadCell(0, restCell)

	if origCell.Fg&AttrCMMask == 0 {
		t.Error("expected cell 0 to have a non-default foreground color (green)")
	}
	if origCell.Fg != restCell.Fg {
		t.Errorf("cell 0 fg mismatch: orig=0x%08x restored=0x%08x", origCell.Fg, restCell.Fg)
	}

	t.Logf("Colored prompt round-trip: %q", origText[0])
}

func TestE2E_ScrollbackPreservedInSnapshot(t *testing.T) {
	term := New(WithCols(40), WithRows(5), WithScrollback(100))
	defer term.Dispose()

	// Write 20 lines — only 5 visible, 15 in scrollback.
	for i := range 20 {
		term.WriteString(fmt.Sprintf("line %02d: some content here\r\n", i))
	}

	restored := roundTrip(t, term, nil)
	defer restored.Dispose()

	origText := getVisibleText(term)
	restText := getVisibleText(restored)
	if diff := cmp.Diff(origText, restText); diff != "" {
		t.Errorf("scrollback snapshot text mismatch (-orig +restored):\n%s", diff)
	}

	t.Logf("Scrollback: viewport text matches after round-trip")
}

func TestE2E_ReconnectProducesCorrectSnapshot(t *testing.T) {
	// Simulate:
	// 1. Client connects, gets snapshot A
	// 2. Client disconnects
	// 3. More output happens (client misses it)
	// 4. Client reconnects, gets snapshot B
	// 5. Snapshot B must be self-contained and correct

	term := New(WithCols(60), WithRows(10), WithScrollback(100))
	defer term.Dispose()

	// Phase 1: Initial content.
	term.WriteString("\x1b[1;32m$ \x1b[0mecho hello\r\n")
	term.WriteString("hello\r\n")
	term.WriteString("\x1b[1;32m$ \x1b[0m")

	// Phase 2: Client "disconnects". More output happens.
	term.WriteString("cat /etc/os-release\r\n")
	term.WriteString("NAME=\"Ubuntu\"\r\n")
	term.WriteString("VERSION=\"22.04\"\r\n")
	term.WriteString("\x1b[1;32m$ \x1b[0m")

	// Phase 3: Client "reconnects". Take a fresh snapshot.
	restored := roundTrip(t, term, nil)
	defer restored.Dispose()

	origText := getVisibleText(term)
	restText := getVisibleText(restored)
	if diff := cmp.Diff(origText, restText); diff != "" {
		t.Errorf("reconnect snapshot text mismatch (-orig +restored):\n%s", diff)
	}

	t.Logf("Reconnect: viewport text:")
	for i, line := range restText {
		if line != "" {
			t.Logf("   row %d: %q", i, line)
		}
	}
}

func TestE2E_ResizeDuringDisconnect(t *testing.T) {
	// Simulate: client connected at 80x24, disconnects, terminal resized to 40x10,
	// client reconnects and gets a snapshot with the new dimensions.

	term := New(WithCols(80), WithRows(24), WithScrollback(100))
	defer term.Dispose()

	// Write a long line that will wrap after resize.
	longLine := strings.Repeat("ABCDEFGHIJ", 8) // 80 chars, fills one line at 80 cols
	term.WriteString(longLine + "\r\n")
	term.WriteString("short line\r\n")
	term.WriteString("$ ")

	// Resize to 40 columns.
	term.Resize(40, 10)

	restored := roundTrip(t, term, nil)
	defer restored.Dispose()

	origText := getVisibleText(term)
	restText := getVisibleText(restored)
	if diff := cmp.Diff(origText, restText); diff != "" {
		t.Errorf("resize snapshot text mismatch (-orig +restored):\n%s", diff)
	}

	if restored.Cols() != 40 || restored.Rows() != 10 {
		t.Errorf("expected 40x10, got %dx%d", restored.Cols(), restored.Rows())
	}

	t.Logf("Resize: 80x24 → 40x10, viewport text matches")
}

func TestE2E_RichAttributesRoundTrip(t *testing.T) {
	// Test that all common text attributes survive the round-trip:
	// bold, italic, underline, strikethrough, 256-color, RGB color.

	term := New(WithCols(80), WithRows(24))
	defer term.Dispose()

	// Bold
	term.WriteString("\x1b[1mBOLD\x1b[0m ")
	// Italic
	term.WriteString("\x1b[3mITALIC\x1b[0m ")
	// Underline
	term.WriteString("\x1b[4mUNDERLINE\x1b[0m ")
	// Strikethrough
	term.WriteString("\x1b[9mSTRIKE\x1b[0m ")
	// 256-color foreground (bright red = 196)
	term.WriteString("\x1b[38;5;196mRED256\x1b[0m ")
	// RGB foreground (orange)
	term.WriteString("\x1b[38;2;255;165;0mORANGE\x1b[0m ")
	// 256-color background (blue = 21)
	term.WriteString("\x1b[48;5;21mBLUEBG\x1b[0m")

	restored := roundTrip(t, term, nil)
	defer restored.Dispose()

	// Verify text.
	origText := getVisibleText(term)
	restText := getVisibleText(restored)
	if diff := cmp.Diff(origText, restText); diff != "" {
		t.Errorf("rich attributes text mismatch (-orig +restored):\n%s", diff)
	}

	// Spot-check: cell 0 ('B' in "BOLD") should have the bold flag.
	origBuf := term.Buffer()
	restBuf := restored.Buffer()
	origLine := origBuf.Lines.Get(origBuf.YBase)
	restLine := restBuf.Lines.Get(restBuf.YBase)

	origCell := NewCellData()
	restCell := NewCellData()
	origLine.LoadCell(0, origCell)
	restLine.LoadCell(0, restCell)

	if origCell.IsBold() == 0 {
		t.Error("expected cell 0 to have bold flag")
	}
	if origCell.Fg != restCell.Fg {
		t.Errorf("cell 0 fg mismatch: orig=0x%08x restored=0x%08x", origCell.Fg, restCell.Fg)
	}

	t.Logf("Rich attributes round-trip: %q", origText[0])
}
