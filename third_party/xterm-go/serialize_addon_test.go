package xterm

import (
	"bytes"
	"testing"

	"github.com/google/go-cmp/cmp"
)

func newSerializeTestTerminal(cols, rows int) *Terminal {
	return New(WithCols(cols), WithRows(rows), WithScrollback(100))
}

func TestSerializeAddon_PlainText(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("hello world")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	// Replay into a fresh terminal and compare
	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("plain text round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestSerializeAddon_MultipleLines(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("line 1\r\nline 2\r\nline 3")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("multi-line round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestSerializeAddon_ColoredText(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	// Red foreground, blue background
	term.WriteString("\x1b[31m\x1b[44mcolored\x1b[0m plain")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("colored text round-trip mismatch (-want +got):\n%s", diff)
	}

	// Verify the serialized output contains SGR sequences
	if !bytes.Contains(result, []byte("\x1b[")) {
		t.Error("expected SGR sequences in serialized output")
	}
}

func TestSerializeAddon_256Color(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("\x1b[38;5;196m\x1b[48;5;21mX\x1b[0m")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("256-color round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestSerializeAddon_TrueColor(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("\x1b[38;2;255;128;0mRGB\x1b[0m")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("true-color round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestSerializeAddon_BoldItalicUnderline(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("bold/italic/underline round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestSerializeAddon_CursorPosition(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("hello\x1b[3;5H") // Move cursor to row 3, col 5

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if term.CursorX() != term2.CursorX() || term.CursorY() != term2.CursorY() {
		t.Errorf("cursor position mismatch: want (%d,%d), got (%d,%d)",
			term.CursorX(), term.CursorY(), term2.CursorX(), term2.CursorY())
	}
}

func TestSerializeAddon_Scrollback(t *testing.T) {
	term := newSerializeTestTerminal(80, 5)
	defer term.Dispose()

	// Write more lines than the viewport to create scrollback
	for range 10 {
		term.WriteString("line\r\n")
	}
	term.WriteString("last")

	sa := NewSerializeAddon(term)

	// Serialize with limited scrollback
	scrollback := 2
	result := sa.Serialize(&SerializeOptions{Scrollback: &scrollback})

	// Should contain fewer lines than full serialization
	fullResult := sa.Serialize(nil)
	if len(result) >= len(fullResult) {
		t.Error("limited scrollback should produce shorter output")
	}
}

func TestSerializeAddon_Range(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("line 0\r\nline 1\r\nline 2\r\nline 3\r\nline 4")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(&SerializeOptions{
		Range: &SerializeRange{Start: 1, End: 3},
	})

	// The range should include lines 1-3
	if !bytes.Contains(result, []byte("line 1")) {
		t.Error("expected 'line 1' in range output")
	}
	if !bytes.Contains(result, []byte("line 3")) {
		t.Error("expected 'line 3' in range output")
	}
}

func TestSerializeAddon_EmptyTerminal(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	// Should produce empty or minimal output
	if len(result) > 0 {
		// Replay should produce an empty terminal
		term2 := newSerializeTestTerminal(80, 24)
		defer term2.Dispose()
		term2.Write(result)
		if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
			t.Errorf("empty terminal round-trip mismatch (-want +got):\n%s", diff)
		}
	}
}

func TestSerializeAddon_ExcludeModes(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("hello")

	sa := NewSerializeAddon(term)

	withModes := sa.Serialize(nil)
	withoutModes := sa.Serialize(&SerializeOptions{ExcludeModes: true})

	// Both should contain the text
	if !bytes.Contains(withModes, []byte("hello")) {
		t.Error("expected 'hello' in output with modes")
	}
	if !bytes.Contains(withoutModes, []byte("hello")) {
		t.Error("expected 'hello' in output without modes")
	}
}

func TestSerializeAddon_WideCharacters(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("你好世界") //nolint:gosmopolitan

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("wide char round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestSerializeAddon_MixedContent(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	// Mix of colors, text, and cursor movement
	term.WriteString("\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m\r\n")
	term.WriteString("\x1b[1;4mbold underline\x1b[0m\r\n")
	term.WriteString("plain text")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	term2 := newSerializeTestTerminal(80, 24)
	defer term2.Dispose()
	term2.Write(result)

	if diff := cmp.Diff(term.String(), term2.String()); diff != "" {
		t.Errorf("mixed content round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestSerializeAddon_CursorHidden(t *testing.T) {
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	term.WriteString("\x1b[?25l") // Hide cursor

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	if !bytes.Contains(result, []byte("\x1b[?25l")) {
		t.Error("expected cursor hide sequence in output")
	}
}

func TestSerializeAddon_DiffStyleFlagOnlyChange(t *testing.T) {
	// When only a flag (e.g. bold) changes but color stays the same,
	// diffStyle must emit only the flag SGR, not re-emit the color.
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	// Green foreground text, then bold green text (same color, flag changes).
	term.WriteString("\x1b[32mplain\x1b[1mbold\x1b[0m")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	// The serialized output should NOT contain "32" (green fg) a second time
	// when bold is toggled on — only "1" (bold) should appear.
	// Count occurrences of "\x1b[32m" — should be exactly 1.
	count := bytes.Count(result, []byte("\x1b[32m"))
	if count != 1 {
		t.Errorf("expected \\x1b[32m exactly once, got %d times in: %q", count, result)
	}

	// The bold transition should produce only "\x1b[1m", not "\x1b[32;1m" or similar.
	if bytes.Contains(result, []byte("32;1")) {
		t.Errorf("diffStyle re-emitted fg color with bold flag change: %q", result)
	}
}

func TestSerializeAddon_DiffStyleBgOnlyChange(t *testing.T) {
	// When only background changes but flags stay the same,
	// diffStyle must emit only the bg SGR, not flags.
	term := newSerializeTestTerminal(80, 24)
	defer term.Dispose()

	// Bold + green bg text, then bold + red bg text (flag same, bg changes).
	term.WriteString("\x1b[1;42mA\x1b[41mB\x1b[0m")

	sa := NewSerializeAddon(term)
	result := sa.Serialize(nil)

	// The transition from green bg to red bg should not re-emit "1" (bold).
	if bytes.Contains(result, []byte("1;41")) {
		t.Errorf("diffStyle re-emitted bold flag with bg-only change: %q", result)
	}
}

func TestSerializeAddon_Constrain(t *testing.T) {
	tests := []struct {
		v, min, max, want int
	}{
		{5, 0, 10, 5},
		{-1, 0, 10, 0},
		{15, 0, 10, 10},
		{0, 0, 0, 0},
	}
	for _, tt := range tests {
		got := constrain(tt.v, tt.min, tt.max)
		if got != tt.want {
			t.Errorf("constrain(%d, %d, %d) = %d, want %d", tt.v, tt.min, tt.max, got, tt.want)
		}
	}
}
