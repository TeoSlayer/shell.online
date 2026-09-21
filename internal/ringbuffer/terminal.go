package ringbuffer

import (
	"fmt"
	"maps"
	"strings"

	xterm "github.com/gitpod-io/xterm-go"
)

// NewTerminal retains the bounded raw stream for live delivery AND a bounded
// VT screen for late joins/recovery. A byte tail is not a terminal snapshot:
// incremental applications may never repaint cells whose bytes were evicted.
// All plaintext stays in the existing Go host's memory, before encryption.
func NewTerminal(capacity, cols, rows int) *Buffer {
	b := New(capacity)
	b.terminal = &terminalState{vt: xterm.New(xterm.WithCols(cols), xterm.WithRows(rows), xterm.WithScrollback(100))}
	return b
}

type terminalState struct {
	vt              *xterm.Terminal
	phase           byte
	utf8            int
	pending         []byte
	pendingOverflow bool
}

func (s *terminalState) write(data []byte) {
	_, _ = s.vt.Write(data)
	// The serializer describes completed VT actions, not the parser's partial
	// escape/UTF-8 input. Carry that unfinished suffix after the screen so the
	// next live frame continues parsing rather than drawing escape fragments.
	for _, b := range data {
		s.phase = step(s.phase, b)
		if s.utf8 > 0 && b&0xc0 == 0x80 {
			s.utf8--
		} else {
			s.utf8 = 0
			switch {
			case b >= 0xc2 && b <= 0xdf:
				s.utf8 = 1
			case b >= 0xe0 && b <= 0xef:
				s.utf8 = 2
			case b >= 0xf0 && b <= 0xf4:
				s.utf8 = 3
			}
		}
		if s.phase == phaseGround && s.utf8 == 0 {
			s.pending = s.pending[:0]
			s.pendingOverflow = false
		} else {
			if len(s.pending) < 64*1024 {
				s.pending = append(s.pending, b)
			} else {
				s.pendingOverflow = true
			}
		}
	}
}

func (s *terminalState) snapshot() []byte {
	// Wait for the end of an oversized unfinished control string rather than
	// retaining unbounded bytes or seeding an invalid parser state.
	if s.pendingOverflow {
		return nil
	}
	addon := xterm.NewSerializeAddon(s.vt)
	replay := addon.Serialize(nil)
	if s.vt.IsAltBufferActive() {
		// The addon uses the *active* pen when finishing the normal buffer.
		// Entering 1049 then saves that wrong pen for the later alt-screen exit.
		// Restore the real normal-screen pen before the generated 1049 switch.
		normal := addon.Serialize(&xterm.SerializeOptions{ExcludeAltBuffer: true, ExcludeModes: true})
		prefix := append(normal, sgr(s.vt.NormalBuffer().SavedState.CurAttrData)...)
		prefix = append(prefix, charsetState(s.vt.NormalBuffer().SavedState.Charsets, s.vt.NormalBuffer().SavedState.GLevel)...)
		replay = append(prefix, replay[len(normal):]...)
	}
	// SerializeAddon paints cells and modes, but does not preserve DECSC's
	// saved cursor. Restore it before the current pen/position so a subsequent
	// ESC 8 from an incremental application does not jump to the top-left.
	saved := s.vt.Buffer().SavedState
	ySaved := max(0, min(s.vt.Rows()-1, saved.Y-s.vt.Buffer().YBase))
	replay = append(replay, "\x1b[?6l"...)
	if saved.OriginMode {
		replay = append(replay, "\x1b[?6h"...)
		ySaved -= s.vt.ScrollTop()
	}
	replay = append(replay, privateMode(7, saved.WraparoundMode)...)
	replay = append(replay, sgr(saved.CurAttrData)...)
	replay = append(replay, charsetState(saved.Charsets, saved.GLevel)...)
	replay = append(replay, fmt.Sprintf("\x1b[%d;%dH\x1b7", ySaved+1, saved.X+1)...)
	// Cell text below is already Unicode, not input in the saved G-set.
	replay = append(replay, charsetState(nil, 0)...)
	replay = append(replay, privateMode(6, s.vt.DecPrivateModes().Origin)...)
	replay = append(replay, privateMode(7, s.vt.DecPrivateModes().Wraparound)...)
	// Tab stops and mouse encoding are parser/input state, not painted cells.
	replay = append(replay, "\x1b[3g"...)
	for x := 0; x < s.vt.Cols(); x++ {
		if s.vt.Buffer().Tabs[x] {
			replay = append(replay, fmt.Sprintf("\x1b[%dG\x1bH", x+1)...)
		}
	}
	mode := s.vt.DecPrivateModes()
	replay = append(replay, privateMode(1006, mode.MouseEncoding == "SGR")...)
	replay = append(replay, privateMode(1016, mode.MouseEncoding == "SGR_PIXELS")...)
	replay = append(replay, sgr(s.vt.CurAttrData())...)
	// DECSTBM and origin-mode restoration can home the cursor. Restore its
	// position after modes, not before them. CUP is origin-relative under DECOM.
	y := s.vt.CursorY()
	if s.vt.DecPrivateModes().Origin {
		y -= s.vt.ScrollTop()
	}
	if s.vt.CursorX() < s.vt.Cols() {
		replay = append(replay, fmt.Sprintf("\x1b[%d;%dH", y+1, s.vt.CursorX()+1)...)
	} else {
		// CUP cannot express the pending-autowrap state. Repaint just the
		// final cell (or wide character) to re-establish it without scrolling.
		line := s.vt.Buffer().Lines.Get(s.vt.Buffer().YBase + s.vt.CursorY())
		cell := xterm.NewCellData()
		x := s.vt.Cols() - 1
		for x > 0 {
			line.LoadCell(x, cell)
			if cell.GetWidth() != 0 {
				break
			}
			x--
		}
		replay = append(replay, fmt.Sprintf("\x1b[%d;%dH", y+1, x+1)...)
		replay = append(replay, sgr(cell.AttributeData)...)
		replay = append(replay, cell.GetChars()...)
		replay = append(replay, sgr(s.vt.CurAttrData())...)
	}
	replay = append(replay, charsetState(s.vt.CharsetState())...)
	replay = append(replay, s.pending...)
	if len(replay) > 512*1024 {
		return nil
	} // relay bound: never truncate a VT stream
	return replay
}

