package xterm

// Ported from xterm.js src/common/buffer/BufferSet.ts.

// BufferActivateEvent is fired when the active buffer changes.
type BufferActivateEvent struct {
	ActiveBuffer   *Buffer
	InactiveBuffer *Buffer
}

// BufferSet manages the normal and alt screen buffers.
type BufferSet struct {
	normal *Buffer
	alt    *Buffer
	active *Buffer

	cols         int
	rows         int
	scrollback   int
	tabStopWidth int
	windowsPty   bool

	OnBufferActivateEmitter EventEmitter[BufferActivateEvent]
}

// NewBufferSet creates a BufferSet with normal and alt buffers.
func NewBufferSet(cols, rows, scrollback, tabStopWidth int) *BufferSet {
	return newBufferSet(cols, rows, scrollback, tabStopWidth, false)
}

func newBufferSet(cols, rows, scrollback, tabStopWidth int, windowsPty bool) *BufferSet {
	bs := &BufferSet{
		cols:         cols,
		rows:         rows,
		scrollback:   scrollback,
		tabStopWidth: tabStopWidth,
		windowsPty:   windowsPty,
	}
	bs.Reset()
	return bs
}

// Reset recreates both buffers and activates the normal buffer.
// Old buffers are disposed to clean up markers and event listeners.
func (bs *BufferSet) Reset() {
	if bs.normal != nil {
		bs.normal.Dispose()
	}
	if bs.alt != nil {
		bs.alt.Dispose()
	}
	bs.normal = NewBuffer(BufferOptions{
		Cols:           bs.cols,
		Rows:           bs.rows,
		Scrollback:     bs.scrollback,
		TabStopWidth:   bs.tabStopWidth,
		HasScrollback:  true,
		WindowsPtyMode: bs.windowsPty,
	})
	bs.normal.FillViewportRows(nil)

	// Alt buffer never has scrollback.
	bs.alt = NewBuffer(BufferOptions{
		Cols:           bs.cols,
		Rows:           bs.rows,
		Scrollback:     0,
		TabStopWidth:   bs.tabStopWidth,
		HasScrollback:  false,
		WindowsPtyMode: bs.windowsPty,
	})

	bs.active = bs.normal
	bs.OnBufferActivateEmitter.Fire(BufferActivateEvent{
		ActiveBuffer:   bs.normal,
		InactiveBuffer: bs.alt,
	})
	bs.SetupTabStops(-1)
}

// Normal returns the normal buffer.
func (bs *BufferSet) Normal() *Buffer { return bs.normal }

// Alt returns the alt buffer.
func (bs *BufferSet) Alt() *Buffer { return bs.alt }

// Active returns the currently active buffer.
func (bs *BufferSet) Active() *Buffer { return bs.active }

// ActivateNormalBuffer switches to the normal buffer.
// Copies cursor position from alt and clears the alt buffer.
func (bs *BufferSet) ActivateNormalBuffer() {
	if bs.active == bs.normal {
		return
	}
	bs.normal.X = bs.alt.X
	bs.normal.Y = bs.alt.Y
	bs.alt.ClearAllMarkers()
	bs.alt.Clear()
	bs.active = bs.normal
	bs.OnBufferActivateEmitter.Fire(BufferActivateEvent{
		ActiveBuffer:   bs.normal,
		InactiveBuffer: bs.alt,
	})
}

// ActivateAltBuffer switches to the alt buffer.
// Fills the alt buffer viewport and copies cursor position from normal.
func (bs *BufferSet) ActivateAltBuffer(fillAttr *AttributeData) {
	if bs.active == bs.alt {
		return
	}
	bs.alt.FillViewportRows(fillAttr)
	bs.alt.X = bs.normal.X
	bs.alt.Y = bs.normal.Y
	bs.active = bs.alt
	bs.OnBufferActivateEmitter.Fire(BufferActivateEvent{
		ActiveBuffer:   bs.alt,
		InactiveBuffer: bs.normal,
	})
}

// Resize resizes both buffers.
func (bs *BufferSet) Resize(newCols, newRows int) {
	bs.cols = newCols
	bs.rows = newRows
	bs.normal.Resize(newCols, newRows)
	bs.alt.Resize(newCols, newRows)
	bs.SetupTabStops(newCols)
}

func (bs *BufferSet) SetWindowsPtyMode(windowsPty bool) {
	bs.windowsPty = windowsPty
	bs.normal.setWindowsPtyMode(windowsPty)
	bs.alt.setWindowsPtyMode(windowsPty)
}

// SetupTabStops sets up tab stops on both buffers.
func (bs *BufferSet) SetupTabStops(startCol int) {
	bs.normal.SetupTabStops(startCol)
	bs.alt.SetupTabStops(startCol)
}

// Dispose cleans up buffers and event emitters.
func (bs *BufferSet) Dispose() {
	if bs.normal != nil {
		bs.normal.Dispose()
	}
	if bs.alt != nil {
		bs.alt.Dispose()
	}
	bs.OnBufferActivateEmitter.Dispose()
}
