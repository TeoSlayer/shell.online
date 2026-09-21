package ringbuffer

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	xterm "github.com/gitpod-io/xterm-go"
)

func TestSnapshotRetainsScreenBeforeReplayWindow(t *testing.T) {
	const capacity = 512 * 1024
	buffer := NewTerminal(capacity, 80, 24)
	live := xterm.New(xterm.WithCols(80), xterm.WithRows(24))
	defer live.Dispose()
	write := func(s string) {
		_, _ = buffer.Write([]byte(s))
		live.WriteString(s)
	}
	// A real incremental TUI paints its frame once, then changes only a few
	// cells. A continuously connected terminal must be the reference, NOT a
	// second terminal seeded with the same truncated snapshot.
	write("\x1b[?1049h\x1b[2J\x1b[H\x1b[48;2;20;30;40mPERSISTENT HEADER\x1b[0m")
	write("\x1b[23;1H\x1b[7mPERSISTENT STATUS\x1b[0m\x1b[?25l")
	for i := 0; i < 40000; i++ {
		write(fmt.Sprintf("\x1b[12;35H%08d", i))
	}
	joined := xterm.New(xterm.WithCols(80), xterm.WithRows(24))
	defer joined.Dispose()
	_, _ = joined.Write(buffer.Snapshot())
	assertSameScreen(t, live, joined)
	if joined.IsCursorHidden() != live.IsCursorHidden() {
		t.Fatal("snapshot lost cursor visibility")
	}
}

func TestTerminalSnapshotBoundsAndRecovery(t *testing.T) {
	b := NewTerminal(128, 80, 24)
	defer b.Close()
	b.Write([]byte("visible\x1b]0;" + strings.Repeat("x", 100000)))
	if got := b.Snapshot(); got != nil {
		t.Fatal("oversized unfinished OSC must defer snapshot")
	}
	if len(b.terminal.pending) > 64*1024 || len(b.Bytes()) > 128 {
		t.Fatal("retention exceeds bounds")
	}
	b.Write([]byte("\x07next"))
	if got := b.Snapshot(); len(got) == 0 || len(got) > 512*1024 {
		t.Fatal("snapshot did not recover after OSC completion")
	}
}

func TestTerminalSnapshotConcurrentCutsAndResize(t *testing.T) {
	b := NewTerminal(1024, 80, 24)
	defer b.Close()
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				b.Write([]byte("\x1b[Hstate"))
				v := b.SnapshotView()
				if v.End-v.Start != int64(len(v.Bytes)) || len(v.Replay) == 0 {
					t.Error("inconsistent snapshot cut")
				}
				b.ResizeTerminal(80+j%2, 24)
			}
		}()
	}
	wg.Wait()
}

func assertSameScreen(t *testing.T, want, got *xterm.Terminal) {
	t.Helper()
	for y := 0; y < want.Rows(); y++ {
		w := want.Buffer().Lines.Get(want.Buffer().YBase + y)
		g := got.Buffer().Lines.Get(got.Buffer().YBase + y)
		if w.TranslateToString(false, 0, want.Cols()) != g.TranslateToString(false, 0, got.Cols()) {
			t.Fatalf("row %d differs: want %q, got %q", y, w.TranslateToString(false, 0, want.Cols()), g.TranslateToString(false, 0, got.Cols()))
		}
		for x := 0; x < want.Cols(); x++ {
			wc, gc := xterm.NewCellData(), xterm.NewCellData()
			w.LoadCell(x, wc)
			g.LoadCell(x, gc)
			if wc.GetChars() != "" && !reflect.DeepEqual(wc.AttributeData, gc.AttributeData) {
				t.Fatalf("style differs at %d,%d: want %#v got %#v", x, y, wc.AttributeData, gc.AttributeData)
			}
		}
	}
	if want.CursorX() != got.CursorX() || want.CursorY() != got.CursorY() {
		t.Fatalf("cursor differs: want %d,%d got %d,%d", want.CursorX(), want.CursorY(), got.CursorX(), got.CursorY())
	}
}

func TestTerminalSnapshotContinuesLiveState(t *testing.T) {
	for _, tt := range []struct{ name, before, after string }{
		{"current style", "\x1b[3;4H\x1b[1;38;2;23;45;67mhello", "world"},
		{"scroll region", "\x1b[3;20r\x1b[12;5Hmiddle", "NEXT\n"},
		{"origin mode", "\x1b[3;20r\x1b[?6h\x1b[4;5Hmiddle", "NEXT\n"},
		{"saved cursor", "\x1b[3;4H\x1b[31m\x1b7\x1b[12;20H\x1b[32mcurrent", "\x1b8RESTORED"},
		{"saved origin", "\x1b[3;20r\x1b[?6h\x1b[4;5H\x1b7\x1b[?6lcurrent", "\x1b8\x1b[1;1HRESTORED"},
		{"saved wrap", "\x1b[?7l\x1b7\x1b[?7hcurrent", "\x1b8\x1b[1;79Hlong"},
		{"alternate screen exit", "primary\x1b[?1049h\x1b[4;5Halternate", "\x1b[?1049lMAIN"},
		{"pending wrap", strings.Repeat("x", 80), "wrapped"},
		{"split SGR", "\x1b[3;4Hplain\x1b[38;2;2;", "3;4mCOLOR"},
		{"split UTF8", "\x1b[3;4H\xe6\x97", "\xa5 next"},
		{"split OSC", "visible\x1b]0;private", " title\x07next"},
		{"scrollback", strings.Repeat("line\r\n", 200), "NEXT"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b := NewTerminal(128, 80, 24)
			live := xterm.New(xterm.WithCols(80), xterm.WithRows(24))
			joined := xterm.New(xterm.WithCols(80), xterm.WithRows(24))
			defer live.Dispose()
			defer joined.Dispose()
			_, _ = b.Write([]byte(tt.before))
			live.WriteString(tt.before)
			_, _ = joined.Write(b.Snapshot())
			live.WriteString(tt.after)
			joined.WriteString(tt.after)
			assertSameScreen(t, live, joined)
		})
	}
}
