package xterm

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func newTestOscLinkService() (*OscLinkService, *BufferService) {
	opts := NewOptionsService(&TerminalOptions{
		Cols:       80,
		Rows:       24,
		Scrollback: 1000,
	})
	bs := NewBufferService(opts)
	return NewOscLinkService(bs), bs
}

func TestOscLinkServiceRegisterLinkNoID(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		LinkID     int
		URI        string
		HasData    bool
		PositiveID bool
	}

	svc, _ := newTestOscLinkService()
	id := svc.RegisterLink(OscLinkData{URI: "https://example.com"})
	data := svc.GetLinkData(id)

	got := Expectation{
		LinkID:     id,
		URI:        data.URI,
		HasData:    data != nil,
		PositiveID: id > 0,
	}
	expected := Expectation{
		LinkID:     1,
		URI:        "https://example.com",
		HasData:    true,
		PositiveID: true,
	}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceRegisterLinkWithID(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		LinkID int
		URI    string
		DataID string
	}

	svc, _ := newTestOscLinkService()
	id := svc.RegisterLink(OscLinkData{URI: "https://example.com", ID: "mylink"})
	data := svc.GetLinkData(id)

	got := Expectation{LinkID: id, URI: data.URI, DataID: data.ID}
	expected := Expectation{LinkID: 1, URI: "https://example.com", DataID: "mylink"}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceRegisterLinkWithIDReuse(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ID1    int
		ID2    int
		SameID bool
	}

	svc, bs := newTestOscLinkService()
	id1 := svc.RegisterLink(OscLinkData{URI: "https://example.com", ID: "mylink"})
	// Move cursor to next line
	bs.Buffer().Y++
	id2 := svc.RegisterLink(OscLinkData{URI: "https://example.com", ID: "mylink"})

	got := Expectation{ID1: id1, ID2: id2, SameID: id1 == id2}
	expected := Expectation{ID1: 1, ID2: 1, SameID: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceRegisterLinkDifferentIDs(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ID1       int
		ID2       int
		Different bool
	}

	svc, _ := newTestOscLinkService()
	id1 := svc.RegisterLink(OscLinkData{URI: "https://example.com", ID: "link1"})
	id2 := svc.RegisterLink(OscLinkData{URI: "https://example.com", ID: "link2"})

	got := Expectation{ID1: id1, ID2: id2, Different: id1 != id2}
	expected := Expectation{ID1: 1, ID2: 2, Different: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceMultipleNoIDLinks(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		ID1       int
		ID2       int
		Different bool
	}

	svc, _ := newTestOscLinkService()
	id1 := svc.RegisterLink(OscLinkData{URI: "https://a.com"})
	id2 := svc.RegisterLink(OscLinkData{URI: "https://b.com"})

	got := Expectation{ID1: id1, ID2: id2, Different: id1 != id2}
	expected := Expectation{ID1: 1, ID2: 2, Different: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceGetLinkDataNotFound(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		Data *OscLinkData
	}

	svc, _ := newTestOscLinkService()
	got := Expectation{Data: svc.GetLinkData(999)}
	expected := Expectation{Data: nil}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceAddLineToLink(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		LinkID  int
		HasData bool
	}

	svc, bs := newTestOscLinkService()
	id := svc.RegisterLink(OscLinkData{URI: "https://example.com"})
	// Add another line reference
	svc.AddLineToLink(id, bs.Buffer().YBase+bs.Buffer().Y+1)

	entry := svc.dataByLinkID[id]
	got := Expectation{
		LinkID:  id,
		HasData: entry != nil,
	}
	expected := Expectation{LinkID: 1, HasData: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}

	// Verify 2 markers
	type Expectation2 struct {
		MarkerCount int
	}
	got2 := Expectation2{MarkerCount: len(entry.lines)}
	expected2 := Expectation2{MarkerCount: 2}
	if diff := cmp.Diff(expected2, got2); diff != "" {
		t.Errorf("marker count (-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceAddLineToLinkNoDuplicate(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		MarkerCount int
	}

	svc, bs := newTestOscLinkService()
	id := svc.RegisterLink(OscLinkData{URI: "https://example.com"})
	y := bs.Buffer().YBase + bs.Buffer().Y
	// Try to add the same line again
	svc.AddLineToLink(id, y)

	entry := svc.dataByLinkID[id]
	got := Expectation{MarkerCount: len(entry.lines)}
	expected := Expectation{MarkerCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceAddLineToLinkInvalidID(t *testing.T) {
	t.Parallel()

	// Should not panic
	svc, _ := newTestOscLinkService()
	svc.AddLineToLink(999, 0)
}

func TestOscLinkServiceCleanupOnMarkerDispose(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		DataExists bool
	}

	svc, bs := newTestOscLinkService()
	id := svc.RegisterLink(OscLinkData{URI: "https://example.com"})

	// Dispose the marker (simulates scrollback trimming)
	entry := svc.dataByLinkID[id]
	marker := entry.lines[0]

	// Verify the buffer has the marker
	found := false
	for _, m := range bs.Buffer().Markers {
		if m == marker {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("marker not found in buffer")
	}

	marker.Dispose()

	got := Expectation{DataExists: svc.GetLinkData(id) != nil}
	expected := Expectation{DataExists: false}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServiceCleanupWithIDOnMarkerDispose(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		DataExists    bool
		EntryMapEmpty bool
	}

	svc, _ := newTestOscLinkService()
	id := svc.RegisterLink(OscLinkData{URI: "https://example.com", ID: "mylink"})

	entry := svc.dataByLinkID[id]
	entry.lines[0].Dispose()

	got := Expectation{
		DataExists:    svc.GetLinkData(id) != nil,
		EntryMapEmpty: len(svc.entriesWithID) == 0,
	}
	expected := Expectation{DataExists: false, EntryMapEmpty: true}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}

func TestOscLinkServicePartialCleanup(t *testing.T) {
	t.Parallel()

	type Expectation struct {
		DataExists  bool
		MarkerCount int
	}

	svc, bs := newTestOscLinkService()
	id := svc.RegisterLink(OscLinkData{URI: "https://example.com"})
	svc.AddLineToLink(id, bs.Buffer().YBase+bs.Buffer().Y+1)

	entry := svc.dataByLinkID[id]
	// Dispose only the first marker
	entry.lines[0].Dispose()

	// Entry should still exist with 1 marker
	got := Expectation{
		DataExists:  svc.GetLinkData(id) != nil,
		MarkerCount: len(svc.dataByLinkID[id].lines),
	}
	expected := Expectation{DataExists: true, MarkerCount: 1}
	if diff := cmp.Diff(expected, got); diff != "" {
		t.Errorf("(-want +got):\n%s", diff)
	}
}
