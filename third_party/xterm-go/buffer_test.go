package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func defaultBufferOpts() BufferOptions {
	return BufferOptions{
		Cols:          80,
		Rows:          24,
		Scrollback:    1000,
		TabStopWidth:  8,
		HasScrollback: true,
	}
}

func TestBufferNew(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Cols         int
		Rows         int
		ScrollTop    int
		ScrollBottom int
		X            int
		Y            int
		YBase        int
		YDisp        int
	}
	b := NewBuffer(defaultBufferOpts())
	got := Expectation{
		Cols:         b.Cols(),
		Rows:         b.Rows(),
		ScrollTop:    b.ScrollTop,
		ScrollBottom: b.ScrollBottom,
		X:            b.X,
		Y:            b.Y,
		YBase:        b.YBase,
		YDisp:        b.YDisp,
	}
	expected := Expectation{
		Cols:         80,
		Rows:         24,
		ScrollTop:    0,
		ScrollBottom: 23,
		X:            0,
		Y:            0,
		YBase:        0,
		YDisp:        0,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferFillViewportRows(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LineCount int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	got := Expectation{LineCount: b.Lines.Length()}
	expected := Expectation{LineCount: 24}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferFillViewportRowsIdempotent(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LineCount int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.FillViewportRows(nil) // second call should be no-op
	got := Expectation{LineCount: b.Lines.Length()}
	expected := Expectation{LineCount: 24}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferClear(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		X         int
		Y         int
		YBase     int
		YDisp     int
		LineCount int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.X = 5
	b.Y = 10
	b.YBase = 3
	b.Clear()
	got := Expectation{
		X:         b.X,
		Y:         b.Y,
		YBase:     b.YBase,
		YDisp:     b.YDisp,
		LineCount: b.Lines.Length(),
	}
	expected := Expectation{X: 0, Y: 0, YBase: 0, YDisp: 0, LineCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferTabStops(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		TabAt0  bool
		TabAt8  bool
		TabAt16 bool
		TabAt7  bool
	}
	b := NewBuffer(defaultBufferOpts())
	got := Expectation{
		TabAt0:  b.Tabs[0],
		TabAt8:  b.Tabs[8],
		TabAt16: b.Tabs[16],
		TabAt7:  b.Tabs[7],
	}
	expected := Expectation{
		TabAt0:  true,
		TabAt8:  true,
		TabAt16: true,
		TabAt7:  false,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferNextStop(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		NextFrom0 int
		NextFrom5 int
		NextFrom8 int
	}
	b := NewBuffer(defaultBufferOpts())
	got := Expectation{
		NextFrom0: b.NextStop(0),
		NextFrom5: b.NextStop(5),
		NextFrom8: b.NextStop(8),
	}
	expected := Expectation{
		NextFrom0: 8,
		NextFrom5: 8,
		NextFrom8: 16,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferPrevStop(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		PrevFrom9  int
		PrevFrom16 int
		PrevFrom0  int
	}
	b := NewBuffer(defaultBufferOpts())
	got := Expectation{
		PrevFrom9:  b.PrevStop(9),
		PrevFrom16: b.PrevStop(16),
		PrevFrom0:  b.PrevStop(0),
	}
	expected := Expectation{
		PrevFrom9:  8,
		PrevFrom16: 8,
		PrevFrom0:  0,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferHasScrollback(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		WithScrollback    bool
		WithoutScrollback bool
	}
	b1 := NewBuffer(defaultBufferOpts())
	b1.FillViewportRows(nil)
	opts2 := defaultBufferOpts()
	opts2.HasScrollback = false
	b2 := NewBuffer(opts2)
	b2.FillViewportRows(nil)
	got := Expectation{
		WithScrollback:    b1.HasScrollback(),
		WithoutScrollback: b2.HasScrollback(),
	}
	expected := Expectation{
		WithScrollback:    true,
		WithoutScrollback: false,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferIsCursorInViewport(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		InViewport    bool
		NotInViewport bool
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.Y = 5
	inVP := b.IsCursorInViewport()
	b.YBase = 100
	b.YDisp = 0
	notInVP := b.IsCursorInViewport()
	got := Expectation{InViewport: inVP, NotInViewport: notInVP}
	expected := Expectation{InViewport: true, NotInViewport: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferResizeGrowRows(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Rows         int
		ScrollBottom int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.Resize(80, 30)
	got := Expectation{
		Rows:         b.Rows(),
		ScrollBottom: b.ScrollBottom,
	}
	expected := Expectation{Rows: 30, ScrollBottom: 29}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferResizeShrinkRows(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Rows         int
		ScrollBottom int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.Resize(80, 10)
	got := Expectation{
		Rows:         b.Rows(),
		ScrollBottom: b.ScrollBottom,
	}
	expected := Expectation{Rows: 10, ScrollBottom: 9}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferResizeGrowRowsWindowsPtyKeepsYBase(t *testing.T) {
	t.Parallel()

	type TestCase struct {
		Name            string
		WindowsPtyMode  bool
		ExpectedYBase   int
		ExpectedYDisp   int
		ExpectedLineLen int
	}
	tests := []TestCase{
		{
			Name:            "default reclaims scrollback",
			WindowsPtyMode:  false,
			ExpectedYBase:   0,
			ExpectedYDisp:   0,
			ExpectedLineLen: 4,
		},
		{
			Name:            "windows pty appends blank rows",
			WindowsPtyMode:  true,
			ExpectedYBase:   2,
			ExpectedYDisp:   2,
			ExpectedLineLen: 6,
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			b := NewBuffer(BufferOptions{
				Cols:           5,
				Rows:           2,
				Scrollback:     10,
				TabStopWidth:   8,
				HasScrollback:  true,
				WindowsPtyMode: tc.WindowsPtyMode,
			})
			b.FillViewportRows(nil)
			b.Lines.Push(NewBufferLine(5, b.GetNullCell(nil), false))
			b.Lines.Push(NewBufferLine(5, b.GetNullCell(nil), false))
			b.YBase = 2
			b.YDisp = 2
			b.Y = 1

			b.Resize(5, 4)

			got := struct {
				YBase     int
				YDisp     int
				LineCount int
			}{
				YBase:     b.YBase,
				YDisp:     b.YDisp,
				LineCount: b.Lines.Length(),
			}
			expected := struct {
				YBase     int
				YDisp     int
				LineCount int
			}{
				YBase:     tc.ExpectedYBase,
				YDisp:     tc.ExpectedYDisp,
				LineCount: tc.ExpectedLineLen,
			}
			if diff := cmp.Diff(expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferResizeGrowCols(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Cols    int
		LineLen int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.Resize(120, 24)
	got := Expectation{
		Cols:    b.Cols(),
		LineLen: b.Lines.Get(0).Len,
	}
	expected := Expectation{Cols: 120, LineLen: 120}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferGetBlankLine(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Len       int
		IsWrapped bool
	}
	b := NewBuffer(defaultBufferOpts())
	da := DefaultAttrData()
	line := b.GetBlankLine(&da, true)
	got := Expectation{Len: line.Len, IsWrapped: line.IsWrapped}
	expected := Expectation{Len: 80, IsWrapped: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferTranslateBufferLineToString(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Result string
	}
	b := NewBuffer(BufferOptions{Cols: 10, Rows: 5, HasScrollback: false, TabStopWidth: 8})
	b.FillViewportRows(nil)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	line := b.Lines.Get(0)
	for i, ch := range []rune("HELLO") {
		line.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	got := Expectation{Result: b.TranslateBufferLineToString(0, true, 0, -1)}
	expected := Expectation{Result: "HELLO"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferTranslateBufferLineToStringOutOfRange(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Result string
	}
	b := NewBuffer(BufferOptions{Cols: 10, Rows: 5, HasScrollback: false, TabStopWidth: 8})
	b.FillViewportRows(nil)
	got := Expectation{Result: b.TranslateBufferLineToString(100, false, 0, -1)}
	expected := Expectation{Result: ""}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferGetWrappedRangeForLine(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		First int
		Last  int
	}
	b := NewBuffer(BufferOptions{Cols: 10, Rows: 10, HasScrollback: false, TabStopWidth: 8})
	b.FillViewportRows(nil)
	// Mark lines 2 and 3 as wrapped continuations of line 1
	b.Lines.Get(2).IsWrapped = true
	b.Lines.Get(3).IsWrapped = true
	first, last := b.GetWrappedRangeForLine(2)
	got := Expectation{First: first, Last: last}
	expected := Expectation{First: 1, Last: 3}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferAddMarker(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MarkerCount int
		MarkerLine  int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	m := b.AddMarker(5)
	got := Expectation{MarkerCount: len(b.Markers), MarkerLine: m.Line}
	expected := Expectation{MarkerCount: 1, MarkerLine: 5}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferMarkerAdjustOnTrim(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Line int
	}
	b := NewBuffer(BufferOptions{Cols: 10, Rows: 5, Scrollback: 5, HasScrollback: true, TabStopWidth: 8})
	b.FillViewportRows(nil)
	m := b.AddMarker(3)
	// Trim 2 lines from start
	b.Lines.TrimStart(2)
	got := Expectation{Line: m.Line}
	expected := Expectation{Line: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferMarkerDisposedOnTrimPastZero(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		IsDisposed bool
	}
	b := NewBuffer(BufferOptions{Cols: 10, Rows: 5, Scrollback: 5, HasScrollback: true, TabStopWidth: 8})
	b.FillViewportRows(nil)
	m := b.AddMarker(1)
	b.Lines.TrimStart(3)
	got := Expectation{IsDisposed: m.IsDisposed}
	expected := Expectation{IsDisposed: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferClearMarkers(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MarkerCount int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.AddMarker(5)
	b.AddMarker(5)
	b.AddMarker(10)
	b.ClearMarkers(5)
	got := Expectation{MarkerCount: len(b.Markers)}
	expected := Expectation{MarkerCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferClearAllMarkers(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MarkerCount int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.AddMarker(1)
	b.AddMarker(2)
	b.AddMarker(3)
	b.ClearAllMarkers()
	got := Expectation{MarkerCount: len(b.Markers)}
	expected := Expectation{MarkerCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferDispose(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MarkerCount    int
		MarkerDisposed bool
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	m := b.AddMarker(3)
	b.Dispose()
	got := Expectation{MarkerCount: len(b.Markers), MarkerDisposed: m.IsDisposed}
	expected := Expectation{MarkerCount: 0, MarkerDisposed: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferGetNullCell(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		FgDefault uint32
		FgCustom  uint32
	}
	b := NewBuffer(defaultBufferOpts())
	c1 := b.GetNullCell(nil)
	fg1 := c1.Fg
	attrs := &AttributeData{Fg: 42, Bg: 0, Extended: &ExtendedAttrs{}}
	c2 := b.GetNullCell(attrs)
	fg2 := c2.Fg
	got := Expectation{FgDefault: fg1, FgCustom: fg2}
	expected := Expectation{FgDefault: 0, FgCustom: 42}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferNoScrollback(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MaxLength int
	}
	b := NewBuffer(BufferOptions{Cols: 10, Rows: 5, HasScrollback: false, TabStopWidth: 8})
	got := Expectation{MaxLength: b.Lines.MaxLength()}
	expected := Expectation{MaxLength: 5}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferResizeClampsCursor(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		X int
		Y int
	}
	b := NewBuffer(defaultBufferOpts())
	b.FillViewportRows(nil)
	b.X = 79
	b.Y = 23
	b.Resize(40, 10)
	got := Expectation{X: b.X, Y: b.Y}
	expected := Expectation{X: 39, Y: 9}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
