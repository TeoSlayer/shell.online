package xterm

// Ported from xterm.js src/common/buffer/Buffer.ts.

// MaxBufferSize must fit in int on 32-bit as well as 64-bit release targets.
// Reserve one value so callers/tests can also safely express limit + 1.
const MaxBufferSize = int(min(uint64(4294967295), uint64(^uint(0)>>1)-1))

// BufferOptions configures a Buffer. In xterm.js these come from OptionsService/BufferService;
// here they are passed directly to avoid DI.
type BufferOptions struct {
	Cols           int
	Rows           int
	Scrollback     int
	TabStopWidth   int
	HasScrollback  bool
	WindowsPtyMode bool // simplified: true if windowsPty backend is set
}

// SavedCursorState holds cursor state saved by DECSC.
type SavedCursorState struct {
	X              int
	Y              int
	CurAttrData    AttributeData
	Charset        Charset
	Charsets       []Charset
	GLevel         int
	OriginMode     bool
	WraparoundMode bool
}

// Buffer represents a terminal buffer (normal or alt).
type Buffer struct {
	Lines *CircularList[*BufferLine]

	YDisp int // viewport scroll position
	YBase int // scroll offset (lines above viewport)
	Y     int // cursor row (relative to viewport)
	X     int // cursor column

	ScrollTop    int
	ScrollBottom int

	Tabs map[int]bool

	SavedState SavedCursorState

	Markers []*Marker

	cols          int
	rows          int
	hasScrollback bool
	scrollback    int
	tabStopWidth  int
	windowsPty    bool
	isClearing    bool

	nullCell       *CellData
	whitespaceCell *CellData
}

// NewBuffer creates a new Buffer with the given options.
func NewBuffer(opts BufferOptions) *Buffer {
	b := &Buffer{
		cols:           opts.Cols,
		rows:           opts.Rows,
		hasScrollback:  opts.HasScrollback,
		scrollback:     opts.Scrollback,
		tabStopWidth:   opts.TabStopWidth,
		windowsPty:     opts.WindowsPtyMode,
		Tabs:           make(map[int]bool),
		nullCell:       CellDataFromCharData(NewCharData(0, NullCellChar, NullCellWidth, NullCellCode)),
		whitespaceCell: CellDataFromCharData(NewCharData(0, WhitespaceCellChar, WhitespaceCellWidth, WhitespaceCellCode)),
	}
	if b.tabStopWidth == 0 {
		b.tabStopWidth = 8
	}
	b.Lines = NewCircularList[*BufferLine](b.getCorrectBufferLength(b.rows))
	b.ScrollTop = 0
	b.ScrollBottom = b.rows - 1
	b.SetupTabStops(-1)
	b.SavedState = SavedCursorState{
		CurAttrData:    DefaultAttrData(),
		WraparoundMode: true,
	}
	return b
}

func (b *Buffer) setWindowsPtyMode(windowsPty bool) {
	b.windowsPty = windowsPty
}

// GetNullCell returns a null cell, optionally with the given attributes.
func (b *Buffer) GetNullCell(attr *AttributeData) *CellData {
	if attr != nil {
		b.nullCell.Fg = attr.Fg
		b.nullCell.Bg = attr.Bg
		b.nullCell.Extended = attr.Extended
	} else {
		b.nullCell.Fg = 0
		b.nullCell.Bg = 0
		b.nullCell.Extended = &ExtendedAttrs{}
	}
	return b.nullCell
}

// GetWhitespaceCell returns a whitespace cell, optionally with the given attributes.
func (b *Buffer) GetWhitespaceCell(attr *AttributeData) *CellData {
	if attr != nil {
		b.whitespaceCell.Fg = attr.Fg
		b.whitespaceCell.Bg = attr.Bg
		b.whitespaceCell.Extended = attr.Extended
	} else {
		b.whitespaceCell.Fg = 0
		b.whitespaceCell.Bg = 0
		b.whitespaceCell.Extended = &ExtendedAttrs{}
	}
	return b.whitespaceCell
}

// GetBlankLine creates a new blank BufferLine with the given attributes.
func (b *Buffer) GetBlankLine(attr *AttributeData, isWrapped bool) *BufferLine {
	return NewBufferLine(b.cols, b.GetNullCell(attr), isWrapped)
}

