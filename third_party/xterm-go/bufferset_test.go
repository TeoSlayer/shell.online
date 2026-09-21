package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestBufferSetNew(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ActiveIsNormal bool
		NormalNotNil   bool
		AltNotNil      bool
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	got := Expectation{
		ActiveIsNormal: bs.Active() == bs.Normal(),
		NormalNotNil:   bs.Normal() != nil,
		AltNotNil:      bs.Alt() != nil,
	}
	expected := Expectation{ActiveIsNormal: true, NormalNotNil: true, AltNotNil: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetActivateAltBuffer(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ActiveIsAlt bool
		AltX        int
		AltY        int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	bs.Normal().X = 5
	bs.Normal().Y = 10
	bs.ActivateAltBuffer(nil)
	got := Expectation{
		ActiveIsAlt: bs.Active() == bs.Alt(),
		AltX:        bs.Alt().X,
		AltY:        bs.Alt().Y,
	}
	expected := Expectation{ActiveIsAlt: true, AltX: 5, AltY: 10}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetActivateNormalBuffer(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ActiveIsNormal bool
		NormalX        int
		NormalY        int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	bs.ActivateAltBuffer(nil)
	bs.Alt().X = 7
	bs.Alt().Y = 3
	bs.ActivateNormalBuffer()
	got := Expectation{
		ActiveIsNormal: bs.Active() == bs.Normal(),
		NormalX:        bs.Normal().X,
		NormalY:        bs.Normal().Y,
	}
	expected := Expectation{ActiveIsNormal: true, NormalX: 7, NormalY: 3}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetActivateNormalIdempotent(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		FireCount int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	fireCount := 0
	bs.OnBufferActivateEmitter.Event(func(BufferActivateEvent) { fireCount++ })
	// Already on normal, should not fire
	bs.ActivateNormalBuffer()
	got := Expectation{FireCount: fireCount}
	expected := Expectation{FireCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetActivateAltIdempotent(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		FireCount int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	fireCount := 0
	bs.ActivateAltBuffer(nil)
	bs.OnBufferActivateEmitter.Event(func(BufferActivateEvent) { fireCount++ })
	// Already on alt, should not fire
	bs.ActivateAltBuffer(nil)
	got := Expectation{FireCount: fireCount}
	expected := Expectation{FireCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetOnBufferActivate(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		Events int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	events := 0
	bs.OnBufferActivateEmitter.Event(func(BufferActivateEvent) { events++ })
	bs.ActivateAltBuffer(nil)
	bs.ActivateNormalBuffer()
	got := Expectation{Events: events}
	expected := Expectation{Events: 2}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetReset(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		ActiveIsNormal bool
		NormalLines    int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	bs.ActivateAltBuffer(nil)
	bs.Reset()
	got := Expectation{
		ActiveIsNormal: bs.Active() == bs.Normal(),
		NormalLines:    bs.Normal().Lines.Length(),
	}
	expected := Expectation{ActiveIsNormal: true, NormalLines: 24}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetResetDisposesOldMarkers(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		NormalMarkerDisposed bool
		AltMarkerDisposed    bool
		NewNormalMarkerCount int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	normalMarker := bs.Normal().AddMarker(0)
	bs.ActivateAltBuffer(nil)
	altMarker := bs.Alt().AddMarker(0)
	bs.Reset()
	got := Expectation{
		NormalMarkerDisposed: normalMarker.IsDisposed,
		AltMarkerDisposed:    altMarker.IsDisposed,
		NewNormalMarkerCount: len(bs.Normal().Markers),
	}
	expected := Expectation{
		NormalMarkerDisposed: true,
		AltMarkerDisposed:    true,
		NewNormalMarkerCount: 0,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetDisposeDisposesBufferMarkers(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		MarkerDisposed bool
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	marker := bs.Normal().AddMarker(0)
	bs.Dispose()
	got := Expectation{MarkerDisposed: marker.IsDisposed}
	expected := Expectation{MarkerDisposed: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetResize(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		NormalCols int
		AltCols    int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	bs.Resize(120, 30)
	got := Expectation{
		NormalCols: bs.Normal().Cols(),
		AltCols:    bs.Alt().Cols(),
	}
	expected := Expectation{NormalCols: 120, AltCols: 120}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetAltNoScrollback(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		HasScrollback bool
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	bs.ActivateAltBuffer(nil)
	got := Expectation{HasScrollback: bs.Alt().HasScrollback()}
	expected := Expectation{HasScrollback: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestBufferSetDispose(t *testing.T) {
	t.Parallel()
	type Expectation struct {
		FireCount int
	}
	bs := NewBufferSet(80, 24, 1000, 8)
	fireCount := 0
	bs.OnBufferActivateEmitter.Event(func(BufferActivateEvent) { fireCount++ })
	bs.Dispose()
	bs.ActivateAltBuffer(nil) // should not fire after dispose
	got := Expectation{FireCount: fireCount}
	expected := Expectation{FireCount: 0}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
