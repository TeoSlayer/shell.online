package xterm

// Ported from xterm.js src/common/buffer/Marker.ts.

import "sync/atomic"

// markerNextID is the global auto-incrementing marker ID counter.
var markerNextID int64

// Marker represents a line position in the buffer that is tracked across
// scrollback trimming, insertions, and deletions.
type Marker struct {
	id          int64
	Line        int
	IsDisposed  bool
	disposables []Disposable

	onDisposeEmitter EventEmitter[struct{}]
}

// NewMarker creates a marker at the given line.
func NewMarker(line int) *Marker {
	return &Marker{
		id:   atomic.AddInt64(&markerNextID, 1),
		Line: line,
	}
}

// ID returns the unique marker identifier.
func (m *Marker) ID() int64 {
	return m.id
}

// OnDispose registers a listener called when the marker is disposed.
func (m *Marker) OnDispose(listener func(struct{})) Disposable {
	return m.onDisposeEmitter.Event(listener)
}

// Register adds a disposable to be cleaned up when the marker is disposed.
// Returns the disposable for chaining.
func (m *Marker) Register(d Disposable) Disposable {
	m.disposables = append(m.disposables, d)
	return d
}

// Dispose disposes the marker, firing OnDispose and cleaning up all registered disposables.
func (m *Marker) Dispose() {
	if m.IsDisposed {
		return
	}
	m.IsDisposed = true
	m.Line = -1
	// Fire before disposing registered disposables so listeners can react.
	m.onDisposeEmitter.Fire(struct{}{})
	for _, d := range m.disposables {
		d.Dispose()
	}
	m.disposables = nil
}