// HasScrollback returns true if the buffer has scrollback enabled and capacity.
func (b *Buffer) HasScrollback() bool {
	return b.hasScrollback && b.Lines.MaxLength() > b.rows
}

// IsCursorInViewport returns true if the cursor is within the visible viewport.
func (b *Buffer) IsCursorInViewport() bool {
	absY := b.YBase + b.Y
	relY := absY - b.YDisp
	return relY >= 0 && relY < b.rows
}

func (b *Buffer) getCorrectBufferLength(rows int) int {
	if !b.hasScrollback {
		return rows
	}
	n := rows + b.scrollback
	if n > MaxBufferSize {
		return MaxBufferSize
	}
	return n
}

// FillViewportRows fills the buffer with blank lines up to the viewport size.
func (b *Buffer) FillViewportRows(fillAttr *AttributeData) {
	if b.Lines.Length() != 0 {
		return
	}
	if fillAttr == nil {
		da := DefaultAttrData()
		fillAttr = &da
	}
	for i := b.rows; i > 0; i-- {
		b.Lines.Push(b.GetBlankLine(fillAttr, false))
	}
}

// Clear resets the buffer to its initial state.
func (b *Buffer) Clear() {
	b.YDisp = 0
	b.YBase = 0
	b.Y = 0
	b.X = 0
	b.Lines = NewCircularList[*BufferLine](b.getCorrectBufferLength(b.rows))
	b.ScrollTop = 0
	b.ScrollBottom = b.rows - 1
	b.SetupTabStops(-1)
}

// Resize adjusts the buffer dimensions. Handles row/column changes and reflow.
func (b *Buffer) Resize(newCols, newRows int) {
	da := DefaultAttrData()
	nullCell := b.GetNullCell(&da)

	newMaxLength := b.getCorrectBufferLength(newRows)
	if newMaxLength > b.Lines.MaxLength() {
		b.Lines.SetMaxLength(newMaxLength)
	}

	if b.Lines.Length() > 0 {
		// Grow columns first (shrink happens after reflow)
		if b.cols < newCols {
			for i := range b.Lines.Length() {
				b.Lines.Get(i).Resize(newCols, nullCell)
			}
		}

		// Resize rows
		addToY := 0
		if b.rows < newRows {
			for y := b.rows; y < newRows; y++ {
				if b.Lines.Length() < newRows+b.YBase {
					if b.windowsPty {
						b.Lines.Push(NewBufferLine(newCols, nullCell, false))
					} else {
						if b.YBase > 0 && b.Lines.Length() <= b.YBase+b.Y+addToY+1 {
							b.YBase--
							addToY++
							if b.YDisp > 0 {
								b.YDisp--
							}
						} else {
							b.Lines.Push(NewBufferLine(newCols, nullCell, false))
						}
					}
				}
			}
		} else {
			for y := b.rows; y > newRows; y-- {
				if b.Lines.Length() > newRows+b.YBase {
					if b.Lines.Length() > b.YBase+b.Y+1 {
						b.Lines.Pop()
					} else {
						b.YBase++
						b.YDisp++
					}
				}
			}
		}

		// Reduce max length after adjustments
		if newMaxLength < b.Lines.MaxLength() {
			amountToTrim := b.Lines.Length() - newMaxLength
			if amountToTrim > 0 {
				b.Lines.TrimStart(amountToTrim)
				b.YBase = max(b.YBase-amountToTrim, 0)
				b.YDisp = max(b.YDisp-amountToTrim, 0)
				b.SavedState.Y = max(b.SavedState.Y-amountToTrim, 0)
			}
			b.Lines.SetMaxLength(newMaxLength)
		}

		// Clamp cursor
		b.X = min(b.X, newCols-1)
		b.Y = min(b.Y, newRows-1)
		if addToY > 0 {
			b.Y += addToY
		}
		b.SavedState.X = min(b.SavedState.X, newCols-1)

		b.ScrollTop = 0
	}

	b.ScrollBottom = newRows - 1

	// Reflow if enabled
	if b.isReflowEnabled() {
		b.reflow(newCols, newRows)

		// Shrink columns after reflow
		if b.cols > newCols {
			for i := range b.Lines.Length() {
				b.Lines.Get(i).Resize(newCols, nullCell)
			}
		}
	}

	b.cols = newCols
	b.rows = newRows

	// Ensure cursor position invariant
	if b.Lines.Length() > 0 {
		maxY := max(0, b.Lines.Length()-b.YBase-1)
		b.Y = min(b.Y, maxY)
	}
}

