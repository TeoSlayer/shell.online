package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func newTestBufferService(cols, rows, scrollback int) *BufferService {
	opts := NewOptionsService(&TerminalOptions{
		Cols:       cols,
		Rows:       rows,
		Scrollback: scrollback,
	})
	return NewBufferService(opts)
}

func TestBufferServiceNew(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Cols            int
		Rows            int
		BufferNotNil    bool
		BuffersNotNil   bool
		IsUserScrolling bool
	}

	bs := newTestBufferService(80, 24, 1000)
	got := Expectation{
		Cols:            bs.Cols,
		Rows:            bs.Rows,
		BufferNotNil:    bs.Buffer() != nil,
		BuffersNotNil:   bs.Buffers != nil,
		IsUserScrolling: bs.IsUserScrolling,
	}
	expected := Expectation{
		Cols:            80,
		Rows:            24,
		BufferNotNil:    true,
		BuffersNotNil:   true,
		IsUserScrolling: false,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceMinimumDimensions(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Cols int
		Rows int
	}

	// Create options with cols/rows below minimum, bypassing the override logic
	opts := NewOptionsService(nil)
	opts.Options.Cols = 1
	opts.Options.Rows = 0
	bs := NewBufferService(opts)

	got := Expectation{Cols: bs.Cols, Rows: bs.Rows}
	expected := Expectation{Cols: MinimumCols, Rows: MinimumRows}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceWindowsPtyModeFromOptions(t *testing.T) {
	t.Parallel()

	tests := []struct {
		Name       string
		WindowsPty WindowsPty
		Expected   bool
	}{
		{
			Name:       "unset",
			WindowsPty: WindowsPty{},
			Expected:   false,
		},
		{
			Name:       "legacy conpty",
			WindowsPty: WindowsPty{Backend: "conpty", BuildNo: 21375},
			Expected:   true,
		},
		{
			Name:       "backend only",
			WindowsPty: WindowsPty{Backend: "winpty"},
			Expected:   true,
		},
		{
			Name:       "build number only",
			WindowsPty: WindowsPty{BuildNo: 21376},
			Expected:   true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			opts := NewOptionsService(&TerminalOptions{
				WindowsPty: tc.WindowsPty,
			})
			bs := NewBufferService(opts)

			got := struct {
				Normal bool
				Alt    bool
			}{
				Normal: bs.Buffers.Normal().windowsPty,
				Alt:    bs.Buffers.Alt().windowsPty,
			}
			expected := struct {
				Normal bool
				Alt    bool
			}{Normal: tc.Expected, Alt: tc.Expected}
			if diff := cmp.Diff(expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferServiceWindowsPtyModeOptionChange(t *testing.T) {
	t.Parallel()

	opts := NewOptionsService(nil)
	bs := NewBufferService(opts)
	opts.SetOption("windowsPty", WindowsPty{Backend: "winpty"})

	gotBeforeReset := bs.Buffers.Normal().windowsPty
	bs.Reset()
	gotAfterReset := bs.Buffers.Normal().windowsPty
	if !gotBeforeReset || !gotAfterReset {
		t.Errorf("windowsPty mode = before reset %v, after reset %v; want both true", gotBeforeReset, gotAfterReset)
	}
}

func TestBufferServiceResize(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Cols        int
		Rows        int
		ColsChanged bool
		RowsChanged bool
	}

	bs := newTestBufferService(80, 24, 1000)
	var event BufferResizeEvent
	bs.OnResizeEmitter.Event(func(e BufferResizeEvent) { event = e })
	bs.Resize(120, 40)

	got := Expectation{
		Cols:        bs.Cols,
		Rows:        bs.Rows,
		ColsChanged: event.ColsChanged,
		RowsChanged: event.RowsChanged,
	}
	expected := Expectation{Cols: 120, Rows: 40, ColsChanged: true, RowsChanged: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceResizeNoChange(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ColsChanged bool
		RowsChanged bool
	}

	bs := newTestBufferService(80, 24, 1000)
	var event BufferResizeEvent
	bs.OnResizeEmitter.Event(func(e BufferResizeEvent) { event = e })
	bs.Resize(80, 24)

	got := Expectation{ColsChanged: event.ColsChanged, RowsChanged: event.RowsChanged}
	expected := Expectation{ColsChanged: false, RowsChanged: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceReset(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		IsUserScrolling bool
		CursorX         int
		CursorY         int
	}

	bs := newTestBufferService(80, 24, 1000)
	bs.IsUserScrolling = true
	bs.Buffer().X = 10
	bs.Buffer().Y = 5
	bs.Reset()

	got := Expectation{
		IsUserScrolling: bs.IsUserScrolling,
		CursorX:         bs.Buffer().X,
		CursorY:         bs.Buffer().Y,
	}
	expected := Expectation{IsUserScrolling: false, CursorX: 0, CursorY: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScroll(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YBase       int
		YDisp       int
		LinesLength int
		ScrollEvent int
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()

	var lastScroll int
	bs.OnScrollEmitter.Event(func(v int) { lastScroll = v })

	// Scroll once — should increase ybase since buffer isn't full
	bs.Scroll(&da, false)

	got := Expectation{
		YBase:       bs.Buffer().YBase,
		YDisp:       bs.Buffer().YDisp,
		LinesLength: bs.Buffer().Lines.Length(),
		ScrollEvent: lastScroll,
	}
	expected := Expectation{
		YBase:       1,
		YDisp:       1,
		LinesLength: 6,
		ScrollEvent: 1,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollWrapped(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		IsWrapped bool
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()
	bs.Scroll(&da, true)

	// The new line at the bottom should be wrapped
	lastLine := bs.Buffer().Lines.Get(bs.Buffer().Lines.Length() - 1)
	got := Expectation{IsWrapped: lastLine.IsWrapped}
	expected := Expectation{IsWrapped: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollUserScrolling(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YDisp int
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()

	// Scroll a few times to build up ybase
	for range 3 {
		bs.Scroll(&da, false)
	}

	// Simulate user scrolling up
	bs.IsUserScrolling = true
	bs.Buffer().YDisp = 0

	// Scroll again — ydisp should stay at user's position
	bs.Scroll(&da, false)

	got := Expectation{YDisp: bs.Buffer().YDisp}
	// ydisp stays where user put it (not following ybase)
	expected := Expectation{YDisp: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollWithScrollRegion(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YBase       int
		LinesLength int
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()

	// Set a scroll region (not starting at 0)
	bs.Buffer().ScrollTop = 1
	bs.Buffer().ScrollBottom = 3

	bs.Scroll(&da, false)

	// With non-zero scrollTop, ybase should not change
	got := Expectation{
		YBase:       bs.Buffer().YBase,
		LinesLength: bs.Buffer().Lines.Length(),
	}
	expected := Expectation{YBase: 0, LinesLength: 5}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollLines(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YDisp           int
		IsUserScrolling bool
		ScrollEvents    int
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()

	// Build up scrollback
	for range 10 {
		bs.Scroll(&da, false)
	}

	scrollEvents := 0
	bs.OnScrollEmitter.Event(func(int) { scrollEvents++ })

	// Scroll up
	bs.ScrollLines(-3, false)

	got := Expectation{
		YDisp:           bs.Buffer().YDisp,
		IsUserScrolling: bs.IsUserScrolling,
		ScrollEvents:    scrollEvents,
	}
	expected := Expectation{YDisp: 7, IsUserScrolling: true, ScrollEvents: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollLinesDown(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YDisp           int
		IsUserScrolling bool
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()

	for range 10 {
		bs.Scroll(&da, false)
	}

	// Scroll up first
	bs.ScrollLines(-5, false)
	// Then scroll back down to bottom
	bs.ScrollLines(5, false)

	got := Expectation{
		YDisp:           bs.Buffer().YDisp,
		IsUserScrolling: bs.IsUserScrolling,
	}
	expected := Expectation{YDisp: 10, IsUserScrolling: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollLinesAtTop(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YDisp        int
		ScrollEvents int
	}

	bs := newTestBufferService(80, 5, 100)
	// No scrollback, ydisp is already 0
	scrollEvents := 0
	bs.OnScrollEmitter.Event(func(int) { scrollEvents++ })

	bs.ScrollLines(-1, false)

	got := Expectation{YDisp: bs.Buffer().YDisp, ScrollEvents: scrollEvents}
	expected := Expectation{YDisp: 0, ScrollEvents: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollLinesSuppressEvent(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ScrollEvents int
		YDisp        int
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()
	for range 10 {
		bs.Scroll(&da, false)
	}

	scrollEvents := 0
	bs.OnScrollEmitter.Event(func(int) { scrollEvents++ })

	bs.ScrollLines(-2, true)

	got := Expectation{ScrollEvents: scrollEvents, YDisp: bs.Buffer().YDisp}
	expected := Expectation{ScrollEvents: 0, YDisp: 8}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceScrollLinesClampToZero(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		YDisp int
	}

	bs := newTestBufferService(80, 5, 100)
	da := DefaultAttrData()
	for range 3 {
		bs.Scroll(&da, false)
	}

	// Try to scroll way past the top
	bs.ScrollLines(-100, false)

	got := Expectation{YDisp: bs.Buffer().YDisp}
	expected := Expectation{YDisp: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceDispose(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ResizeEvents int
		ScrollEvents int
	}

	bs := newTestBufferService(80, 24, 1000)
	resizeCount := 0
	scrollCount := 0
	bs.OnResizeEmitter.Event(func(BufferResizeEvent) { resizeCount++ })
	bs.OnScrollEmitter.Event(func(int) { scrollCount++ })
	bs.Dispose()
	bs.Resize(120, 40)

	got := Expectation{ResizeEvents: resizeCount, ScrollEvents: scrollCount}
	expected := Expectation{ResizeEvents: 0, ScrollEvents: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferServiceBufferActivateFiresScroll(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ScrollFired bool
	}

	bs := newTestBufferService(80, 24, 1000)
	scrollFired := false
	bs.OnScrollEmitter.Event(func(int) { scrollFired = true })

	// Switching to alt buffer should fire scroll event
	bs.Buffers.ActivateAltBuffer(nil)

	got := Expectation{ScrollFired: scrollFired}
	expected := Expectation{ScrollFired: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