func charsetState(sets []xterm.Charset, level int) string {
	var out strings.Builder
	for i := 0; i < 4; i++ {
		id := byte('B')
		if i < len(sets) && sets[i] != nil {
			for c := byte(0); c < 127; c++ {
				if candidate, ok := xterm.CHARSETS[c]; ok && maps.Equal(candidate, sets[i]) {
					id = c
					break
				}
			}
		}
		out.Write([]byte{27, byte('(' + i), id})
	}
	out.WriteString([]string{"\x0f", "\x0e", "\x1bn", "\x1bo"}[max(0, min(3, level))])
	return out.String()
}

func privateMode(mode int, enabled bool) string {
	suffix := "l"
	if enabled {
		suffix = "h"
	}
	return fmt.Sprintf("\x1b[?%d%s", mode, suffix)
}

func sgr(a xterm.AttributeData) string {
	parts := []string{"0"}
	for _, flag := range []struct {
		set  uint32
		code string
	}{
		{a.IsBold(), "1"}, {a.IsDim(), "2"}, {a.IsItalic(), "3"},
		{a.IsBlink(), "5"}, {a.IsInverse(), "7"}, {a.IsInvisible(), "8"},
		{a.IsStrikethrough(), "9"}, {a.IsOverline(), "53"},
	} {
		if flag.set != 0 {
			parts = append(parts, flag.code)
		}
	}
	if a.IsUnderline() != 0 {
		parts = append(parts, fmt.Sprintf("4:%d", max(1, int(a.GetUnderlineStyle()))))
	}
	color := func(code int, mode uint32, value int) {
		switch mode {
		case xterm.AttrCMRGB:
			parts = append(parts, fmt.Sprintf("%d;2;%d;%d;%d", code, (value>>16)&255, (value>>8)&255, value&255))
		case xterm.AttrCMP16:
			base := 30
			if code == 48 {
				base = 40
			}
			if value >= 8 {
				base += 60
				value -= 8
			}
			parts = append(parts, fmt.Sprint(base+value))
		case xterm.AttrCMP256:
			parts = append(parts, fmt.Sprintf("%d;5;%d", code, value))
		}
	}
	color(38, a.GetFgColorMode(), a.GetFgColor())
	color(48, a.GetBgColorMode(), a.GetBgColor())
	if !a.IsUnderlineColorDefault() {
		color(58, a.GetUnderlineColorMode(), a.GetUnderlineColor())
	}
	return "\x1b[" + strings.Join(parts, ";") + "m"
}

// ResizeTerminal must accompany the host PTY resize. Keeping the emulator
// on the canonical grid avoids interpreting old output at a new viewer size.
func (buffer *Buffer) ResizeTerminal(cols, rows int) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if buffer.terminal != nil {
		buffer.terminal.vt.Resize(cols, rows)
	}
}

func (buffer *Buffer) Close() {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if buffer.terminal != nil {
		buffer.terminal.vt.Dispose()
	}
}
