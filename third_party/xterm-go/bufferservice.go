package xterm

// Ported from xterm.js src/common/services/BufferService.ts.

const (
	// MinimumCols is the minimum number of columns. Less than 2 can break wide chars.
	MinimumCols = 2
	// MinimumRows is the minimum number of rows.
	MinimumRows = 1
)

// BufferResizeEvent is fired when the terminal dimensions change.
type BufferResizeEvent struct {
	Cols        int
	Rows        int
	ColsChanged bool
	RowsChanged bool
}

// BufferService wraps a BufferSet with scroll management and resize events.
type BufferService struct {
	Cols    int
	Rows    int
	Buffers *BufferSet

	// IsUserScrolling is true when the user has scrolled up from the bottom.
	IsUserScrolling bool

	OnResizeEmitter EventEmitter[BufferResizeEvent]
	OnScrollEmitter EventEmitter[int]

	cachedBlankLine *BufferLine

	windowsPtyOptionDisposable Disposable
}

// NewBufferService creates a BufferService from the given options.
func NewBufferService(opts *OptionsService) *BufferService {
	cols := opts.Options.Cols
	if cols < MinimumCols {
		cols = MinimumCols
	}
	rows := opts.Options.Rows
	if rows < MinimumRows {
		rows = MinimumRows
	}

	bs := &BufferService{
		Cols: cols,
		Rows: rows,
	}
	bs.Buffers = newBufferSet(cols, rows, opts.Options.Scrollback, opts.Options.TabStopWidth, opts.Options.WindowsPty.hasWindowsPtyOptions())
	bs.windowsPtyOptionDisposable = opts.OnSpecificOptionChange("windowsPty", func() {
		bs.Buffers.SetWindowsPtyMode(opts.Options.WindowsPty.hasWindowsPtyOptions())
	})

	// When the active buffer changes, fire a scroll event with the new ydisp.
	bs.Buffers.OnBufferActivateEmitter.Event(func(e BufferActivateEvent) {
		bs.OnScrollEmitter.Fire(e.ActiveBuffer.YDisp)
	})

	return bs
}

// Buffer returns the currently active buffer.
func (bs *BufferService) Buffer() *Buffer {
	return bs.Buffers.Active()
}

// Resize changes the terminal dimensions and fires the resize event.
func (bs *BufferService) Resize(cols, rows int) {
	colsChanged := bs.Cols != cols
	rowsChanged := bs.Rows != rows
	bs.Cols = cols
	bs.Rows = rows
	bs.Buffers.Resize(cols, rows)
	bs.OnResizeEmitter.Fire(BufferResizeEvent{
		Cols:        cols,
		Rows:        rows,
		ColsChanged: colsChanged,
		RowsChanged: rowsChanged,
	})
}

// Reset recreates both buffers and resets scroll state.
func (bs *BufferService) Reset() {
	bs.Buffers.Reset()
	bs.IsUserScrolling = false
}

// Scroll scrolls the terminal down one line, creating a blank line at the bottom
// of the scroll region.
func (bs *BufferService) Scroll(eraseAttr *AttributeData, isWrapped bool) {
	buffer := bs.Buffer()

	// Reuse cached blank line if attributes match
	newLine := bs.cachedBlankLine
	if newLine == nil || newLine.Len != bs.Cols || newLine.GetFg(0) != eraseAttr.Fg || newLine.GetBg(0) != eraseAttr.Bg {
		newLine = buffer.GetBlankLine(eraseAttr, isWrapped)
		bs.cachedBlankLine = newLine
	}
	newLine.IsWrapped = isWrapped

	topRow := buffer.YBase + buffer.ScrollTop
	bottomRow := buffer.YBase + buffer.ScrollBottom

	if buffer.ScrollTop == 0 {
		willBufferBeTrimmed := buffer.Lines.IsFull()

		if bottomRow == buffer.Lines.Length()-1 {
			if willBufferBeTrimmed {
				buffer.Lines.Recycle().CopyFrom(newLine)
			} else {
				buffer.Lines.Push(newLine.Clone())
			}
		} else {
			buffer.Lines.Splice(bottomRow+1, 0, newLine.Clone())
		}

		if !willBufferBeTrimmed {
			buffer.YBase++
			if !bs.IsUserScrolling {
				buffer.YDisp++
			}
		} else if bs.IsUserScrolling {
			buffer.YDisp = max(buffer.YDisp-1, 0)
		}
	} else {
		// Non-zero scrollTop: shift lines in-place within the scroll region.
		scrollRegionHeight := bottomRow - topRow + 1
		buffer.Lines.ShiftElements(topRow+1, scrollRegionHeight-1, -1)
		buffer.Lines.Set(bottomRow, newLine.Clone())
	}

	if !bs.IsUserScrolling {
		buffer.YDisp = buffer.YBase
	}

	bs.OnScrollEmitter.Fire(buffer.YDisp)
}

// ScrollLines scrolls the viewport by disp lines (negative = up, positive = down).
func (bs *BufferService) ScrollLines(disp int, suppressScrollEvent bool) {
	buffer := bs.Buffer()

	if disp < 0 {
		if buffer.YDisp == 0 {
			return
		}
		bs.IsUserScrolling = true
	} else if disp+buffer.YDisp >= buffer.YBase {
		bs.IsUserScrolling = false
	}

	oldYdisp := buffer.YDisp
	buffer.YDisp = max(min(buffer.YDisp+disp, buffer.YBase), 0)

	if oldYdisp == buffer.YDisp {
		return
	}

	if !suppressScrollEvent {
		bs.OnScrollEmitter.Fire(buffer.YDisp)
	}
}

// Dispose cleans up event emitters.
func (bs *BufferService) Dispose() {
	if bs.windowsPtyOptionDisposable != nil {
		bs.windowsPtyOptionDisposable.Dispose()
	}
	bs.OnResizeEmitter.Dispose()
	bs.OnScrollEmitter.Dispose()
	bs.Buffers.Dispose()
}
