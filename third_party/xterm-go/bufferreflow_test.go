package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

// helper: create a CircularList of BufferLines from strings, marking continuations as wrapped.
func makeLines(cols int, contents []string, wrappedIndices map[int]bool) *CircularList[*BufferLine] {
	cl := NewCircularList[*BufferLine](len(contents) + 10)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	for idx, s := range contents {
		bl := NewBufferLine(cols, nil, wrappedIndices[idx])
		for i, ch := range s {
			if i < cols {
				bl.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
			}
		}
		cl.Push(bl)
	}
	return cl
}

func TestGetWrappedLineTrimmedLength(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Length int
	}
	tests := []struct {
		Name     string
		Lines    []string
		Index    int
		Cols     int
		Expected Expectation
	}{
		{
			Name:     "last line trimmed",
			Lines:    []string{"ABCDE", "FG"},
			Index:    1,
			Cols:     5,
			Expected: Expectation{Length: 2},
		},
		{
			Name:     "non-last line full",
			Lines:    []string{"ABCDE", "FG"},
			Index:    0,
			Cols:     5,
			Expected: Expectation{Length: 5},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			lines := make([]*BufferLine, len(tc.Lines))
			attrs := &AttributeData{Extended: &ExtendedAttrs{}}
			for i, s := range tc.Lines {
				bl := NewBufferLine(tc.Cols, nil, i > 0)
				for j, ch := range s {
					if j < tc.Cols {
						bl.SetCellFromCodepoint(j, uint32(ch), 1, attrs)
					}
				}
				lines[i] = bl
			}
			got := Expectation{Length: getWrappedLineTrimmedLength(lines, tc.Index, tc.Cols)}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestReflowSmallerGetNewLineLengths(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Lengths []int
	}
	tests := []struct {
		Name     string
		Content  []string
		OldCols  int
		NewCols  int
		Expected Expectation
	}{
		{
			Name:     "simple split",
			Content:  []string{"ABCDEFGH"},
			OldCols:  10,
			NewCols:  5,
			Expected: Expectation{Lengths: []int{5, 3}},
		},
		{
			Name:     "exact fit",
			Content:  []string{"ABCDE"},
			OldCols:  10,
			NewCols:  5,
			Expected: Expectation{Lengths: []int{5}},
		},
		{
			Name:     "three lines",
			Content:  []string{"ABCDEFGHIJKLM"},
			OldCols:  15,
			NewCols:  5,
			Expected: Expectation{Lengths: []int{5, 5, 3}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			attrs := &AttributeData{Extended: &ExtendedAttrs{}}
			lines := make([]*BufferLine, len(tc.Content))
			for i, s := range tc.Content {
				bl := NewBufferLine(tc.OldCols, nil, i > 0)
				for j, ch := range s {
					if j < tc.OldCols {
						bl.SetCellFromCodepoint(j, uint32(ch), 1, attrs)
					}
				}
				lines[i] = bl
			}
			result := reflowSmallerGetNewLineLengths(lines, tc.OldCols, tc.NewCols)
			got := Expectation{Lengths: result}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestReflowLargerGetLinesToRemove(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ToRemoveLen int
	}
	tests := []struct {
		Name     string
		Contents []string
		Wrapped  map[int]bool
		OldCols  int
		NewCols  int
		Expected Expectation
	}{
		{
			Name:     "no wrapped lines",
			Contents: []string{"ABC", "DEF", "GHI"},
			Wrapped:  map[int]bool{},
			OldCols:  5,
			NewCols:  10,
			Expected: Expectation{ToRemoveLen: 0},
		},
		{
			Name:     "wrapped line can merge",
			Contents: []string{"ABCDE", "FG", "XYZ"},
			Wrapped:  map[int]bool{1: true},
			OldCols:  5,
			NewCols:  10,
			Expected: Expectation{ToRemoveLen: 2}, // [startIdx, count] pair
		},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			// Lines must be pre-resized to newCols (as Buffer.Resize does before calling reflow)
			cl := makeLines(tc.NewCols, tc.Contents, tc.Wrapped)
			nc := nullCell()
			// Place cursor on last line so it doesn't interfere with reflow
			result := reflowLargerGetLinesToRemove(cl, tc.OldCols, tc.NewCols, cl.Length()-1, nc, false)
			got := Expectation{ToRemoveLen: len(result)}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestReflowLargerCreateNewLayout(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LayoutLen    int
		CountRemoved int
	}
	cl := makeLines(5, []string{"ABCDE", "FG", "HIJKL"}, map[int]bool{1: true})
	// toRemove: [startIndex=0, count=1] means remove 1 line starting at index 0
	toRemove := []int{1, 1}
	result := reflowLargerCreateNewLayout(cl, toRemove)
	got := Expectation{
		LayoutLen:    len(result.layout),
		CountRemoved: result.countRemoved,
	}
	expected := Expectation{LayoutLen: 2, CountRemoved: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestReflowLargerApplyNewLayout(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Length int
	}
	cl := makeLines(5, []string{"ABCDE", "FG", "HIJKL"}, map[int]bool{1: true})
	layout := []int{0, 2} // keep lines 0 and 2, remove line 1
	reflowLargerApplyNewLayout(cl, layout)
	got := Expectation{Length: cl.Length()}
	expected := Expectation{Length: 2}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestReflowIntegrationLarger(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		LineCount int
		Line0     string
	}
	// Create a buffer with wrapped content, then resize larger
	b := NewBuffer(BufferOptions{
		Cols:          5,
		Rows:          5,
		Scrollback:    100,
		TabStopWidth:  8,
		HasScrollback: true,
	})
	b.FillViewportRows(nil)
	// Write "ABCDEFGH" across two lines (wrapped)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	line0 := b.Lines.Get(0)
	for i, ch := range []rune("ABCDE") {
		line0.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	line1 := b.Lines.Get(1)
	line1.IsWrapped = true
	for i, ch := range []rune("FGH") {
		line1.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	// Move cursor below the wrapped group so reflow can process it
	b.Y = 4
	b.Resize(10, 5)
	got := Expectation{
		LineCount: b.Lines.Length(),
		Line0:     b.Lines.Get(0).TranslateToString(true, 0, -1),
	}
	expected := Expectation{
		LineCount: 5,
		Line0:     "ABCDEFGH",
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestReflowIntegrationSmaller(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Line0Content string
		Line1Wrapped bool
	}
	b := NewBuffer(BufferOptions{
		Cols:          10,
		Rows:          5,
		Scrollback:    100,
		TabStopWidth:  8,
		HasScrollback: true,
	})
	b.FillViewportRows(nil)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	line0 := b.Lines.Get(0)
	for i, ch := range []rune("ABCDEFGH") {
		line0.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	// Move cursor below the content line so reflow can process it
	b.Y = 4
	b.Resize(5, 5)
	got := Expectation{
		Line0Content: b.Lines.Get(0).TranslateToString(true, 0, -1),
		Line1Wrapped: b.Lines.Get(1).IsWrapped,
	}
	expected := Expectation{
		Line0Content: "ABCDE",
		Line1Wrapped: true,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