func (b *Buffer) isReflowEnabled() bool {
	return b.hasScrollback
}

func (b *Buffer) reflow(newCols, newRows int) {
	if b.cols == newCols {
		return
	}
	if newCols > b.cols {
		b.reflowLarger(newCols, newRows)
	} else {
		b.reflowSmaller(newCols, newRows)
	}
}

func (b *Buffer) reflowLarger(newCols, newRows int) {
	da := DefaultAttrData()
	toRemove := reflowLargerGetLinesToRemove(b.Lines, b.cols, newCols, b.YBase+b.Y, b.GetNullCell(&da), false)
	if len(toRemove) > 0 {
		newLayoutResult := reflowLargerCreateNewLayout(b.Lines, toRemove)
		reflowLargerApplyNewLayout(b.Lines, newLayoutResult.layout)
		b.reflowLargerAdjustViewport(newCols, newRows, newLayoutResult.countRemoved)
	}
}

func (b *Buffer) reflowLargerAdjustViewport(newCols, newRows, countRemoved int) {
	da := DefaultAttrData()
	nullCell := b.GetNullCell(&da)
	for range countRemoved {
		if b.YBase == 0 {
			if b.Y > 0 {
				b.Y--
			}
			if b.Lines.Length() < newRows {
				b.Lines.Push(NewBufferLine(newCols, nullCell, false))
			}
		} else {
			if b.YDisp == b.YBase {
				b.YDisp--
			}
			b.YBase--
		}
	}
	b.SavedState.Y = max(b.SavedState.Y-countRemoved, 0)
}

