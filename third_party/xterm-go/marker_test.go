package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestMarkerNew(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Line       int
		IsDisposed bool
		HasID      bool
	}
	m := NewMarker(5)
	got := Expectation{
		Line:       m.Line,
		IsDisposed: m.IsDisposed,
		HasID:      m.ID() > 0,
	}
	expected := Expectation{Line: 5, IsDisposed: false, HasID: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMarkerUniqueIDs(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Different bool
	}
	m1 := NewMarker(0)
	m2 := NewMarker(0)
	got := Expectation{Different: m1.ID() != m2.ID()}
	expected := Expectation{Different: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMarkerDispose(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		IsDisposed bool
		Line       int
	}
	m := NewMarker(10)
	m.Dispose()
	got := Expectation{IsDisposed: m.IsDisposed, Line: m.Line}
	expected := Expectation{IsDisposed: true, Line: -1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMarkerDisposeIdempotent(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		FireCount int
	}
	m := NewMarker(10)
	fireCount := 0
	m.OnDispose(func(struct{}) { fireCount++ })
	m.Dispose()
	m.Dispose() // second call should be no-op
	got := Expectation{FireCount: fireCount}
	expected := Expectation{FireCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMarkerOnDispose(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Called bool
	}
	m := NewMarker(3)
	called := false
	m.OnDispose(func(struct{}) { called = true })
	m.Dispose()
	got := Expectation{Called: called}
	expected := Expectation{Called: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestMarkerRegister(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Disposed bool
	}
	m := NewMarker(0)
	disposed := false
	m.Register(toDisposable(func() { disposed = true }))
	m.Dispose()
	got := Expectation{Disposed: disposed}
	expected := Expectation{Disposed: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
