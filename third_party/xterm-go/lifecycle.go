package xterm

// Ported from xterm.js src/common/Lifecycle.ts.

// Disposable represents a resource that can be disposed to free associated resources.
type Disposable interface {
	Dispose()
}

// disposableFunc wraps a function as a Disposable.
type disposableFunc struct {
	fn func()
}

func (d *disposableFunc) Dispose() {
	if d.fn != nil {
		d.fn()
		d.fn = nil
	}
}

// toDisposable creates a Disposable from a cleanup function.
func toDisposable(fn func()) Disposable {
	return &disposableFunc{fn: fn}
}

// nopDisposable is a Disposable that does nothing.
var nopDisposable Disposable = &disposableFunc{}

// CombinedDisposable creates a Disposable that disposes all given disposables.
func CombinedDisposable(disposables ...Disposable) Disposable {
	return toDisposable(func() {
		for _, d := range disposables {
			d.Dispose()
		}
	})
}

// DisposableStore collects disposables and disposes them all at once.
type DisposableStore struct {
	disposables []Disposable
	isDisposed  bool
}

// Add registers a disposable. If the store is already disposed, the disposable
// is disposed immediately.
func (s *DisposableStore) Add(d Disposable) {
	if s.isDisposed {
		d.Dispose()
		return
	}
	s.disposables = append(s.disposables, d)
}

// Dispose disposes all registered disposables and marks the store as disposed.
func (s *DisposableStore) Dispose() {
	if s.isDisposed {
		return
	}
	s.isDisposed = true
	for _, d := range s.disposables {
		d.Dispose()
	}
	s.disposables = nil
}

// Clear disposes all registered disposables but keeps the store usable.
func (s *DisposableStore) Clear() {
	for _, d := range s.disposables {
		d.Dispose()
	}
	s.disposables = nil
}

// IsDisposed returns whether the store has been disposed.
func (s *DisposableStore) IsDisposed() bool {
	return s.isDisposed
}

// MutableDisposable holds a single disposable value that can be replaced.
// Setting a new value disposes the previous one.
type MutableDisposable struct {
	value      Disposable
	isDisposed bool
}

// Value returns the current disposable, or nil if disposed.
func (m *MutableDisposable) Value() Disposable {
	if m.isDisposed {
		return nil
	}
	return m.value
}

// SetValue replaces the current disposable, disposing the old one.
func (m *MutableDisposable) SetValue(d Disposable) {
	if m.isDisposed || d == m.value {
		return
	}
	if m.value != nil {
		m.value.Dispose()
	}
	m.value = d
}

// Clear disposes and removes the current value.
func (m *MutableDisposable) Clear() {
	m.SetValue(nil)
}

// Dispose disposes the current value and marks the holder as disposed.
func (m *MutableDisposable) Dispose() {
	m.isDisposed = true
	if m.value != nil {
		m.value.Dispose()
		m.value = nil
	}
}