func (b *Buffer) reflowSmaller(newCols, newRows int) {
	da := DefaultAttrData()
	nullCell := b.GetNullCell(&da)

	toInsert := []reflowInsert{}
	countToInsert := 0

	for y := b.Lines.Length() - 1; y >= 0; y-- {
		nextLine := b.Lines.Get(y)
		if nextLine == nil || (!nextLine.IsWrapped && nextLine.GetTrimmedLength() <= newCols) {
			continue
		}

		wrappedLines := []*BufferLine{nextLine}
		for nextLine.IsWrapped && y > 0 {
			y--
			nextLine = b.Lines.Get(y)
			wrappedLines = append([]*BufferLine{nextLine}, wrappedLines...)
		}

		// Skip lines containing cursor
		absY := b.YBase + b.Y
		if absY >= y && absY < y+len(wrappedLines) {
			continue
		}

		lastLineLength := wrappedLines[len(wrappedLines)-1].GetTrimmedLength()
		destLineLengths := reflowSmallerGetNewLineLengths(wrappedLines, b.cols, newCols)
		linesToAdd := len(destLineLengths) - len(wrappedLines)

		var trimmedLines int
		if b.YBase == 0 && b.Y != b.Lines.Length()-1 {
			trimmedLines = max(0, b.Y-b.Lines.MaxLength()+linesToAdd)
		} else {
			trimmedLines = max(0, b.Lines.Length()-b.Lines.MaxLength()+linesToAdd)
		}

		newLines := make([]*BufferLine, linesToAdd)
		for i := range newLines {
			newLines[i] = b.GetBlankLine(&da, true)
		}
		if len(newLines) > 0 {
			toInsert = append(toInsert, reflowInsert{
				start:    y + len(wrappedLines) + countToInsert,
				newLines: newLines,
			})
			countToInsert += len(newLines)
		}
		wrappedLines = append(wrappedLines, newLines...)

		// Copy buffer data backwards
		destLineIndex := len(destLineLengths) - 1
		destCol := destLineLengths[destLineIndex]
		if destCol == 0 {
			destLineIndex--
			destCol = destLineLengths[destLineIndex]
		}
		srcLineIndex := len(wrappedLines) - linesToAdd - 1
		srcCol := lastLineLength

		for srcLineIndex >= 0 {
			cellsToCopy := min(srcCol, destCol)
			if destLineIndex < 0 || destLineIndex >= len(wrappedLines) {
				break
			}
			wrappedLines[destLineIndex].CopyCellsFrom(wrappedLines[srcLineIndex], srcCol-cellsToCopy, destCol-cellsToCopy, cellsToCopy, true)
			destCol -= cellsToCopy
			if destCol == 0 {
				destLineIndex--
				if destLineIndex >= 0 {
					destCol = destLineLengths[destLineIndex]
				}
			}
			srcCol -= cellsToCopy
			if srcCol == 0 {
				srcLineIndex--
				wrappedLinesIndex := max(srcLineIndex, 0)
				srcCol = getWrappedLineTrimmedLength(wrappedLines, wrappedLinesIndex, b.cols)
			}
		}

		// Null out ends of lines where wide chars may have wrapped
		for i := range wrappedLines {
			if i < len(destLineLengths) && destLineLengths[i] < newCols {
				wrappedLines[i].SetCell(destLineLengths[i], nullCell)
			}
		}

		// Adjust viewport
		viewportAdjustments := linesToAdd - trimmedLines
		for viewportAdjustments > 0 {
			viewportAdjustments--
			if b.YBase == 0 {
				if b.Y < newRows-1 {
					b.Y++
					b.Lines.Pop()
				} else {
					b.YBase++
					b.YDisp++
				}
			} else {
				if b.YBase < min(b.Lines.MaxLength(), b.Lines.Length()+countToInsert)-newRows {
					if b.YBase == b.YDisp {
						b.YDisp++
					}
					b.YBase++
				}
			}
		}
		b.SavedState.Y = min(b.SavedState.Y+linesToAdd, b.YBase+newRows-1)
	}

	// Rearrange lines
	if len(toInsert) > 0 {
		insertEvents := []InsertEvent{}
		originalLines := make([]*BufferLine, b.Lines.Length())
		for i := range b.Lines.Length() {
			originalLines[i] = b.Lines.Get(i)
		}
		originalLinesLength := b.Lines.Length()

		originalLineIndex := originalLinesLength - 1
		nextToInsertIndex := 0
		nextToInsert := toInsert[nextToInsertIndex]
		newLen := min(b.Lines.MaxLength(), b.Lines.Length()+countToInsert)
		b.Lines.SetLength(newLen)

		countInsertedSoFar := 0
		for i := min(b.Lines.MaxLength()-1, originalLinesLength+countToInsert-1); i >= 0; i-- {
			if nextToInsertIndex < len(toInsert) && nextToInsert.start > originalLineIndex+countInsertedSoFar {
				for nextI := len(nextToInsert.newLines) - 1; nextI >= 0; nextI-- {
					b.Lines.Set(i, nextToInsert.newLines[nextI])
					i--
				}
				i++
				insertEvents = append(insertEvents, InsertEvent{
					Index:  originalLineIndex + 1,
					Amount: len(nextToInsert.newLines),
				})
				countInsertedSoFar += len(nextToInsert.newLines)
				nextToInsertIndex++
				if nextToInsertIndex < len(toInsert) {
					nextToInsert = toInsert[nextToInsertIndex]
				}
			} else if originalLineIndex >= 0 {
				b.Lines.Set(i, originalLines[originalLineIndex])
				originalLineIndex--
			}
		}

		// Fire insert events in reverse
		insertCountEmitted := 0
		for i := len(insertEvents) - 1; i >= 0; i-- {
			insertEvents[i].Index += insertCountEmitted
			b.Lines.OnInsertEmitter.Fire(insertEvents[i])
			insertCountEmitted += insertEvents[i].Amount
		}
		amountToTrim := max(0, originalLinesLength+countToInsert-b.Lines.MaxLength())
		if amountToTrim > 0 {
			b.Lines.OnTrimEmitter.Fire(amountToTrim)
		}
	}
}

type reflowInsert struct {
	start    int
	newLines []*BufferLine
}

