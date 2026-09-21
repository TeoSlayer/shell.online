package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func nullCell() *CellData {
	return CellDataFromCharData(NewCharData(0, NullCellChar, NullCellWidth, NullCellCode))
}

func charCell(ch rune, width int) *CellData {
	return CellDataFromCharData(NewCharData(0, string(ch), width, uint32(ch)))
}

func TestBufferLineNewAndLength(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Len       int
		IsWrapped bool
	}
	tests := []struct {
		Name      string
		Cols      int
		IsWrapped bool
		Expected  Expectation
	}{
		{"10 cols not wrapped", 10, false, Expectation{10, false}},
		{"5 cols wrapped", 5, true, Expectation{5, true}},
		{"0 cols", 0, false, Expectation{0, false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			bl := NewBufferLine(tc.Cols, nil, tc.IsWrapped)
			got := Expectation{bl.Len, bl.IsWrapped}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferLineSetCellFromCodepoint(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Char  string
		Width int
		Fg    uint32
		Bg    uint32
	}
	tests := []struct {
		Name      string
		CodePoint uint32
		Width     int
		Fg        uint32
		Bg        uint32
		Expected  Expectation
	}{
		{"ASCII char", 'A', 1, 0, 0, Expectation{"A", 1, 0, 0}},
		{"wide char", 0x4E16, 2, 1, 2, Expectation{"世", 2, 1, 2}}, //nolint:gosmopolitan
		{"null codepoint", 0, 1, 0, 0, Expectation{"", 1, 0, 0}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			bl := NewBufferLine(5, nil, false)
			attrs := &AttributeData{Fg: tc.Fg, Bg: tc.Bg, Extended: &ExtendedAttrs{}}
			bl.SetCellFromCodepoint(0, tc.CodePoint, tc.Width, attrs)
			got := Expectation{
				Char:  bl.GetString(0),
				Width: bl.GetWidth(0),
				Fg:    bl.GetFg(0),
				Bg:    bl.GetBg(0),
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferLineSetCellFromCodepointClearsSparseCaches(t *testing.T) {
	t.Parallel()
	bl := NewBufferLine(2, nil, false)
	bl.Set(0, NewCharData(0, "e\u0301", 1, 0x0301))

	attrs := DefaultAttrData()
	attrs.Extended = NewExtendedAttrs(0, 42)
	attrs.UpdateExtended()
	bl.SetCellFromCodepoint(1, 'B', 1, &attrs)

	plainAttrs := DefaultAttrData()
	bl.SetCellFromCodepoint(0, 'A', 1, &plainAttrs)
	bl.SetCellFromCodepoint(1, 'C', 1, &plainAttrs)

	if got := len(bl.combined); got != 0 {
		t.Fatalf("combined cache length = %d, want 0", got)
	}
	if got := len(bl.extendedAttrs); got != 0 {
		t.Fatalf("extendedAttrs cache length = %d, want 0", got)
	}
}

func TestBufferLineSetCellClearsSparseCaches(t *testing.T) {
	t.Parallel()
	bl := NewBufferLine(2, nil, false)

	attr := DefaultAttrData()
	attr.Extended = NewExtendedAttrs(0, 42)
	attr.UpdateExtended()
	combined := CellDataFromCharData(NewCharData(0, "e\u0301", 1, 0x0301))
	combined.AttributeData = attr
	bl.SetCell(0, combined)

	plain := CellDataFromCharData(NewCharData(0, "B", 1, 'B'))
	bl.SetCell(0, plain)

	if got := len(bl.combined); got != 0 {
		t.Fatalf("combined cache length = %d, want 0", got)
	}
	if got := len(bl.extendedAttrs); got != 0 {
		t.Fatalf("extendedAttrs cache length = %d, want 0", got)
	}
}

func TestBufferLineAddCodepointToCell(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Char       string
		IsCombined bool
	}
	tests := []struct {
		Name     string
		Base     rune
		Combine  rune
		Expected Expectation
	}{
		{"combining accent", 'e', 0x0301, Expectation{"e\u0301", true}},
		{"add to empty cell", 0, 'A', Expectation{"A", false}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			bl := NewBufferLine(5, nil, false)
			if tc.Base != 0 {
				attrs := &AttributeData{Extended: &ExtendedAttrs{}}
				bl.SetCellFromCodepoint(0, uint32(tc.Base), 1, attrs)
			}
			bl.AddCodepointToCell(0, uint32(tc.Combine), 0)
			got := Expectation{
				Char:       bl.GetString(0),
				IsCombined: bl.IsCombined(0) != 0,
			}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferLineAddMultipleCombining(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Char string
	}
	bl := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	bl.SetCellFromCodepoint(0, 'e', 1, attrs)
	bl.AddCodepointToCell(0, 0x0301, 0) // combining acute
	bl.AddCodepointToCell(0, 0x0327, 0) // combining cedilla
	got := Expectation{Char: bl.GetString(0)}
	expected := Expectation{Char: "e\u0301\u0327"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineLoadCell(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Content uint32
		Fg      uint32
		Bg      uint32
	}
	bl := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Fg: 100, Bg: 200, Extended: &ExtendedAttrs{}}
	bl.SetCellFromCodepoint(2, 'X', 1, attrs)
	cell := NewCellData()
	bl.LoadCell(2, cell)
	got := Expectation{Content: cell.Content, Fg: cell.Fg, Bg: cell.Bg}
	expected := Expectation{
		Content: uint32('X') | (1 << ContentWidthShift),
		Fg:      100,
		Bg:      200,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineGetExtended(t *testing.T) {
	t.Parallel()
	bl := NewBufferLine(2, nil, false)

	attrs := DefaultAttrData()
	attrs.Extended = NewExtendedAttrs(0, 42)
	attrs.UpdateExtended()
	bl.SetCellFromCodepoint(0, 'A', 1, &attrs)

	if got := bl.GetExtended(0); got != attrs.Extended {
		t.Fatalf("GetExtended returned %p, want stored attributes %p", got, attrs.Extended)
	}

	got := bl.GetExtended(1)
	if got == nil || !got.IsEmpty() {
		t.Fatalf("GetExtended returned %#v for a cell without extended attributes, want empty attributes", got)
	}
}

func TestBufferLineLoadCellClearsSparseFields(t *testing.T) {
	t.Parallel()
	bl := NewBufferLine(2, nil, false)

	attrs := DefaultAttrData()
	attrs.Extended = NewExtendedAttrs(0, 99)
	attrs.UpdateExtended()

	combined := CellDataFromCharData(NewCharData(0, "a\u0301", 1, 0))
	combined.AttributeData = attrs
	bl.SetCell(0, combined)

	plainAttrs := DefaultAttrData()
	bl.SetCellFromCodepoint(1, 'Z', 1, &plainAttrs)

	cell := NewCellData()
	bl.LoadCell(0, cell)
	bl.LoadCell(1, cell)

	if cell.CombinedData != "" {
		t.Fatalf("LoadCell left stale CombinedData = %q, want empty string", cell.CombinedData)
	}
	if cell.Extended == nil || !cell.Extended.IsEmpty() {
		t.Fatalf("LoadCell left stale Extended attrs, want empty attrs")
	}
}

func TestBufferLineInsertCells(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars string
	}
	bl := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	for i, ch := range []rune{'A', 'B', 'C', 'D', 'E'} {
		bl.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	fill := nullCell()
	bl.InsertCells(1, 2, fill)
	result := bl.TranslateToString(true, 0, -1)
	got := Expectation{Chars: result}
	expected := Expectation{Chars: "A  BC"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineDeleteCells(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars string
	}
	bl := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	for i, ch := range []rune{'A', 'B', 'C', 'D', 'E'} {
		bl.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	fill := nullCell()
	bl.DeleteCells(1, 2, fill)
	result := bl.TranslateToString(false, 0, -1)
	got := Expectation{Chars: result}
	expected := Expectation{Chars: "ADE  "}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineReplaceCells(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars string
	}
	bl := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	for i, ch := range []rune{'A', 'B', 'C', 'D', 'E'} {
		bl.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	fill := charCell(' ', 1)
	bl.ReplaceCells(1, 4, fill, false)
	result := bl.TranslateToString(false, 0, -1)
	got := Expectation{Chars: result}
	expected := Expectation{Chars: "A   E"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineResize(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Len   int
		Chars string
	}
	tests := []struct {
		Name     string
		InitCols int
		NewCols  int
		Expected Expectation
	}{
		{"grow", 3, 5, Expectation{5, "ABC  "}},
		{"shrink", 5, 3, Expectation{3, "ABC"}},
		{"same", 5, 5, Expectation{5, "ABCDE"}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			bl := NewBufferLine(tc.InitCols, nil, false)
			attrs := &AttributeData{Extended: &ExtendedAttrs{}}
			chars := []rune("ABCDE")
			for i := 0; i < tc.InitCols && i < len(chars); i++ {
				bl.SetCellFromCodepoint(i, uint32(chars[i]), 1, attrs)
			}
			fill := charCell(' ', 1)
			bl.Resize(tc.NewCols, fill)
			result := bl.TranslateToString(false, 0, -1)
			got := Expectation{Len: bl.Len, Chars: result}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferLineFill(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars string
	}
	bl := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	for i, ch := range []rune{'A', 'B', 'C', 'D', 'E'} {
		bl.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	fill := charCell('X', 1)
	bl.Fill(fill, false)
	result := bl.TranslateToString(false, 0, -1)
	got := Expectation{Chars: result}
	expected := Expectation{Chars: "XXXXX"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineCopyFrom(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars     string
		IsWrapped bool
	}
	src := NewBufferLine(5, nil, true)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	for i, ch := range []rune{'H', 'E', 'L', 'L', 'O'} {
		src.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	dst := NewBufferLine(5, nil, false)
	dst.CopyFrom(src)
	got := Expectation{
		Chars:     dst.TranslateToString(false, 0, -1),
		IsWrapped: dst.IsWrapped,
	}
	expected := Expectation{Chars: "HELLO", IsWrapped: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineCopyFromRebuildsSparseCachesFromFlags(t *testing.T) {
	t.Parallel()
	src := NewBufferLine(2, nil, true)
	src.Set(0, NewCharData(0, "e\u0301", 1, 0x0301))
	src.combined[1] = "stale"

	attr := DefaultAttrData()
	attr.Extended = NewExtendedAttrs(0, 7)
	attr.UpdateExtended()
	src.SetCellFromCodepoint(1, 'B', 1, &attr)
	src.extendedAttrs[0] = NewExtendedAttrs(0, 99)

	dst := NewBufferLine(2, nil, false)
	dst.CopyFrom(src)

	if got := len(dst.combined); got != 1 {
		t.Fatalf("combined cache length = %d, want 1", got)
	}
	if got := dst.combined[0]; got != "e\u0301" {
		t.Fatalf("combined[0] = %q, want e+accent", got)
	}
	if _, ok := dst.combined[1]; ok {
		t.Fatalf("combined[1] copied stale entry")
	}
	if got := len(dst.extendedAttrs); got != 1 {
		t.Fatalf("extendedAttrs cache length = %d, want 1", got)
	}
	if _, ok := dst.extendedAttrs[0]; ok {
		t.Fatalf("extendedAttrs[0] copied stale entry")
	}
	if dst.extendedAttrs[1] == nil || dst.extendedAttrs[1].URLID() != 7 {
		t.Fatalf("extendedAttrs[1] did not copy flagged extended attrs")
	}
}

func TestBufferLineClone(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars       string
		IsWrapped   bool
		Independent bool
	}
	orig := NewBufferLine(3, nil, true)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	orig.SetCellFromCodepoint(0, 'A', 1, attrs)
	orig.SetCellFromCodepoint(1, 'B', 1, attrs)
	orig.SetCellFromCodepoint(2, 'C', 1, attrs)
	clone := orig.Clone()
	// Modify original to verify independence
	orig.SetCellFromCodepoint(0, 'Z', 1, attrs)
	got := Expectation{
		Chars:       clone.TranslateToString(false, 0, -1),
		IsWrapped:   clone.IsWrapped,
		Independent: clone.GetString(0) != orig.GetString(0),
	}
	expected := Expectation{Chars: "ABC", IsWrapped: true, Independent: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineCloneRebuildsSparseCachesFromFlags(t *testing.T) {
	t.Parallel()
	orig := NewBufferLine(2, nil, true)
	orig.Set(0, NewCharData(0, "e\u0301", 1, 0x0301))
	orig.combined[1] = "stale"

	attr := DefaultAttrData()
	attr.Extended = NewExtendedAttrs(0, 7)
	attr.UpdateExtended()
	orig.SetCellFromCodepoint(1, 'B', 1, &attr)
	orig.extendedAttrs[0] = NewExtendedAttrs(0, 99)

	clone := orig.Clone()

	if got := len(clone.combined); got != 1 {
		t.Fatalf("combined cache length = %d, want 1", got)
	}
	if got := clone.combined[0]; got != "e\u0301" {
		t.Fatalf("combined[0] = %q, want e+accent", got)
	}
	if _, ok := clone.combined[1]; ok {
		t.Fatalf("combined[1] copied stale entry")
	}
	if got := len(clone.extendedAttrs); got != 1 {
		t.Fatalf("extendedAttrs cache length = %d, want 1", got)
	}
	if _, ok := clone.extendedAttrs[0]; ok {
		t.Fatalf("extendedAttrs[0] copied stale entry")
	}
	if clone.extendedAttrs[1] == nil || clone.extendedAttrs[1].URLID() != 7 {
		t.Fatalf("extendedAttrs[1] did not copy flagged extended attrs")
	}
}

func TestBufferLineGetTrimmedLength(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		TrimmedLen int
	}
	tests := []struct {
		Name     string
		Content  string
		Expected Expectation
	}{
		{"full line", "ABCDE", Expectation{5}},
		{"trailing empty", "AB", Expectation{2}},
		{"all empty", "", Expectation{0}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			bl := NewBufferLine(5, nil, false)
			attrs := &AttributeData{Extended: &ExtendedAttrs{}}
			for i, ch := range tc.Content {
				bl.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
			}
			got := Expectation{TrimmedLen: bl.GetTrimmedLength()}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferLineTranslateToString(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Result string
	}
	tests := []struct {
		Name      string
		Content   string
		TrimRight bool
		StartCol  int
		EndCol    int
		Expected  Expectation
	}{
		{"full line", "HELLO", false, 0, -1, Expectation{"HELLO"}},
		{"substring", "HELLO", false, 1, 4, Expectation{"ELL"}},
		{"trim right", "HI", true, 0, -1, Expectation{"HI"}},
	}
	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()
			bl := NewBufferLine(5, nil, false)
			attrs := &AttributeData{Extended: &ExtendedAttrs{}}
			for i, ch := range tc.Content {
				bl.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
			}
			result := bl.TranslateToString(tc.TrimRight, tc.StartCol, tc.EndCol)
			got := Expectation{Result: result}
			if diff := cmp.Diff(tc.Expected, got); diff != "" {
				t.Errorf("(-want +got):\n%s", diff)
			}
		})
	}
}

func TestBufferLineGetSet(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Char  string
		Width int
		Code  uint32
	}
	bl := NewBufferLine(5, nil, false)
	cd := NewCharData(42, "A", 1, 65)
	bl.Set(0, cd)
	result := bl.Get(0)
	got := Expectation{
		Char:  CharDataChar(result),
		Width: CharDataWidth(result),
		Code:  CharDataCode(result),
	}
	expected := Expectation{Char: "A", Width: 1, Code: 65}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineCopyCellsFrom(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Chars string
	}
	src := NewBufferLine(5, nil, false)
	dst := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	for i, ch := range []rune{'A', 'B', 'C', 'D', 'E'} {
		src.SetCellFromCodepoint(i, uint32(ch), 1, attrs)
	}
	dst.CopyCellsFrom(src, 1, 2, 2, false)
	got := Expectation{Chars: dst.GetString(2) + dst.GetString(3)}
	expected := Expectation{Chars: "BC"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferLineCopyCellsFromDoesNotCopyCombinedOutsideRange(t *testing.T) {
	t.Parallel()
	src := NewBufferLine(5, nil, false)
	dst := NewBufferLine(5, nil, false)

	src.SetCell(4, CellDataFromCharData(NewCharData(0, "SRC", 1, 0)))
	dst.SetCell(3, CellDataFromCharData(NewCharData(0, "OLD", 1, 0)))

	dst.CopyCellsFrom(src, 1, 0, 2, false)

	if got := dst.GetString(3); got != "OLD" {
		t.Fatalf("CopyCellsFrom changed untouched combined cell 3 to %q, want OLD", got)
	}
}

func TestBufferLineCopyCellsFromClearsDestinationSparseCaches(t *testing.T) {
	t.Parallel()
	src := NewBufferLine(2, nil, false)
	src.Set(0, NewCharData(0, "A", 1, 'A'))

	dst := NewBufferLine(2, nil, false)
	dst.Set(0, NewCharData(0, "e\u0301", 1, 0x0301))
	attr := DefaultAttrData()
	attr.Extended = NewExtendedAttrs(0, 7)
	attr.UpdateExtended()
	dst.SetCellFromCodepoint(1, 'B', 1, &attr)

	dst.CopyCellsFrom(src, 0, 0, 2, false)

	if got := len(dst.combined); got != 0 {
		t.Fatalf("combined cache length = %d, want 0", got)
	}
	if got := len(dst.extendedAttrs); got != 0 {
		t.Fatalf("extendedAttrs cache length = %d, want 0", got)
	}
}

func TestBufferLineWideCharTrimmedLength(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		TrimmedLen int
	}
	bl := NewBufferLine(5, nil, false)
	attrs := &AttributeData{Extended: &ExtendedAttrs{}}
	bl.SetCellFromCodepoint(0, 0x4E16, 2, attrs) // '世' width=2
	bl.SetCellFromCodepoint(1, 0, 0, attrs)      // second cell of wide char
	got := Expectation{TrimmedLen: bl.GetTrimmedLength()}
	expected := Expectation{TrimmedLen: 2}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