// TranslateBufferLineToString converts a buffer line to a string.
func (b *Buffer) TranslateBufferLineToString(lineIndex int, trimRight bool, startCol, endCol int) string {
	if lineIndex < 0 || lineIndex >= b.Lines.Length() {
		return ""
	}
	line := b.Lines.Get(lineIndex)
	if line == nil {
		return ""
	}
	return line.TranslateToString(trimRight, startCol, endCol)
}

// GetWrappedRangeForLine returns the first and last line indices of the wrapped line group.
func (b *Buffer) GetWrappedRangeForLine(y int) (first, last int) {
	first = y
	last = y
	for first > 0 && b.Lines.Get(first).IsWrapped {
		first--
	}
	for last+1 < b.Lines.Length() && b.Lines.Get(last+1).IsWrapped {
		last++
	}
	return first, last
}

// SetupTabStops initializes tab stops. If startCol >= 0, extends from that position;
// otherwise resets all tab stops.
func (b *Buffer) SetupTabStops(startCol int) {
	if startCol >= 0 {
		if !b.Tabs[startCol] {
			startCol = b.PrevStop(startCol)
		}
	} else {
		b.Tabs = make(map[int]bool)
		startCol = 0
	}
	for i := startCol; i < b.cols; i += b.tabStopWidth {
		b.Tabs[i] = true
	}
}

// PrevStop returns the previous tab stop position before x.
func (b *Buffer) PrevStop(x int) int {
	x--
	for x > 0 && !b.Tabs[x] {
		x--
	}
	if x >= b.cols {
		return b.cols - 1
	}
	if x < 0 {
		return 0
	}
	return x
}

// NextStop returns the next tab stop position after x.
func (b *Buffer) NextStop(x int) int {
	x++
	for x < b.cols && !b.Tabs[x] {
		x++
	}
	if x >= b.cols {
		return b.cols - 1
	}
	if x < 0 {
		return 0
	}
	return x
}

// ClearMarkers disposes and removes all markers on the given line.
func (b *Buffer) ClearMarkers(y int) {
	b.isClearing = true
	for i := 0; i < len(b.Markers); i++ {
		if b.Markers[i].Line == y {
			b.Markers[i].Dispose()
			b.Markers = append(b.Markers[:i], b.Markers[i+1:]...)
			i--
		}
	}
	b.isClearing = false
}

// ClearAllMarkers disposes and removes all markers.
func (b *Buffer) ClearAllMarkers() {
	b.isClearing = true
	for _, m := range b.Markers {
		m.Dispose()
	}
	b.Markers = nil
	b.isClearing = false
}

// Dispose cleans up the buffer by disposing all markers and their event listeners.
func (b *Buffer) Dispose() {
	b.ClearAllMarkers()
}

// AddMarker creates a marker at the given line and registers it for
// automatic adjustment on trim/insert/delete events.
func (b *Buffer) AddMarker(y int) *Marker {
	marker := NewMarker(y)
	b.Markers = append(b.Markers, marker)

	marker.Register(b.Lines.OnTrimEmitter.Event(func(amount int) {
		marker.Line -= amount
		if marker.Line < 0 {
			marker.Dispose()
		}
	}))
	marker.Register(b.Lines.OnInsertEmitter.Event(func(event InsertEvent) {
		if marker.Line >= event.Index {
			marker.Line += event.Amount
		}
	}))
	marker.Register(b.Lines.OnDeleteEmitter.Event(func(event DeleteEvent) {
		if marker.Line >= event.Index && marker.Line < event.Index+event.Amount {
			marker.Dispose()
		}
		if marker.Line > event.Index {
			marker.Line -= event.Amount
		}
	}))
	marker.Register(marker.OnDispose(func(struct{}) {
		b.removeMarker(marker)
	}))
	return marker
}

func (b *Buffer) removeMarker(marker *Marker) {
	if b.isClearing {
		return
	}
	for i, m := range b.Markers {
		if m == marker {
			b.Markers = append(b.Markers[:i], b.Markers[i+1:]...)
			return
		}
	}
}

// Cols returns the current column count.
func (b *Buffer) Cols() int { return b.cols }

// Rows returns the current row count.
func (b *Buffer) Rows() int { return b.rows }
